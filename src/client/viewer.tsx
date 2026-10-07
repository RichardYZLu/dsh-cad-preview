/**
 * dsh-cad-preview — browser half.
 *
 * Registers a FileViewer with dsh-better-sidebar for STEP/STP/IGES/BREP
 * (OpenCascade WASM kernel) and STL/3MF/OBJ/PLY (pure-JS parsers), and renders
 * the real geometry with an orbit camera.
 *
 * The bundle is a single classic script built by scripts/build-client.mjs:
 *   - `react`, `three` and the three.js addon loaders come from the DSH shell
 *     module table / the package's own core bundle, via the `require` the
 *     module loader hands us;
 *   - `occt-import-js` is a lazy chunk that the *host* serves from
 *     /cad-preview/asset, because its 7.6 MB wasm must not be inlined here.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/ThreeMFLoader.js'
import loadOcctFactory, { makeLoader } from '__OCCT_FACTORY_MODULE__'
import { packOcctMeshes, resolveKernel, tessellateBRep } from './occt-kernel'
import { createOcctWorkerKernel, WORKER_PROTOCOL, WORKER_ROUTE } from './occt-remote'
import { createViewerScene, modelSpaceToScreen, modelUpRotation } from './scene'

// ─── format table ────────────────────────────────────────────────────────────

/** Suffixes handled by the OpenCascade kernel (B-rep, needs tessellation). */
const B_REP_EXTS = ['step', 'stp', 'iges', 'igs', 'brep']
/** Suffixes handled by pure-JS mesh parsers. */
const MESH_EXTS = ['stl', '3mf', 'obj', 'ply']
const ALL_EXTS = [...B_REP_EXTS, ...MESH_EXTS]

const VIEWER_ID = 'cad-preview:model'
const ROUTE = '/cad-preview'

/** Refuse to pull absurd files into a browser tab; the host caps at 512 MiB. */
const SOFT_MAX_BYTES = 192 * 1024 * 1024

