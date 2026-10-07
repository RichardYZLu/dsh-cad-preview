/**
 * dsh-cad-preview — the OpenCascade parsing worker.
 *
 * The page never tessellates anymore: a B-rep file is posted here (its bytes
 * transferred, so a 100 MB STEP is not copied), the worker owns the wasm kernel
 * for its whole lifetime, and the finished typed arrays travel back the same
 * way. Nothing in this file touches the DOM, three.js or React — a worker has
 * none of them, and the payload is intentionally plain arrays.
 *
 * Why a separate script instead of a `Blob` URL: the emscripten glue resolves
 * its own directory from `self.location` when it is compiled for a worker, and
 * a served script keeps that a real URL. It also lets the host route cache the
 * script like the rest of the bundle, and the page's module table (which has no
 * entry point inside a worker) stays out of the picture entirely.
 *
 * Build: `scripts/build-client.mjs` emits this entry as `lib/client.worker.js`
 * with the glue text inlined, and `lib/index.js` serves it at
 * `/cad-preview/worker.js`. The message protocol is `WORKER_PROTOCOL` in
 * `./occt-kernel`, which both sides import so the tag cannot drift.
 *
 * Verified end to end in Chromium (a headless page driving this exact artifact
 * with the real wasm and a real STEP file): ping answers, the first parse job
 * carries the kernel bytes, and a 74-line cone comes back as 1391 triangles.
 */
import loadOcctFactory from '__OCCT_FACTORY_MODULE__'
import { WORKER_PROTOCOL, resolveKernel, tessellateBRep } from './occt-kernel'

/**
 * The kernel, kept alive across jobs.
 *
 * Initializing it costs a 7.6 MB wasm compile plus the OpenCascade runtime; a
 * worker that re-created it per file would make every tab switch pay that
 * again. `null` means "not initialized" — the next job must carry the bytes.
 */
let kernelPromise = null

/**
 * Initialize (once) or return the kernel.
 *
 * @param wasmBinary - kernel bytes; required only for the first job.
 * @returns the initialized kernel.
 */
function kernelWith(wasmBinary) {
  if (kernelPromise === null) {
    if (wasmBinary === undefined || wasmBinary === null) {
      throw new Error('CAD 内核字节缺失：worker 的首次任务必须携带 wasmBinary')
    }
    kernelPromise = (async () => {
      const factory = await loadOcctFactory()
      return await resolveKernel(factory({ wasmBinary }))
    })().catch((error) => {
      // A kernel that failed to initialize must not be remembered as ready: the
      // main thread re-sends the bytes on the next attempt.
      kernelPromise = null
      throw error
    })
  }
  return kernelPromise
}

/**
 * Answer one job.
 *
 * @param job - the posted message.
 */
async function handle(job) {
  const { id } = job
  try {
    if (job.type === 'ping') {
      self.postMessage({ protocol: WORKER_PROTOCOL, id, ok: true, pong: true })
      return
    }
    if (job.type !== 'parse') throw new Error(`未知的 CAD worker 任务：${job.type}`)
    const occt = await kernelWith(job.wasmBinary)
    const payload = tessellateBRep(
      occt,
      new Uint8Array(job.data),
      job.ext,
      job.params,
      job.limits,
    )
    // Transfer instead of copy: the arrays are the whole result, and the worker
    // has no further use for them.
    const transfers = [payload.positions.buffer, payload.indices.buffer]
    if (payload.normals) transfers.push(payload.normals.buffer)
    self.postMessage(
      { protocol: WORKER_PROTOCOL, id, ok: true, kernelReady: true, payload },
      transfers,
    )
  } catch (error) {
    self.postMessage({
      protocol: WORKER_PROTOCOL,
      id,
      ok: false,
      error: error?.message ?? String(error),
    })
  }
}

self.addEventListener('message', (event) => {
  const job = event?.data
  if (job === null || typeof job !== 'object' || job.protocol !== WORKER_PROTOCOL) return
  void handle(job)
})
