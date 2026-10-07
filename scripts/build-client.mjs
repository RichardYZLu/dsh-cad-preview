/**
 * Build both halves of the browser-side module.
 *
 * 1. `lib/client.js` — the artifact DSH loads into the page. One classic
 *    script in the client-module envelope. `react` stays external because the
 *    shell's module table owns the only React instance on the page; three.js is
 *    inlined from `vendor/`, so the bundle is the only module the loader has to
 *    resolve. The OpenCascade kernel is *not* here: its loader placeholder
 *    resolves to a module that refuses (src/client/occt-main-thread.ts).
 * 2. `lib/client.worker.js` — the OpenCascade parsing worker, served by the
 *    plugin's own route (`/cad-preview/worker.js`). It is a plain classic
 *    script, not a module-envelope bundle: a worker has no
 *    `window.__ModuleLoader__`, so everything it needs (the glue included) is
 *    inlined and it imports nothing. B-rep tessellation runs here so a heavy
 *    file can never block the page's main thread.
 * 3. `lib/client.node.mjs` — the same viewer source for the headless parser
 *    test, as a real ES module with `three` left external and the wasm read
 *    from `test/fixtures`.
 *
 * Both come from the same sources, so the test cannot drift from what the
 * sidebar actually runs.
 *
 * Note on `vendor/three`: the loaders are vendored (rather than imported from
 * the package) because esbuild's resolver cannot resolve the bare specifier
 * `three/examples/jsm/loaders/ThreeMFLoader.js` in this checkout, and because
 * it lives on an external SSD where a freshly written *digit-prefixed* file
 * (the upstream name is `3MFLoader.js`) stats as ENOENT for a while. The file
 * is therefore stored as `ThreeMFLoader.js` and must never be renamed back.
 */
import { build as esbuild } from 'esbuild'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })

/**
 * esbuild, retried.
 *
 * The workspace lives on an external SSD where a just-written file can briefly
 * stat as ENOENT (`ls` and Python see it, Node does not), which surfaces as a
 * phantom "Could not resolve" for a file that is plainly there. Retrying the
 * build absorbs that without hiding a real resolution error: the last attempt's
 * error is what gets reported.
 *
 * @param options - esbuild options.
 * @returns the build result.
 */
async function build(options) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await esbuild(options)
      if (attempt > 1) console.log(`[build-client] succeeded on attempt ${attempt}`)
      return result
    } catch (error) {
      lastError = error
      const transient = /Could not resolve/.test(String(error?.message ?? ''))
      if (!transient || attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
    }
  }
  throw lastError
}

const shared = {
  bundle: true,
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  logLevel: 'warning',
  metafile: true,
}

const report = (label, result, outfile) => {
  const size = statSync(outfile).size
  const outputs = result.metafile.outputs
  const first =
    outputs[outfile] ??
    outputs[Object.keys(outputs).find((key) => key.endsWith(outfile.split('/').pop())) ?? ''] ??
    outputs[Object.keys(outputs)[0]]
  const inputs = Object.entries(first?.inputs ?? {})
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 8)
  console.log(`[build-client] ${label} ${(size / 1024).toFixed(1)} KB`)
  for (const [input, meta] of inputs) {
    const shown = input.includes('vendor/') ? `vendor/${input.split('vendor/')[1]}` : input
    console.log(`  ${(meta.bytesInOutput / 1024).toFixed(1).padStart(8)} KB  ${shown}`)
  }
}

// ── 1. the OpenCascade glue as a package-local chunk ────────────────────────
// Classic-script format so that evaluating it with an inline `require` shim
// yields the emscripten factory (see src/client/occt-glue.ts). DSH fetches
// this as `<id>/client.occt.js`, next to the bundle it belongs to.
const glueChunk = join(outDir, 'client.occt.js')
await build({
  ...shared,
  entryPoints: [join(root, 'node_modules', 'occt-import-js', 'dist', 'occt-import-js.js')],
  outfile: glueChunk,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'safari17'],
  // The glue's Node branches never run in a browser; an inline `require` shim
  // satisfies them at evaluation time.
  external: ['fs', 'path'],
})
console.log(
  `[build-client] lib/client.occt.js ${(statSync(glueChunk).size / 1024).toFixed(1)} KB`,
)

// ── 2. the page bundle (no kernel: that lives in the worker below) ──────────
/**
 * Resolve the bare `three` specifiers to the vendored copies.
 *
 * The sources import `three` / `three/examples/jsm/**`, which is also what the
 * Node test build resolves from node_modules. Only the browser build is
 * redirected, so both halves keep one import spelling.
 */
/**
 * Bind the viewer's kernel-loader import to one variant.
 *
 * The viewer writes `import loadOcctFactory from '__OCCT_FACTORY_MODULE__'`
 * because the browser needs the inlined-glue evaluator while the headless test
 * needs the package-backed one; a resolver per build keeps a single import
 * line in the source.
 *
 * @param target - absolute path of the module to substitute.
 */