function extOf(path) {
  const base = String(path ?? '')
  const dot = base.lastIndexOf('.')
  if (dot === -1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Is this an absolute path on any of the three shapes the host accepts?
 *
 * Mirrors the sidebar's own detector: POSIX roots, drive letters and UNC
 * shares must not be joined onto the session cwd.
 *
 * @param path - candidate path.
 * @returns whether the path is already absolute.
 */
function isAbsolutePath(path) {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[\\]{2}[^\\]/.test(path)
  )
}

/**
 * Resolve a viewer path against the session working directory.
 *
 * dsh-better-sidebar hands a viewer the path exactly as the tab recorded it,
 * which is usually relative to the session cwd (`cad-build/named/part.step`).
 * The plugin's own host route only accepts absolute paths — the browser has no
 * cwd to resolve against — so the join happens here, in the client, where the
 * scope carries the cwd.
 *
 * @param cwd - session working directory (`scope.cwd`), possibly undefined.
 * @param path - tab path, absolute or relative.
 * @returns an absolute path when the cwd is known, else the input unchanged.
 */
function resolveViewerPath(cwd, path) {
  if (isAbsolutePath(path)) return path
  const base = typeof cwd === 'string' ? cwd.trim() : ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}

function baseNameOf(path) {
  const base = String(path ?? '')
  const slash = base.lastIndexOf('/')
  return slash === -1 ? base : base.slice(slash + 1)
}

function bytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ─── parsing ─────────────────────────────────────────────────────────────────

/**
 * Fetch the kernel binary from this plugin's own host route.
 *
 * Two details matter more than they look:
 *
 *   - **The bytes are validated here.** Handing truncated or HTML bytes to the
 *     glue surfaces as emscripten's "Aborted(both async and sync fetching of
 *     the wasm failed)", which tells the user nothing. A magic-byte check turns
 *     that into an actionable message.
 *   - **One transient failure must not poison the session.** A single retry
 *     with a cache-busting query is cheap (7.6 MB, once per profile) and covers
 *     the interruption a page refresh mid-download would cause.
 *
 * The headless build replaces this through `__test.setWasmLoader` with a disk
 * read, which is the only place the module needs filesystem access.
 *
 * @returns the wasm bytes.
 */
export function createWasmFetcher(fetchImpl) {
  const looksLikeWasm = (bytes) =>
    bytes.length > 8 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  return async function fetchWasmBinary() {
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const suffix = attempt === 1 ? '' : `&retry=${Date.now()}`
        const response = await fetchImpl(`${ROUTE}/asset?name=occt-import-js.wasm${suffix}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!looksLikeWasm(bytes)) {
          throw new Error(
            `返回的不是 WebAssembly（${bytes.length} 字节，前 4 字节 ${[...bytes.slice(0, 4)].join(',')}）`,
          )
        }
        return bytes
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(
      `CAD 内核下载失败：${lastError?.message ?? lastError}。` +
        '内核由 /cad-preview/asset 提供，确认 DSH 在运行后点「重试」会重新下载。',
    )
  }
}

let byteLoader = createWasmFetcher((...args) => fetch(...args))

/**
 * Swap the kernel byte source (headless test seam).
 *
 * @param loader - returns the wasm bytes.
 */
export function setWasmLoader(loader) {
  byteLoader = loader
  occtPromise = null
}

/** Lazily fetch + initialize the OpenCascade wasm kernel. */
let occtPromise = null
function loadOcct() {
  if (occtPromise === null) {
    occtPromise = (async () => {
      // Bytes first: a download failure then reports itself instead of turning
      // into an emscripten abort, and the factory never runs without data.
      const wasmBinary = await byteLoader()
      const factory = await loadOcctFactory()
      return await resolveKernel(factory({ wasmBinary }))
    })().catch((error) => {
      occtPromise = null
      throw error
    })
  }
  return occtPromise
}

/**
 * Tessellate a B-rep file, in the parsing worker whenever the page has one.
 *
 * The worker is the point of the whole split: a wasm tessellation can allocate
 * gigabytes and runs to completion without yielding, so on the page's main
 * thread it freezes the entire DSH UI — the right sidebar shares the chat
 * renderer — and can take that renderer down with it. The in-process branch is
 * what the headless build and `test/smoke.mjs` exercise: Node has no `Worker`,
 * and those runs have no UI to freeze.
 *
 * @param arrayBuffer - raw file bytes; transferred to the worker when used.
 * @param ext - lower-case suffix, selecting the kernel entry point.
 * @param options - optional `{ signal, kernel }`.
 * @returns one merged BufferGeometry in model units.
 */
async function geometryFromBRep(arrayBuffer, ext, options = {}) {
  const kernel = options.kernel
  if (typeof Worker === 'function' && kernel) {
    const payload = await kernel.parse(arrayBuffer, ext, { signal: options.signal })
    return geometryFromPayload(payload)
  }
  const occt = await loadOcct()
  return geometryFromPayload(tessellateBRep(occt, new Uint8Array(arrayBuffer), ext))
}

/**
 * Wrap packed arrays in a BufferGeometry.
 *
 * @param payload - `positions`/`normals`/`indices` from the worker or from the
 *   in-process packer; the arrays are adopted, not copied.
 * @returns the renderable geometry.
 */
function geometryFromPayload(payload) {
  const positions = payload?.positions
  const indices = payload?.indices
  if (!positions || positions.length === 0 || !indices || indices.length === 0) {
    throw new Error('该文件里没有可显示的三角网格')
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (payload.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return geometry
}

/**
 * Merge every kernel mesh into one BufferGeometry (in-process surface).
 *
 * Kept as the headless equivalent of what the worker returns, so
 * `test/smoke.mjs` covers the packing rules without needing a browser.
 *
 * @param meshes - `result.meshes` from occt-import-js.
 * @returns merged geometry.
 */
function mergeOcctMeshes(meshes) {
  return geometryFromPayload(packOcctMeshes(meshes))
}

/**
 * Parse a mesh file with the three.js loaders.
 *
 * @param arrayBuffer - raw file bytes.
 * @param ext - lower-case suffix.
 * @returns one merged BufferGeometry.
 */
function geometryFromMesh(arrayBuffer, ext) {
  if (ext === 'stl') {
    return withUsableNormals(new STLLoader().parse(arrayBuffer))
  }
  if (ext === 'ply') {
    const geometry = new PLYLoader().parse(arrayBuffer)
    // Vertex colors would be ignored by our single standard material; keeping
    // them only wastes memory and makes the shading inconsistent.
    geometry.deleteAttribute('color')
    return withUsableNormals(geometry)
  }
  if (ext === 'obj') {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer))
    return withUsableNormals(mergeObject3D(new OBJLoader().parse(text)))
  }
  if (ext === '3mf') {
    return withUsableNormals(mergeObject3D(new ThreeMFLoader().parse(arrayBuffer)))
  }
  throw new Error(`不支持的格式 .${ext}`)
}

/**
 * Whether a normal attribute carries no usable direction.
 *
 * The STL format allows a file to store a zero normal per facet and leave the
 * direction to the reader — plenty of exporters do exactly that. Used verbatim,
 * `dot(normal, light)` is zero everywhere and the model renders **black**, which
 * looks like a viewer defect rather than a file characteristic.
 *
 * @param normal - the attribute to inspect.
 * @returns true when every entry is zero or non-finite.
 */
function normalsAreUnusable(normal) {
  for (let i = 0; i < normal.count; i += 1) {
    const x = normal.getX(i)
    const y = normal.getY(i)
    const z = normal.getZ(i)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return true
    if (x !== 0 || y !== 0 || z !== 0) return false
  }
  return true
}

/**
 * Give a mesh normals it can actually be shaded with.
 *
 * @param geometry - the parsed geometry.
 * @returns the same geometry, with normals derived from the faces when needed.
 */
function withUsableNormals(geometry) {
  const position = geometry.getAttribute('position')
  if (position === undefined) return geometry
  const normal = geometry.getAttribute('normal')
  if (normal === undefined || normal.count !== position.count || normalsAreUnusable(normal)) {
    // STL/PLY/OBJ geometry is usually non-indexed, so this yields per-face
    // normals — the faceted shading a CAD part wants, not a smoothed blob.
    geometry.computeVertexNormals()
  }
  return geometry
}

/**
 * Merge every mesh under an Object3D into one geometry.
 *
 * @param root - parsed object graph (OBJ group, 3MF build, …).
 * @returns merged geometry with world transforms applied.
 */
function mergeObject3D(root) {
  root.updateMatrixWorld(true)
  const chunks = []
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry) return
    const geometry = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone()
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    geometry.applyMatrix4(node.matrixWorld)
    chunks.push(geometry)
  })
  if (chunks.length === 0) throw new Error('该文件里没有可显示的网格')
  return joinGeometries(chunks)
}

/**
 * Concatenate non-indexed geometries into one.
 *
 * @param chunks - geometries that all carry a position attribute.
 * @returns a single non-indexed geometry, recomputing normals when no chunk
 * supplied them.
 */
function joinGeometries(chunks) {
  let total = 0
  let sawNormals = false
  for (const chunk of chunks) {
    total += chunk.getAttribute('position').count
    if (chunk.getAttribute('normal')) sawNormals = true
  }
  const positions = new Float32Array(total * 3)
  const normals = sawNormals ? new Float32Array(total * 3) : null
  let offset = 0
  for (const chunk of chunks) {
    const position = chunk.getAttribute('position')
    const normal = sawNormals ? chunk.getAttribute('normal') : null
    for (let i = 0; i < position.count; i += 1) {
      positions[(offset + i) * 3] = position.getX(i)
      positions[(offset + i) * 3 + 1] = position.getY(i)
      positions[(offset + i) * 3 + 2] = position.getZ(i)
      if (normals && normal) {
        normals[(offset + i) * 3] = normal.getX(i)
        normals[(offset + i) * 3 + 1] = normal.getY(i)
        normals[(offset + i) * 3 + 2] = normal.getZ(i)
      }
    }
    offset += position.count
    chunk.dispose()
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals) merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  else merged.computeVertexNormals()
  return merged
}

/**
 * Read one file's bytes from the plugin route.
 *
 * @param path - absolute path of the file the viewer was opened on.
 * @param signal - aborts the request when the viewer unmounts or re-matches.
 * @returns raw bytes.
 */
async function fetchModelBytes(path, signal) {
  const response = await fetch(`${ROUTE}/file?path=${encodeURIComponent(path)}`, { signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`读取失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength === 0) throw new Error('文件为空')
  return buffer
}

/**
 * Parse any supported file into a renderable geometry.
 *
 * @param arrayBuffer - raw bytes.
 * @param ext - lower-case suffix.
 * @param options - optional `{ signal, kernel }`, forwarded to the B-rep path.
 * @returns merged geometry.
 */
async function parseModel(arrayBuffer, ext, options = {}) {
  if (B_REP_EXTS.includes(ext)) return await geometryFromBRep(arrayBuffer, ext, options)
  if (MESH_EXTS.includes(ext)) return geometryFromMesh(arrayBuffer, ext)
  // Unknown suffix: the viewer was rematched by content or the file has no
  // extension. STEP is the most common case for this plugin, so try the kernel.
  return await geometryFromBRep(arrayBuffer, 'step', options)
}

// ─── viewer component ────────────────────────────────────────────────────────

const PALETTE = {
  accent: '#4d6bfe',
  border: 'rgba(127,127,127,0.28)',
  danger: '#e5484d',
}

function ToolButton({ label, title, active, disabled, onClick }) {
  return React.createElement(
    'button',
    {
      type: 'button',
      title,
      disabled: disabled === true,
      onClick,
      style: {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '0 8px',
        height: 24,
        borderRadius: 6,
        border: `0.5px solid ${PALETTE.border}`,
        background: active === true ? 'rgba(77,107,254,0.14)' : 'transparent',
        color: active === true ? PALETTE.accent : 'inherit',
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
      },
    },
    label,
  )
}

/**
 * The registered viewer. Props come from dsh-better-sidebar:
 * `path` is the absolute file, `title` its basename, `customData` whatever
 * `load()` returned.
 */
/**
 * The CAD canvas, driven by whatever bytes it is handed.
 *
 * Two callers supply them: `dsh-better-sidebar` hands over a tab path (fetched
 * through this plugin's own host route), while DSH's built-in document preview
 * hands over the file's bytes directly. Everything downstream — parsing, the
 * scene, the toolbar — is shared, so both mounts behave identically.
 *
 * @param props - see {@link CadViewerProps}.
 */
function CadViewer(props) {
  // The tab path is usually relative to the session cwd; the host route needs an
  // absolute path, so it is resolved once here. The native mount has no path at
  // all: it names the file and provides bytes.
  const path = props.path ?? ''
  const absolutePath = props.path === undefined ? null : resolveViewerPath(props.scope?.cwd, path)
  const label = props.name ?? absolutePath ?? path
  const ext = props.ext ?? extOf(path !== '' ? path : label)
  /**
   * Where the bytes come from: the host route by default, or the caller.
   *
   * Memoized on purpose, and this is load-bearing. A fresh closure per render
   * changes the load effect's dependency identity every render; that effect
   * calls `setStatus`, so it re-renders itself, and the panel ends up looping
   * forever — every iteration cancelling the previous parse, so the model never
   * appears while the browser is hammered with requests. 0.3.1 shipped exactly
   * that regression (0.3.0 had no such binding), and it is what took the main
   * window down. Keep it stable.
   */
  const loadBytes = useMemo(
    () => props.loadBytes ?? ((signal) => fetchModelBytes(absolutePath, signal)),
    [props.loadBytes, absolutePath],
  )
  const canvasRef = useRef(null)
  const sceneRef = useRef(null)
  // The parsing worker that belongs to this mounted viewer (see the mount
  // effect below); `null` in the headless build, where parsing stays in-process.
  const kernelRef = useRef(null)
  const [status, setStatus] = useState({ phase: 'loading', message: '' })
  const [info, setInfo] = useState(null)
  /** Toolbar "线框": the scene's line drawing, not a triangle wireframe. */
  const [wireframe, setWireframe] = useState(false)
  const [grid, setGrid] = useState(true)
  // CAD formats are Z-up, so that is the default; the toggle covers Y-up
  // sources (some mesh exporters write the graphics convention).
  const [zUp, setZUp] = useState(true)
  const [nonce, setNonce] = useState(0)
  // The load effect places the model with the current orientation; reading it
  // through a ref keeps an orientation change from re-downloading the file.
  const orientationRef = useRef(zUp)
  orientationRef.current = zUp

  // The load context the host received from `load()`, echoed back untouched.
  const customData = props.customData
  const controller = customData?.controller

  /** 「重置」：只把相机转回初始 3/4 视角，不重新取景、不动模型。 */
  const resetView = useCallback(() => {
    sceneRef.current?.resetView()
  }, [])

  /** 「适配」：只调整距离让模型全部进画面，视角保持不变。 */
  const frameAll = useCallback(() => {
    sceneRef.current?.frameAll()
  }, [])

  // The renderer, scene, orbit rig and gizmo live in ./scene, where the
  // ordering hazard around the very first draw is covered by test/wiring.mjs.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const state = createViewerScene(canvas)
    sceneRef.current = state
    state.fit()
    // One parsing worker for this mounted viewer: B-rep tessellation happens
    // there, never on the page's main thread (see ./occt-remote). Closing the
    // tab disposes it, which is what releases the kernel's heap.
    const kernel = createOcctWorkerKernel({ fetchWasmBinary: () => byteLoader() })
    kernelRef.current = kernel
    return () => {
      sceneRef.current = null
      kernelRef.current = null
      state.dispose()
      kernel.dispose()
    }
  }, [])


  // Orientation changes re-place the model and reframe it.
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return
    state.zUp = zUp
    if (state.mesh) state.mesh.rotation.x = modelUpRotation(zUp)
    state.fit()
  }, [zUp, status.phase])

  // Load the file whenever the path (or a manual retry) changes.
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return undefined
    let cancelled = false

    // Bail out on an unchanged status object. This effect re-renders the
    // component, so if one of its dependencies ever regains a per-render
    // identity, an unconditional `setStatus` turns the effect into an endless
    // loop that cancels its own parse (0.3.1 shipped that). Returning the same
    // object makes React skip the render, so the loop cannot start — the
    // memoized loader above is the real fix, this is the seatbelt.
    setStatus((previous) =>
      previous.phase === 'loading' && previous.message === '' ? previous : { phase: 'loading', message: '' },
    )
    setInfo(null)
    // A spinner-shaped placeholder is only honest while something is loading;
    // it must never sit on screen looking like the model the user asked for.
    state.placeholder.visible = true

    const run = async () => {
      if (customData !== null && customData !== undefined && customData.test?.() !== true) {
        throw new Error('该文件不是可显示的 3D 模型')
      }
      const started = performance.now()
      if (absolutePath === null && props.loadBytes === undefined) {
        throw new Error('这个预览位置没有可读取的文件来源')
      }
      const arrayBuffer = await loadBytes(controller?.signal)
      // The worker takes ownership of these bytes (they are transferred, not
      // copied), so the length the summary reports is captured first.
      const totalBytes = arrayBuffer.byteLength
      if (totalBytes > SOFT_MAX_BYTES) {
        throw new Error(`文件太大（${bytes(totalBytes)}），超出浏览器可流畅渲染的范围`)
      }
      const geometry = await parseModel(arrayBuffer, ext, {
        signal: controller?.signal,
        kernel: kernelRef.current,
      })
      if (cancelled) {
        geometry.dispose()
        return
      }
      geometry.computeBoundingBox()
      const box = geometry.boundingBox ?? new THREE.Box3()
      const size = box.getSize(new THREE.Vector3())
      const triangles = geometry.index
        ? geometry.index.count / 3
        : geometry.getAttribute('position').count / 3

      const mesh = new THREE.Mesh(geometry, state.material)
      mesh.name = `${VIEWER_ID}:mesh`
      mesh.rotation.x = modelUpRotation(orientationRef.current)
      state.scene.add(mesh)
      if (state.mesh) {
        state.scene.remove(state.mesh)
        state.mesh.geometry.dispose()
      }
      state.mesh = mesh
      state.placeholder.visible = false
      state.fit()

      setInfo({
        bytes: totalBytes,
        triangles: Math.round(triangles),
        size,
        ms: Math.round(performance.now() - started),
      })
      setStatus({ phase: 'ready', message: '' })
    }

    run().catch((error) => {
      if (cancelled || controller?.signal?.aborted === true) return
      state.placeholder.visible = false
      setStatus({ phase: 'error', message: error?.message ?? String(error) })
    })

    return () => {
      cancelled = true
    }
  }, [absolutePath, ext, nonce, customData, controller, props.byteKey, loadBytes])

  useEffect(() => {
    const state = sceneRef.current
    if (state) {
      // The scene renders `lines` as a 1° structural-edge drawing with the
      // surfaces hidden. A triangle wireframe (what `material.wireframe` gives on
      // a tessellated CAD part) is unreadable at any zoom.
      state.setAppearance(wireframe ? 'lines' : 'shaded')
      state.resize()
    }
  }, [wireframe, status.phase])

  useEffect(() => {
    const state = sceneRef.current
    if (state) {
      state.helpers.visible = grid
      state.resize()
    }
  }, [grid, status.phase])

  useEffect(() => {
    const onKey = (event) => {
      if (event.target !== document.body && event.target !== canvasRef.current) return
      if (event.key === 'w' || event.key === 'W') setWireframe((value) => !value)
      else if (event.key === 'u' || event.key === 'U') setZUp((value) => !value)
      else if (event.key === 'g' || event.key === 'G') setGrid((value) => !value)
      else if (event.key === 'r' || event.key === 'R') resetView()
      else if (event.key === 'f' || event.key === 'F') frameAll()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetView, frameAll])

  const summary = useMemo(() => {
    if (info === null) return `${baseNameOf(path)} · ${ext.toUpperCase() || 'MODEL'}`
    const dims = [info.size.x, info.size.y, info.size.z].map((value) => value.toFixed(2)).join(' × ')
    return `${bytes(info.bytes)} · ${dims} mm · ${info.triangles.toLocaleString()} 三角面 · ${info.ms} ms`
  }, [info, path, ext])

  const overlay = (children) =>
    React.createElement(
      'div',
      {
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          textAlign: 'center',
          padding: 24,
          font: '13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      },
      children,
    )

  return React.createElement(
    'div',
    {
      className: 'cadpv-root',
      'data-cadpv-viewer': VIEWER_ID,
      style: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'transparent',
        color: 'inherit',
      },
    },
    React.createElement(
      'div',
      {
        style: {
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderBottom: `0.5px solid ${PALETTE.border}`,
        },
      },
      React.createElement(
        'div',
        {
          title: label,
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            opacity: 0.75,
          },
        },
        summary,
      ),
      React.createElement(
        'span',
        {
          key: 'up',
          title: zUp
            ? '按 CAD 惯例把模型自身的 Z 轴作为竖直方向（快捷键 U 可切到 Y 轴向上，供图形惯例导出的网格使用）'
            : '按图形惯例把 Y 轴作为竖直方向（快捷键 U 切回 CAD 的 Z 轴向上）',
          style: { flex: 'none', fontSize: 11, opacity: 0.45, marginRight: 2 },
        },
        zUp ? 'Z↑' : 'Y↑',
      ),
      React.createElement(ToolButton, {
        label: '线框',
        title: '线框：只画结构线（1° 提取，面隐藏）(W)',
        active: wireframe,
        onClick: () => setWireframe((value) => !value),
      }),
      React.createElement(ToolButton, {
        label: '网格',
        title: '显示地面网格与坐标轴 (G)',
        active: grid,
        onClick: () => setGrid((value) => !value),
      }),
      React.createElement(ToolButton, {
        label: '适配',
        title: '把模型整体收进画面（F）——只调远近，不动视角，也不重新居中',
        onClick: frameAll,
      }),
      React.createElement(ToolButton, {
        label: '重置',
        title: '完全复位（R）：模型重新居中落地 + 全部进画面 + 视角回到初始 3/4',
        onClick: resetView,
      }),
    ),
    React.createElement(
      'div',
      { style: { position: 'relative', flex: '1 1 auto', minHeight: 0 } },
      React.createElement('canvas', {
        ref: canvasRef,
        'data-cadpv-canvas': true,
        style: { display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' },
      }),
      status.phase === 'loading'
        ? overlay([
            React.createElement('div', { key: 'spin', style: { fontSize: 13, opacity: 0.8 } }, '正在解析模型…'),
            React.createElement(
              'div',
              { key: 'hint', style: { fontSize: 11, opacity: 0.5 } },
              B_REP_EXTS.includes(ext)
                ? '首次打开需加载 OpenCascade 内核（约 7.6 MB，之后走浏览器缓存）· 解析在独立线程，不会卡住界面'
                : '正在读取几何体',
            ),
          ])
        : null,
      status.phase === 'error'
        ? overlay([
            React.createElement(
              'div',
              { key: 'msg', style: { color: PALETTE.danger, maxWidth: 360 } },
              status.message,
            ),
            React.createElement(
              'div',
              { key: 'actions', style: { display: 'flex', gap: 8 } },
              React.createElement(ToolButton, { label: '重试', onClick: () => setNonce((value) => value + 1) }),
            ),
          ])
        : null,
    ),
  )
}

