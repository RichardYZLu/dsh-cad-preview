/**
 * The OpenCascade import kernel, loaded at runtime.
 *
 * occt-import-js is a 96 KB emscripten *classic* script that ends in the UMD
 * tail `if (typeof exports === "object" && …) module.exports = occtimportjs`,
 * so it cannot be an ES module and cannot be an external either: DSH's module
 * table only serves `require()`s the boot graph already materialized, and a raw
 * `require('occt-import-js')` in this bundle would throw "missed the module
 * table".
 *
 * The build therefore emits the glue as the package-local chunk
 * `client.occt.js` (fetchable next to this bundle) and inlines that chunk's
 * text below. Two things make the runtime side work:
 *
 *   1. Bundle output is a lazy CommonJS initializer that builds its *own*
 *      `module` object, so nothing the caller passes in is visible to the glue.
 *      The factory is therefore captured by injecting one hook line into the
 *      tail that hands it over (see {@link captureFactory}).
 *   2. The glue reads its options from the argument it is called with
 *      (`moduleArg`, i.e. `module.exports` before the tail replaced it), so the
 *      captured factory is invoked as `factory({ wasmBinary })`.
 *
 * Every `require`/`fs`/`path` reference in the glue sits in its
 * `ENVIRONMENT_IS_NODE` branches, which are dead in a browser; the inline shim
 * only has to keep them from throwing while the script evaluates.
 */

// __DSH_CAD_PREVIEW_OCCT_GLUE__ is replaced at build time with the chunk text.
export const GLUE_SOURCE = '__DSH_CAD_PREVIEW_OCCT_GLUE__'

/**
 * Inject a hook that hands the glue's factory to `__dshCapture`.
 *
 * The upstream tail is kept intact: only one statement is appended inside the
 * same branch that would have exported it.
 *
 * @param source - the glue chunk text.
 * @returns the patched text, or the input when no known tail was found.
 */
function captureFactory(source) {
  if (source.includes('__dshCapture')) return source
  const hook = (name) => `\n        if (typeof __dshCapture === "function") __dshCapture(${name});`
  const patterns = [
    {
      re: /(if \(typeof exports === "object" && typeof module === "object"\)\s*\n\s*module\.exports = ([A-Za-z_$][\w$]*);)/,
      wrap: (match, statement, name) => `${statement}${hook(name)}`,
    },
    {
      // Fallback for a differently-minified tail: capture whatever the module
      // assigns just before the script closes.
      re: /(module\.exports = ([A-Za-z_$][\w$]*);)([\s\S]*?\n\s*require_[A-Za-z_$][\w$]*\(\);)/,
      wrap: (match, statement, name, rest) => `${statement}${hook(name)}${rest}`,
    },
  ]
  for (const { re, wrap } of patterns) {
    if (re.test(source)) return source.replace(re, wrap)
  }
  return source
}

/**
 * Evaluate glue text and return a loader for its factory.
 *
 * @param source - the emscripten classic script (as built by esbuild).
 * @param runtime - optional Node-side scope: `require` for the glue's
 * `require("fs")` / `require("path")` calls and `dirname` for the `__dirname`
 * its Node branch reads. Unreachable in a browser (they sit behind
 * `ENVIRONMENT_IS_NODE`), so the default throws; the headless build passes real
 * modules so the same glue runs under Node.
 * @returns a function taking `{ wasmBinary }` and returning the glue factory.
 */
export function makeLoader(source, runtime) {
  let glueFactory = null
  const patched = captureFactory(source)
  if (patched === source) {
    throw new Error('dsh-cad-preview: 无法在内核脚本里定位导出语句（构建产物不匹配）')
  }
  const requireHandler =
    runtime?.require ??
    ((id) => {
      throw new Error(`dsh-cad-preview: CAD 内核试图 require("${id}")，浏览器环境不支持`)
    })
  const run = new Function(
    '__dshCapture',
    'module',
    'exports',
    'require',
    'window',
    'self',
    'globalThis',
    '__dirname',
    '__filename',
    `${patched}\n`,
  )
  run(
    (value) => {
      glueFactory = value
    },
    { exports: {} },
    {},
    requireHandler,
    globalThis,
    globalThis,
    globalThis,
    // Emscripten reads these only in its Node branch; a browser has neither, so
    // the glue stays on `document.currentScript` / `wasmBinary`.
    runtime?.dirname,
    runtime?.filename,
  )
  if (typeof glueFactory !== 'function') {
    throw new Error('dsh-cad-preview: CAD 内核加载异常（工厂函数缺失）')
  }
  const factory = glueFactory
  // `factory(options)` returns the emscripten Module (or its ready promise —
  // see `resolveKernel` in viewer.tsx, which accepts either shape).
  return (options) => (options === undefined ? factory() : factory(options))
}

/**
 * Evaluate the inlined glue and return its factory.
 *
 * The bytes are not bound here: `viewer.tsx` fetches and validates them, then
 * calls the returned factory as `factory({ wasmBinary })`. Keeping the two
 * apart is what lets a failed download report itself instead of surfacing as an
 * emscripten abort.
 *
 * @returns the glue factory.
 */
export default function loadOcctFactory() {
  return makeLoader(GLUE_SOURCE)
}
