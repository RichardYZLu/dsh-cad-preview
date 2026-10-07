/**
 * dsh-cad-preview — the kernel-facing half of B-rep parsing.
 *
 * Deliberately free of three.js, React and of every DOM/worker API: the very
 * same module runs
 *
 *   1. inside the parsing **worker** (browser, `src/client/occt-worker.ts`),
 *   2. inside the **in-process** fallback the headless build uses
 *      (`lib/client.node.mjs`, driven by `test/smoke.mjs`),
 *
 * so the two paths cannot drift apart. Everything here is plain typed arrays.
 *
 * Why the split matters at all: OpenCascade's wasm heap may grow to 2 GB and a
 * tessellation is a long synchronous call. Running that on the page's main
 * thread freezes the whole DSH UI (the right sidebar shares the chat renderer)
 * and can take the renderer down with it — which is exactly the failure that
 * put the app into Safe Mode once. The worker owns the kernel; the page only
 * ever receives finished typed arrays.
 */

/** The message-protocol tag both sides check before trusting a payload. */
export const WORKER_PROTOCOL = 'dsh-cad-preview/occt-worker@1'

/** Tessellation parameters handed to `ReadStepFile`/`ReadIgesFile`/`ReadBrepFile`. */
export const B_REP_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.0015,
  angularDeflection: 0.3,
}

/**
 * Upper bound on the triangles one file may materialise.
 *
 * The kernel is allowed to report far more than a browser can hold: three
 * packed attributes plus a WebGL upload at ~50 bytes per triangle means this
 * cap is already ~600 MB of renderer memory. Refusing early is the difference
 * between a message and a dead tab.
 */
export const MAX_TRIANGLES = 12_000_000

/**
 * Pick the kernel entry point for a suffix.
 *
 * @param ext - lower-case suffix.
 * @returns the `occt-import-js` method name.
 */
export function kernelEntryFor(ext) {
  if (ext === 'iges' || ext === 'igs') return 'ReadIgesFile'
  if (ext === 'brep') return 'ReadBrepFile'
  return 'ReadStepFile'
}

/**
 * Reduce the emscripten hand-off to the ready kernel.
 *
 * Depending on how the glue was built it returns either its `ready` promise or
 * the Module carrying it, so both shapes are accepted here.
 *
 * @param returned - what the glue factory returned.
 * @returns the initialized kernel with `ReadStepFile`/`ReadIgesFile`/`ReadBrepFile`.
 */
export async function resolveKernel(returned) {
  const settled = typeof returned?.then === 'function' ? await returned : returned
  if (settled !== null && settled !== undefined && typeof settled.ReadStepFile !== 'function'
      && typeof settled.ready?.then === 'function') {
    return await settled.ready
  }
  return settled
}

/**
 * Tessellate a B-rep file and pack the result for the renderer.
 *
 * @param occt - the initialized kernel.
 * @param data - raw file bytes.
 * @param ext - lower-case suffix, selecting the kernel entry point.
 * @param params - tessellation parameters; defaults to {@link B_REP_PARAMS}.
 * @param limits - `maxTriangles` override for tests.
 * @returns the packed payload (see {@link packOcctMeshes}).
 */
export function tessellateBRep(occt, data, ext, params = B_REP_PARAMS, limits = {}) {
  const entry = kernelEntryFor(ext)
  const read = occt?.[entry]
  if (typeof read !== 'function') {
    throw new Error(`CAD 内核缺少 ${entry}（内核没有初始化，或版本不匹配）`)
  }
  const result = read.call(occt, data, params)
  if (result === null || result === undefined || result.success !== true) {
    throw new Error('CAD 内核无法解析该文件（可能不是有效的 B-rep 或版本不受支持）')
  }
  const meshes = result.meshes ?? []
  if (meshes.length === 0) throw new Error('该文件里没有可显示的几何体')
  return packOcctMeshes(meshes, limits)
}

/**
 * Merge every kernel mesh into one pair of packed arrays.
 *
 * The arrays are returned unpacked from any three.js type on purpose: they are
 * what crosses the worker boundary (transferred, not copied), and the page only
 * wraps them in `BufferAttribute`s afterwards. Per-mesh and per-face colors are
 * reduced to one material, and the kernel-side buffers are released before
 * returning.
 *
 * @param meshes - `result.meshes` from occt-import-js.
 * @param limits - `maxTriangles` override for tests.
 * @returns positions/normals/indices plus the triangle count.
 */
export function packOcctMeshes(meshes, limits = {}) {
  const maxTriangles = limits.maxTriangles ?? MAX_TRIANGLES
  let vertexTotal = 0
  let indexTotal = 0
  for (const mesh of meshes ?? []) {
    const positions = mesh?.attributes?.position?.array
    const indices = mesh?.index?.array
    if (!positions || !indices) continue
    vertexTotal += Math.floor(positions.length / 3)
    indexTotal += indices.length
  }
  if (indexTotal === 0) throw new Error('该文件里没有可显示的三角网格')
  const triangleCount = Math.floor(indexTotal / 3)
  if (triangleCount > maxTriangles) {
    throw new Error(
      `网格太大（${triangleCount} 三角面，超过上限 ${maxTriangles}）——` +
        'CAD 预览是给人看的，不是用来装下整栋楼的；请在导出时简化模型或只预览局部。',
    )
  }

  const positions = new Float32Array(vertexTotal * 3)
  const normals = new Float32Array(vertexTotal * 3)
  const indices = vertexTotal > 65535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal)
  let vertexOffset = 0
  let indexOffset = 0
  let sawNormals = false

  for (const mesh of meshes ?? []) {
    const srcPositions = mesh?.attributes?.position?.array
    const srcNormals = mesh?.attributes?.normal?.array
    const srcIndices = mesh?.index?.array
    if (!srcPositions || !srcIndices) continue
    const vertexCount = Math.floor(srcPositions.length / 3)
    positions.set(srcPositions, vertexOffset * 3)
    if (srcNormals && srcNormals.length === srcPositions.length) {
      normals.set(srcNormals, vertexOffset * 3)
      sawNormals = true
    }
    for (let i = 0; i < srcIndices.length; i += 1) {
      indices[indexOffset + i] = srcIndices[i] + vertexOffset
    }
    vertexOffset += vertexCount
    indexOffset += srcIndices.length
  }

  for (const mesh of meshes ?? []) {
    try {
      mesh?.delete?.()
    } catch {
      /* kernel-side release is best-effort */
    }
  }

  return {
    positions,
    normals: sawNormals ? normals : null,
    indices,
    vertexCount: vertexTotal,
    triangleCount,
  }
}
