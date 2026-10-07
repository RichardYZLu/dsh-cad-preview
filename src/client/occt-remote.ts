/**
 * dsh-cad-preview — main-thread client for the parsing worker.
 *
 * The page's half of the contract described in `./occt-worker`: hand over the
 * file bytes (transferred, never copied) and get packed typed arrays back. The
 * worker is created lazily on the first parse, kept warm for the following
 * files, and **terminated** whenever the job cannot be trusted to finish —
 * a cancellation, a crash, or a script that failed to load.
 *
 * Terminating on cancel is not politeness: a synchronous wasm tessellation
 * cannot be interrupted cooperatively, so killing the worker is the only way to
 * actually stop it and to hand its up-to-2 GB heap back to the system. The next
 * parse transparently creates a fresh worker.
 *
 * One kernel per mounted viewer is deliberate: closing a CAD tab then frees its
 * kernel immediately, and a pathological file can only ever burn its own
 * worker.
 */
import { B_REP_PARAMS, MAX_TRIANGLES, WORKER_PROTOCOL } from './occt-kernel'

/** Re-exported so both halves of the contract are reachable from one module. */
export { WORKER_PROTOCOL }

/** Where the built worker script is served from. */
export const WORKER_ROUTE = '/cad-preview/worker.js'

/**
 * An `AbortError`, without depending on `DOMException` being present.
 *
 * @returns an error a `catch` can recognise by `name`.
 */
export function abortError() {
  const error = new Error('CAD 解析已取消')
  error.name = 'AbortError'
  return error
}

/**
 * Create the worker-backed B-rep parser.
 *
 * @param options - `scriptUrl` (defaults to {@link WORKER_ROUTE}),
 *   `workerFactory` (test seam; defaults to `new Worker`), and
 *   `fetchWasmBinary` (returns the kernel bytes when a fresh worker needs them).
 * @returns an object with `parse()` and `dispose()`.
 */
export function createOcctWorkerKernel(options = {}) {
  const scriptUrl = options.scriptUrl ?? WORKER_ROUTE
  const workerFactory =
    options.workerFactory ?? ((url, init) => new Worker(url, init))
  const fetchWasmBinary =
    options.fetchWasmBinary ??
    (async () => {
      throw new Error('CAD 内核字节来源未配置')
    })

  /** The live worker, or `null` when the next parse must create one. */
  let worker = null
  /** Whether the *current* worker already holds an initialized kernel. */
  let kernelReady = false
  let nextId = 1
  /** Job id → `{ resolve, reject, signal, onAbort }`. */
  const pending = new Map()

  /**
   * Drop the worker and fail everything that was waiting on it.
   *
   * @param error - the reason handed to the waiting callers.
   */
  function abandon(error) {
    kernelReady = false
    if (worker !== null) {
      try {
        worker.terminate()
      } catch {
        /* the worker may already be gone */
      }
      worker = null
    }
    for (const entry of [...pending.values()]) {
      pending.delete(entry.id)
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
  }

  /**
   * Wire one worker's channels.
   *
   * @param target - the freshly created worker.
   */
  function attach(target) {
    target.addEventListener('message', (event) => {
      const message = event?.data
      if (message === null || typeof message !== 'object') return
      if (message.protocol !== WORKER_PROTOCOL) return
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(entry.id)
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
      if (message.ok === true) {
        if (message.kernelReady === true) kernelReady = true
        if (!message.payload?.positions || !message.payload?.indices) {
          entry.reject(new Error('CAD 解析线程返回了空的几何体'))
          return
        }
        entry.resolve(message.payload)
        return
      }
      entry.reject(new Error(message.error ?? 'CAD 解析线程返回了失败'))
    })
    // A worker that fails to *load* (stale install, 404 on the route) fires
    // `error` and never answers: reporting it here beats a spinner that never
    // ends.
    target.addEventListener('error', (event) => {
      abandon(new Error(`CAD 解析线程出错：${event?.message ?? '脚本无法加载'}`))
    })
    target.addEventListener('messageerror', () => {
      abandon(new Error('CAD 解析线程的消息无法反序列化'))
    })
  }

  /**
   * The live worker, created on demand.
   *
   * @returns the worker to post to.
   */
  function ensureWorker() {
    if (worker === null) {
      const created = workerFactory(scriptUrl, { name: 'dsh-cad-preview-occt' })
      attach(created)
      worker = created
    }
    return worker
  }

  /**
   * Tessellate one file in the worker.
   *
   * @param arrayBuffer - raw file bytes; **transferred** to the worker, so the
   *   caller must not use it afterwards.
   * @param ext - lower-case suffix.
   * @param parseOptions - optional `signal`; aborting kills the worker.
   * @returns the packed payload.
   */
  async function parse(arrayBuffer, ext, parseOptions = {}) {
    const signal = parseOptions.signal
    if (signal?.aborted === true) throw abortError()

    // Bytes first, worker second: an abort that lands while the 7.6 MB kernel
    // is being fetched must leave nothing running behind it.
    let wasmBinary
    if (!kernelReady) wasmBinary = await fetchWasmBinary()
    if (signal?.aborted === true) throw abortError()

    const target = ensureWorker()
    const id = nextId
    nextId += 1

    return await new Promise((resolve, reject) => {
      const entry = { id, resolve, reject, signal, onAbort: null }
      if (signal) {
        entry.onAbort = () => {
          if (!pending.delete(id)) return
          reject(abortError())
          abandon(new Error('CAD 解析已取消'))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      pending.set(id, entry)
      try {
        target.postMessage(
          {
            protocol: WORKER_PROTOCOL,
            id,
            type: 'parse',
            data: arrayBuffer,
            wasmBinary,
            ext,
            params: parseOptions.params ?? B_REP_PARAMS,
            limits: { maxTriangles: parseOptions.maxTriangles ?? MAX_TRIANGLES },
          },
          [arrayBuffer],
        )
      } catch (error) {
        pending.delete(id)
        if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort)
        reject(new Error(`无法把文件交给 CAD 解析线程：${error?.message ?? error}`))
      }
    })
  }

  /**
   * Stop the worker and release its kernel.
   *
   * The object stays usable: the next `parse()` creates a new worker.
   */
  function dispose() {
    abandon(new Error('CAD 解析线程已释放'))
  }

  return { parse, dispose, scriptUrl }
}