/**
 * Implementation id used by DSH's own document preview registry.
 *
 * Namespaced the way the built-in previews are
 * (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown`), so it cannot
 * collide with a future built-in type.
 */
const DOCUMENT_BODY_ID = 'dsh-cad-preview/model'

/**
 * The body DSH's document preview mounts for a CAD file.
 *
 * The built-in previews read the file for us: with `loading: 'bytes-complete'`
 * the composed `content` arrives as `{ kind: 'bytes', data }`, so this needs no
 * route of its own. Frames before the bytes land are a loading state, and a new
 * `byteKey` re-runs the load when they arrive.
 *
 * @param props - composed slot props; see the document body contract.
 * @returns the CAD canvas.
 */
function CadDocumentBody(props) {
  const content = props.content
  const address = props.resourceAddress ?? props.name ?? ''
  const ext = extOf(address)
  const ready = content?.kind === 'bytes' && content.data !== undefined
  // Memoized for the same reason as the viewer's own loader (see CadViewer):
  // this closure sits in the load effect's dependency array, and a fresh
  // identity per render turns that effect into an endless loop. `byteKey` below
  // is what re-runs the load when the bytes actually change.
  const loadBytes = useCallback(async () => {
    if (content?.kind !== 'bytes' || content.data === undefined) {
      throw new Error('正在读取文件…')
    }
    // `data` is a view over the file's bytes; the parser wants an ArrayBuffer.
    const data = content.data
    return data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }, [content])
  return React.createElement(CadViewer, {
    name: baseNameOf(address),
    ext,
    // Changes when the bytes do, which is what re-runs the load.
    byteKey: ready ? `${address}:${content.revision ?? content.data.byteLength ?? 0}` : `${address}:pending`,
    loadBytes,
  })
}

