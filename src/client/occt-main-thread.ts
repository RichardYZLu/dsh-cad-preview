/**
 * The kernel loader the **page** bundle resolves `__OCCT_FACTORY_MODULE__` to.
 *
 * It refuses on purpose, and the refusal is the design: B-rep tessellation runs
 * in the parsing worker (`occt-worker.ts`), never on the page's main thread. The
 * right sidebar shares the chat renderer, so a main-thread tessellation freezes
 * the whole DSH UI — the failure that once took the app down and into Safe Mode
 * — and a silent fallback would put that path right back within reach.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 *   - `lib/client.js` no longer carries the 163 KB emscripten glue at all; only
 *     `lib/client.worker.js` does. The page bundle gets smaller, and the only
 *     code that can run the kernel is the code that runs off-thread.
 *   - The headless build does not use this module: `node-entry.ts` resolves
 *     `__OCCT_FACTORY_MODULE__` to `occt-node-glue.ts`, which really does load the
 *     kernel in-process. There is no UI to freeze in a test run.
 */
const UNAVAILABLE =
  '这个环境没有 Web Worker，无法解析 STEP/IGES/BREP：' +
  'CAD 内核会长时间占用主线程并冻结整个界面，因此它只在 Worker 里运行。' +
  '请升级 DSH Desktop 后在正常窗口中打开该文件。'

/**
 * Refuse to build a main-thread kernel loader.
 *
 * @returns never; always throws.
 */
export function makeLoader() {
  throw new Error(UNAVAILABLE)
}

/**
 * Refuse to build a main-thread kernel factory.
 *
 * @returns never; always throws.
 */
export default function loadOcctFactory() {
  throw new Error(UNAVAILABLE)
}