function factoryModule(target) {
  return {
    name: 'dsh-cad-preview:occt-factory',
    setup(build) {
      build.onResolve({ filter: /^__OCCT_FACTORY_MODULE__$/ }, () => ({ path: target }))
    },
  }
}

const vendoredThree = {
  name: 'dsh-cad-preview:vendored-three',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({
      path: join(root, 'vendor', 'three', 'build', 'three.module.js'),
    }))
    build.onResolve({ filter: /^three\/examples\/jsm\// }, (args) => ({
      path: join(root, 'vendor', 'three', 'examples', 'jsm', args.path.slice('three/examples/jsm/'.length)),
    }))
  },
}


const placeholder = '__DSH_CAD_PREVIEW_OCCT_GLUE__'
/**
 * Inline the glue text wherever `occt-glue.ts` is part of the graph.
 *
 * Only the worker and the headless build pull that module in: the page bundle
 * resolves its kernel loader to `occt-main-thread.ts`, which needs no glue, and
 * so does not pay its 163 KB.
 */
const inlineGlue = {
  name: 'dsh-cad-preview:inline-occt-glue',
  setup(build) {
    build.onLoad({ filter: /occt-glue\.ts$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      if (!source.includes(placeholder)) {
        throw new Error(`${args.path}: missing ${placeholder} placeholder`)
      }
      const glue = readFileSync(glueChunk, 'utf8')
      return {
        contents: source.replace(`'${placeholder}'`, JSON.stringify(glue)),
        loader: 'ts',
      }
    })
  },
}

const banner = `(function () {
  var __dshRequire = (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.require === "function")
    ? window.__ModuleLoader__.require
    : (typeof require === "function" ? require : function (id) { throw new Error("dsh-cad-preview: no module table for " + id); });
  window.__ModuleLoader__.load({
    id: "dsh-cad-preview",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `
      return module.exports;
    }
  });
})();
`

const browser = await build({
  ...shared,
  entryPoints: [join(root, 'src', 'client', 'viewer.tsx')],
  outfile: join(outDir, 'client.js'),
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'safari17'],
  // External at runtime: React comes from the shell's frozen module table.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  banner: { js: banner },
  footer: { js: footer },
  // No `inlineGlue` here: the page half must not carry the kernel at all. Its
  // placeholder resolves to a module that refuses (see
  // src/client/occt-main-thread.ts), so the only code able to run the kernel is
  // the worker bundle below — off the main thread by construction.
  plugins: [vendoredThree, factoryModule(join(root, 'src', 'client', 'occt-main-thread.ts'))],
})
report('lib/client.js', browser, join(outDir, 'client.js'))

// ── 3. the parsing worker ───────────────────────────────────────────────────
// A classic script, deliberately outside the module envelope: inside a worker
// there is no `window.__ModuleLoader__` to require React, three.js or the glue
// from, so the worker carries the glue text and nothing else. `/cad-preview/
// worker.js` serves this file (see lib/index.js).
const worker = await build({
  ...shared,
  entryPoints: [join(root, 'src', 'client', 'occt-worker.ts')],
  outfile: join(outDir, 'client.worker.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'safari17'],
  plugins: [inlineGlue, factoryModule(join(root, 'src', 'client', 'occt-glue.ts'))],
})
report('lib/client.worker.js', worker, join(outDir, 'client.worker.js'))

// ── 4. the headless entry for the parser test ───────────────────────────────
/**
 * Point the vendored loader name back at the package's own spelling.
 *
 * Upstream ships `3MFLoader.js`; the vendored copy is `ThreeMFLoader.js` (see
 * the note at the top of this file), so the Node build — which resolves three
 * from node_modules — has to translate the specifier back.
 */
const nodeThreeNames = {
  name: 'dsh-cad-preview:node-three-names',
  setup(build) {
    build.onResolve({ filter: /^three\/examples\/jsm\/loaders\/ThreeMFLoader\.js$/ }, () => ({
      path: 'three/examples/jsm/loaders/3MFLoader.js',
      external: true,
    }))
  },
}


const node = await build({
  ...shared,
  entryPoints: [join(root, 'src', 'client', 'node-entry.ts')],
  outfile: join(outDir, 'client.node.mjs'),
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  external: ['three', 'occt-import-js', 'react', 'react/jsx-runtime', 'node:*'],
  plugins: [nodeThreeNames, inlineGlue, factoryModule(join(root, 'src', 'client', 'occt-node-glue.ts'))],
})
report('lib/client.node.mjs', node, join(outDir, 'client.node.mjs'))

writeFileSync(
  join(outDir, 'build-manifest.json'),
  `${JSON.stringify(
    { entry: 'client.js', chunks: ['client.occt.js'], workers: ['client.worker.js'] },
    null,
    2,
  )}\n`,
)

for (const asset of ['occt-import-js.wasm', 'client.js', 'client.occt.js', 'client.worker.js']) {
  if (statSync(join(outDir, asset), { throwIfNoEntry: false }) === undefined) {
    console.warn(`[build-client] lib/${asset} is missing — check the build inputs`)
  }
}