// ─── registration ────────────────────────────────────────────────────────────

export const name = 'dsh-cad-preview'
/** No hard service dependency: both mounts are registered conditionally. */
export const inject = []

/**
 * No hard `inject`: the viewer mounts wherever it is welcome.
 *
 * Declaring `betterSidebar` here would make the whole plugin inert for anyone
 * without it — and DSH ships its own sidebar with a document-preview registry, so
 * requiring a third-party sidebar to show a file would be needless. Both mounts
 * are registered through `ctx.inject`, which runs each callback only once its
 * services exist.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  registerWithBetterSidebar(ctx)
  registerWithDocumentPreviews(ctx)
}

/**
 * Mount into `dsh-better-sidebar`, when that plugin is installed.
 *
 * @param ctx - the plugin context.
 */
function registerWithBetterSidebar(ctx) {
  ctx.inject(['betterSidebar'], (scope) => {
    scope.effect(
      () =>
        scope.betterSidebar.registerFileViewer({
        id: VIEWER_ID,
        title: '3D 模型',
        exts: ALL_EXTS,
        priority: 120,
        fetchStrategy: 'custom',
        // The bytes are streamed by the plugin's own host route (Range capable,
        // absolute paths). This loader only hands the viewer a per-file load
        // context: the abort controller plus the suffix check that lets a
        // content-rematched file fall back to the text viewer.
        load: async (path) => {
          const ext = extOf(path)
          return {
            path,
            ext,
            controller: new AbortController(),
            test: () => ALL_EXTS.includes(ext),
          }
        },
          component: CadViewer,
        }),
      'dsh-cad-preview: 3D model viewer (better-sidebar)',
    )
  })
}

