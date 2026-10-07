/** Syntax + resolution check for the plugin's client source. */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const vendoredThree = {
  name: 'vendoredThree',
  setup(build) {
    build.onResolve({ filter: /^three\/(addons|examples\/jsm)\// }, (args) => {
      const rel = args.path.replace(/^three\/addons\//, '').replace(/^three\/examples\/jsm\//, '')
      for (const candidate of [join(root, 'vendor/three/examples/jsm', rel)]) {
        if (existsSync(candidate)) return { path: candidate }
      }
      return { errors: [{ text: `missing vendored addon ${rel}` }] }
    })
  },
}
for (const entry of [
  'src/client/scene.ts',
  'src/client/gizmo.ts',
  'src/client/viewer.tsx',
  // The parsing worker is its own bundle with its own (module-table-free) entry;
  // a broken import there would only surface as a dead worker at runtime.
  'src/client/occt-worker.ts',
]) {
  try {
    await build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser',
      write: false, logLevel: 'silent',
      external: ['three', 'react', 'react-dom', '@deepseek-ai/dsh-client-*'],
      // The real build substitutes this placeholder; alias it so the check covers
      // the viewer too instead of stopping at an unresolved specifier.
      alias: { __OCCT_FACTORY_MODULE__: join(root, 'src/client/occt-glue.ts') },
      plugins: [vendoredThree],
    })
    console.log(`${entry} 解析与语法 OK`)
  } catch (error) {
    const first = error.errors?.[0]
    console.log(`${entry} 失败: ${first?.text ?? error.message} @ ${first?.location?.file}:${first?.location?.line}`)
  }
}