/**
 * Mount into DSH's built-in document preview, so the viewer works without any
 * third-party sidebar.
 *
 * The definition mirrors the built-in binary types (image, PDF): the same
 * `bytes-complete` loading strategy, and the extension list this plugin parses.
 *
 * @param ctx - the plugin context.
 */
function registerWithDocumentPreviews(ctx) {
  ctx.inject(['documentPreviews', 'slots'], (scope) => {
    scope.effect(
      () =>
        scope.documentPreviews.register({
          id: DOCUMENT_BODY_ID,
          extensions: ALL_EXTS,
          binaryExtensions: ALL_EXTS,
          priority: 'builtin',
          title: () => '3D 模型',
          loading: 'bytes-complete',
          wrap: false,
        }),
      'dsh-cad-preview: document type',
    )
    scope.effect(
      () =>
        scope.slots.inject('sidebar.right.tab.document', () =>
          scope.slots.register(
            { name: 'sidebar.right.tab.document', key: DOCUMENT_BODY_ID },
            CadDocumentBody,
          ),
        ),
      'dsh-cad-preview: document body',
    )
  })
}

/** Headless surface for `test/smoke.mjs`; absent from the browser build's use. */
export const __test = {
  createWasmFetcher,
  modelUpRotation,
  modelSpaceToScreen,
  setWasmLoader,
  makeLoader,
  resolveKernel,
  parseModel,
  geometryFromBRep,
  geometryFromMesh,
  withUsableNormals,
  normalsAreUnusable,
  geometryFromPayload,
  mergeOcctMeshes,
  packOcctMeshes,
  tessellateBRep,
  createOcctWorkerKernel,
  WORKER_PROTOCOL,
  WORKER_ROUTE,
  joinGeometries,
  extOf,
  baseNameOf,
  isAbsolutePath,
  resolveViewerPath,
  bytes,
  ALL_EXTS,
  B_REP_EXTS,
  MESH_EXTS,
}
