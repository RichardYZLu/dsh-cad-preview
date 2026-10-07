/**
 * Four ways to make a CAD model's block structure readable — as a prototype.
 *
 * This is a *sampler*, not plugin code: the point is to compare looks on real
 * geometry before committing any of them to the viewer. The four candidates are
 *
 *   1. 现状     the shading + edge overlay that shipped in 0.2.12 (the baseline)
 *   2. 草图风   bright fills, heavy dark edges — the classic CAD/sketch look
 *   3. 环境光遮蔽  screen-space AO darkening crevices, where hundreds of parts meet
 *   4. 只画结构线  drop the surfaces, keep silhouette and block boundaries
 *   5. 结构线加强  baseline with much stronger lines
 *
 * Every variant keeps the same camera, grid and origin ring, so switching feels
 * like changing a setting rather than changing the program.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { createViewerScene, modelUpRotation } from '../client/scene'

const stage = document.getElementById('stage')
const reportEl = document.getElementById('report')

/**
 * Show failures on the page.
 *
 * A module that throws during evaluation renders as a blank page with the error
 * only in the console — indistinguishable from "the server is broken". Surfacing
 * it here is the difference between a usable prototype and a guessing game.
 *
 * @param message - what went wrong.
 */
function fail(message) {
  reportEl.innerHTML = `<b style="color:#ff6b6b">出错了：</b> ${message}`
}
window.addEventListener('error', (event) => fail(event.message))
window.addEventListener('unhandledrejection', (event) => fail(String(event.reason)))

const canvas = document.createElement('canvas')
stage.appendChild(canvas)
const state = createViewerScene(canvas)
state.zUp = true
applySurfaceOffset()

// ── the model ────────────────────────────────────────────────────────────────
// A real tessellated CAD part, so "too many small blocks" is actually exercised.
let mesh = null
let edges = null

/**
 * Push filled surfaces back so coincident edge lines win the depth test.
 *
 * Polygon offset must be applied to the *polygon*, not the line: the GL state is
 * `POLYGON_OFFSET_FILL`, and `LineSegments` draws GL_LINES, which it does not
 * touch. Setting it on the line material (as this sampler first did) therefore
 * changed nothing, and every structural edge kept z-fighting with the face it
 * belongs to — visible as patches of a cylinder flipping between solid and
 * hollow, at a scale that shifts with distance so no line-threshold can remove it.
 */
/**
 * Whether the filled surfaces are pushed back so coincident lines win the depth
 * test.
 *
 * Off: the fat edge lines already carry their own offset, which is where the
 * fight actually is. Doubling the bias only widens the margin by which geometry
 * *behind* a surface can bleed through — up to ~30 world units on grazing faces —
 * and off is enough for the lines to stay intact.
 */
let surfaceOffset = false

function applySurfaceOffset() {
  state.material.polygonOffset = surfaceOffset
  state.material.polygonOffsetFactor = surfaceOffset ? 1 : 0
  state.material.polygonOffsetUnits = surfaceOffset ? 1 : 0
  state.material.needsUpdate = true
}

/** Model files the sample server can hand out, in menu order. */
const MODELS = await fetch('/models').then((response) => response.json())

/**
 * Extract the edges where the surface turns, then drop the fragments.
 *
 * Two filters are needed, and they solve different halves of the problem:
 *
 *   angle  — below this dihedral angle an edge is not a design edge. Set high it
 *            erases cylinders (a 24-sided one turns 15° per facet); set low it
 *            keeps them and every tessellation sliver with them.
 *   length — a sliver is short, a design edge is long. Filtering by length is
 *            what lets the angle be low enough for curves without drowning the
 *            view in fragments, and it behaves like a distance filter as the
 *            camera pulls back.
 *
 * @param geometry - source geometry.
 * @param threshold - dihedral angle in degrees.
 * @param minLength - keep only edges at least this long, in model units.
 * @returns the edge geometry, or null when nothing survives.
 */
function structuralEdges(geometry, threshold) {
  const raw = new THREE.EdgesGeometry(geometry, threshold)
  const count = raw.getAttribute('position').count
  if (count === 0) {
    raw.dispose()
    return null
  }
  return raw
}

/**
 * The threshold the installed overlay was actually built with, so a mode that
 * pins its own value can tell when a rebuild is needed.
 */
let builtThreshold = null
/** Model's largest dimension, used to report sizes in model units. */
let modelSpan = 1

/**
 * The threshold in force for the selected mode.
 *
 * `lines` pins 1°: at that angle a cylinder's facet edges survive (a 24-sided one
 * turns 15° per facet) while flat block faces still contribute nothing, which is
 * the extraction that made the line drawing read correctly. Shaded modes keep the
 * user's setting, where the lines only annotate surfaces and a higher threshold
 * is less noisy.
 *
 * @returns the threshold in degrees.
 */
function effectiveThreshold() {
  // Every mode pins its own value: the line drawing needs 1° to keep cylinders,
  // while the shaded modes only annotate surfaces and read cleaner at 30°.
  return VARIANTS[active].threshold ?? 30
}

/** Rebuild the overlay only when the threshold in force has actually changed. */
function ensureEdges() {
  if (builtThreshold === effectiveThreshold()) return
  stats.edgeMs = rebuildEdges()
  stats.segments = edges === null ? 0 : edges.geometry.getAttribute('position').count / 2
}

/**
 * Edge width in pixels.
 *
 * Measured in pixels on purpose. A 1-pixel line covers proportionally less of a
 * larger model, and with MSAA its sub-pixel coverage — and with it the apparent
 * lightness — shifts as the camera zooms. That is the "lines get lighter when I
 * zoom in" effect; a width fixed in pixels keeps constant weight at any zoom.
 */
const LINE_WIDTH_PX = 1.0

/** Rebuild the edge overlay for the installed mesh at the current threshold. */
function rebuildEdges() {
  if (edges !== null) {
    mesh.remove(edges)
    edges.geometry.dispose()
    edges.material.dispose()
    edges = null
  }
  if (mesh === null) return 0
  const started = performance.now()
  builtThreshold = effectiveThreshold()
  const raw = structuralEdges(mesh.geometry, builtThreshold)
  if (raw === null) return 0

  // Fat lines are instanced quads rather than GL_LINES, which has a useful
  // consequence: polygon offset *does* apply to them, so the depth fight with the
  // surface underneath is settled the standard way.
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(raw.getAttribute('position').array)
  raw.dispose()
  const material = new LineMaterial({
    color: 0xdfe7f5,
    linewidth: LINE_WIDTH_PX,
    worldUnits: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  })
  edges = new LineSegments2(geometry, material)
  edges.frustumCulled = false
  edges.userData.helper = true
  mesh.add(edges)
  applyEdgeWidth()
  return performance.now() - started
}

/** Keep the fat-line material's pixel width and viewport in step. */
function applyEdgeWidth() {
  if (edges === null) return
  edges.material.linewidth = LINE_WIDTH_PX
  // A pixel-width line has to know the viewport it is measured against.
  edges.material.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1)
  edges.material.needsUpdate = true
}

// ── depth precision ──────────────────────────────────────────────────────────
// The viewer ships with a fixed 0.01 .. 100000 near/far pair (a 10^7 ratio). At
// building scale that is a disaster: everything closer together than ~9 metres
// lands on the same depth value, so every joint between parts z-fights and the
// surfaces shimmer while the camera moves. With no faces drawn (`lines`) there is
// nothing to fight over, which is exactly the pattern that was reported.
//
// Planes fitted to the model recover ~190000x the separation there.
let modelRadius = 1

/** Fit the clip planes to the model, then keep them honest as the camera moves. */
function updateClipPlanes() {
  const distance = state.camera.position.distanceTo(state.rig.target)
  // Near must stay *inside* the model's front surface. Scaling it with the model
  // radius instead (2% of the radius) is larger than the camera-to-surface gap as
  // soon as the camera moves in, and the near plane then slices the model open —
  // the "half the cylinder vanishes when zooming" failure.
  state.camera.near = Math.max(distance * 0.002, 1e-4)
  // Far must clear the model's back surface at any allowed distance.
  state.camera.far = distance + modelRadius * 6
  state.camera.updateProjectionMatrix()
}

// ── post-processing, only used for the AO variant ────────────────────────────
const composer = new EffectComposer(state.renderer)
composer.addPass(new RenderPass(state.scene, state.camera))
const ssao = new SSAOPass(state.scene, state.camera, 1024, 1024)
ssao.kernelRadius = 12
ssao.minDistance = 0.002
ssao.maxDistance = 0.12
composer.addPass(ssao)
composer.addPass(new OutputPass())
let compose = false

// Keep the composer in step with the viewer's own camera handling.
state.renderer.domElement.addEventListener('pointerup', () => {
  ssao.camera = state.camera
})
const originalResize = state.resize
state.resize = () => {
  originalResize()
  composer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1)
  ssao.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1)
}

/**
 * Face colour, chosen to sit against the surrounding GUI rather than against the
 * model: the sidebar can be dark or light, and a fill that reads well on one
 * disappears on the other.
 */
let faceColor = 0xdadee2 // 浅灰

/**
 * Background the model is being previewed against.
 *
 * Held as state rather than read back from the DOM: the browser normalises
 * `style.background` (a set `#14161b` reads back as `rgb(20, 22, 27)`), so
 * comparing against it never matches and the button would never light up.
 */
let backgroundChoice = '#14161b'

/**
 * Edge colour policy.
 *
 * `face` and `background` differ in what the lines must stand out against. When a
 * surface is drawn the line sits *on* it, so the fill decides visibility; with no
 * surface (`lines`) only the background can hide the drawing. `balanced` refuses
 * to pick a colour that vanishes into either.
 */
let edgeChoice = 'background'

/** Lighting presets. `contrast` is the one the combined mode uses. */
const LIGHTING = {
  soft: { ambient: 0.28, hemi: 0.35, key: 1.5, fill: 0.45, rim: 0.35 },
  // Low ambient and a strong key: surfaces facing different directions separate,
  // which is what "更强的明暗对比" asks for.
  contrast: { ambient: 0.1, hemi: 0.18, key: 2.4, fill: 0.22, rim: 0.18 },
  flat: { ambient: 1.0, hemi: 0.2, key: 0.5, fill: 0.3, rim: 0.2 },
}

/** The scene's lights, grouped by role, so a preset can drive them. */
const lights = { ambient: null, hemi: null, directional: [] }
state.scene.traverse((object) => {
  if (object.isAmbientLight) lights.ambient = object
  else if (object.isHemisphereLight) lights.hemi = object
  else if (object.isDirectionalLight) lights.directional.push(object)
})

/**
 * Apply a lighting preset.
 *
 * @param name - key into {@link LIGHTING}.
 */
function setLighting(name) {
  const preset = LIGHTING[name]
  if (lights.ambient !== null) lights.ambient.intensity = preset.ambient
  if (lights.hemi !== null) lights.hemi.intensity = preset.hemi
  const order = ['key', 'fill', 'rim']
  lights.directional.forEach((light, index) => {
    const role = order[index]
    if (role !== undefined) light.intensity = preset[role]
  })
  lightingName = name
}

/** Which lighting preset is in force, for the panel. */
let lightingName = 'soft'

/** Relative luminance of a packed colour, 0 (black) to 1 (white). */
function luminance(hex) {
  const r = ((hex >> 16) & 0xff) / 255
  const g = ((hex >> 8) & 0xff) / 255
  const b = (hex & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Candidate edge colours, dark to light, for the `balanced` policy. */
const EDGE_CANDIDATES = [0x0d1117, 0x39414f, 0x6b7482, 0x9aa6b8, 0xdfe7f5]

/**
 * The edge colour to draw with.
 *
 * `face` is the default because an edge is drawn on top of a surface: on a light
 * fill it must be dark and vice versa, or it simply blends in. `background`
 * follows the GUI instead — which is what you want with no fill at all, but on a
 * light fill over a dark background it produces light lines on a light surface
 * (contrast 0.00). `balanced` takes the candidate that keeps the larger minimum
 * contrast against both.
 *
 * @returns the packed colour.
 */
function resolveEdgeColor() {
  if (edgeChoice === 'dark') return 0x0d1117
  if (edgeChoice === 'light') return 0xdfe7f5

  const face = luminance(faceColor)
  const background = luminance(parseCssColor(backgroundChoice))
  const drawn = state.material.visible

  if (edgeChoice === 'face') {
    return (drawn ? face : background) > 0.5 ? 0x0d1117 : 0xdfe7f5
  }
  if (edgeChoice === 'background') {
    return background > 0.5 ? 0x0d1117 : 0xdfe7f5
  }

  // Balanced: maximise the smaller of the two contrasts, so the line is legible
  // against the surface it sits on *and* does not disappear into the GUI.
  let best = EDGE_CANDIDATES[0]
  let bestScore = -1
  for (const candidate of EDGE_CANDIDATES) {
    const againstFace = Math.abs(luminance(candidate) - face)
    const againstBackground = Math.abs(luminance(candidate) - background)
    const score = drawn ? Math.min(againstFace, againstBackground) : againstBackground
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/**
 * Parse a `#rrggbb` string into a packed colour.
 *
 * @param css - the CSS colour.
 * @returns the packed colour, or mid grey when unparsable.
 */
function parseCssColor(css) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(css).trim())
  return match === null ? 0x808080 : Number.parseInt(match[1], 16)
}

/** Apply the preview background to the stage. */
function applyBackground() {
  stage.style.background = backgroundChoice
  applyGridContrast()
}

/**
 * Keep the grid legible on whatever background is being previewed.
 *
 * `GridHelper` draws with vertex colours, and `material.color` multiplies them,
 * so a tint can only darken the grid — which is exactly what a light background
 * needs. On a dark background the tint stays white and the grid keeps the light
 * grey it was built with.
 */
function applyGridContrast() {
  const dark = luminance(parseCssColor(backgroundChoice)) > 0.5
  state.gridHelper.material.color.set(dark ? 0x4a5262 : 0xffffff)
  state.gridHelper.material.needsUpdate = true
}

/** Apply the chosen fill to the surface material. */
function applyFace() {
  state.material.color.set(faceColor)
  state.material.metalness = 0
  state.material.roughness = 0.85
  state.material.wireframe = false
  state.material.visible = true
  state.material.needsUpdate = true
}

/**
 * Style the edge overlay.
 *
 * Colour only: edges are fully opaque in every mode. A translucent edge blends
 * with whatever surface is behind it, so its apparent lightness would follow the
 * shading rather than the palette — and shift as the camera moves.
 */
function applyEdge() {
  if (edges === null) return
  edges.material.color.set(resolveEdgeColor())
  edges.material.needsUpdate = true
}


/**
 * The candidate appearances. Each is a pure function of the scene, so switching
 * between them cannot leave state behind.
 */
const VARIANTS = {
  current: {
    threshold: 30,
    blurb: '现状：柔和配光 + 30° 结构线 + 线沿视线前推（0.2.12 的方向，已修好深度与裁剪面）',
    apply() {
      applyFace()
      setLighting('soft')
      applyEdge()
      compose = false
    },
  },
  'ao+strong': {
    threshold: 30,
    blurb:
      '环境光遮蔽 + 强结构线（合并）：遮蔽加深凹角与接缝、配光对比加强、结构线画成实心 —— 构件密集时最清楚',
    apply() {
      applyFace()
      setLighting('contrast')
      applyEdge()
      compose = true
    },
  },
  lines: {
    threshold: 1,
    blurb: '只画结构线：1° 提取（圆柱等曲面完整保留），面全部隐藏，不做屏幕空间剔除',
    apply() {
      state.material.visible = false
      applyEdge()
      compose = false
    },
  },
}

let active = 'current'
let stats = { edgeMs: 0, name: '', segments: 0 }

/** Render one frame through the path the current variant needs. */
function draw() {
  updateClipPlanes()
  state.camera.updateMatrixWorld(true)
  if (compose) composer.render()
  else state.renderer.render(state.scene, state.camera)
}

/** Keep the browser drawing while a variant is on screen. */
function loop() {
  requestAnimationFrame(loop)
  draw()
}

function select(key) {
  active = key
  const variant = VARIANTS[key]
  ensureEdges()
  variant.apply()
  // Materials changed: the next frame needs a fresh program.
  state.material.needsUpdate = true
  if (edges !== null) edges.material.needsUpdate = true
  showPanel()
}

function showPanel() {
  const variant = VARIANTS[active]
  const triangles = mesh === null ? 0 : (mesh.geometry.index === null
    ? mesh.geometry.getAttribute('position').count
    : mesh.geometry.index.count) / 3
  reportEl.innerHTML = [
    `<b>${active}</b> — ${variant.blurb}`,
    `面色 #${faceColor.toString(16).padStart(6, '0')}` +
      ` · 描边 ${{ face: '随面色', background: '随背景', balanced: '兼顾两者' }[edgeChoice] ?? edgeChoice}` +
      ` #${resolveEdgeColor().toString(16).padStart(6, '0')}` +

      ` · 配光 ${lightingName}` +
      ` · 结构线 ${LINE_WIDTH_PX.toFixed(1)}px 不透明`,
    `模型 <code>${stats.name}</code> · 三角面 <code>${Math.round(triangles).toLocaleString()}</code>` +
      ` · 结构线 <code>${Math.round(stats.segments).toLocaleString()}</code> 段` +
      `（阈值 ${effectiveThreshold()}° 固定 · 全量绘制，不做剔除）` +
      ` · 构建 <code>${stats.edgeMs.toFixed(0)}ms</code>`,
  ].join('<br>')
}

// ── UI ───────────────────────────────────────────────────────────────────────
/**
 * Wire a row of mutually exclusive buttons, keeping the current choice lit.
 *
 * Every row reports its own state through `isActive`, so what is selected is
 * always visible on the page rather than only in the panel text.
 *
 * @param container - the element to fill.
 * @param options - `{ label, value }` pairs.
 * @param onSelect - called with the chosen value.
 * @param isActive - whether a value is the current one.
 * @returns a resync function.
 */
function buttonGroup(container, options, onSelect, isActive) {
  const entries = options.map((option) => {
    const button = document.createElement('button')
    button.textContent = option.label
    button.onclick = () => {
      onSelect(option.value)
      syncAll()
    }
    container.appendChild(button)
    return { button, option }
  })
  const sync = () => {
    for (const { button, option } of entries) button.classList.toggle('active', isActive(option.value))
  }
  sync()
  return sync
}

/** Every group's resync function, so a change in one refreshes all of them. */
const groupSyncs = []
/** Refresh every button group's lit state. */
function syncAll() {
  for (const sync of groupSyncs) sync()
}

groupSyncs.push(buttonGroup(
  document.getElementById('variants'),
  [
    { label: 'current', value: 'current' },
    { label: 'ao+strong', value: 'ao+strong' },
    { label: 'lines', value: 'lines' },
  ],
  select,
  (value) => value === active,
))

const FACE_COLORS = [
  { label: '白', value: 0xf2f5f9 },
  // Warmth (R−B) sits between the first cool grey 0xd8dee8 (−16) and the warm
  // 0xdcded8 (+4), and the lightness matches the original to four decimals — so
  // only the hue moves, and the contrast the palette relies on is untouched.
  { label: '浅灰', value: 0xdadee2 },
  { label: '蓝灰', value: 0x8fa3bf },
]
groupSyncs.push(buttonGroup(
  document.getElementById('faces'),
  FACE_COLORS,
  (value) => {
    faceColor = value
    // The edge colour follows the fill, so the whole variant is re-applied.
    select(active)
  },
  (value) => value === faceColor,
))

groupSyncs.push(buttonGroup(
  document.getElementById('edges'),
  [
    { label: '随面色', value: 'face' },
    { label: '随背景', value: 'background' },
    { label: '兼顾两者', value: 'balanced' },
    { label: '深色', value: 'dark' },
    { label: '浅色', value: 'light' },
  ],
  (value) => {
    edgeChoice = value
    select(active)
  },
  (value) => value === edgeChoice,
))

groupSyncs.push(buttonGroup(
  document.getElementById('backgrounds'),
  [
    { label: '深色背景', value: '#14161b' },
    { label: '中灰背景', value: '#9aa0a8' },
    { label: '浅色背景', value: '#f4f6fa' },
  ],
  (value) => {
    backgroundChoice = value
    applyBackground()
    // The auto edge colour depends on the background when faces are hidden.
    select(active)
  },
  (value) => value === backgroundChoice,
))

applyBackground()

const ring = state.helpers.children.find((child) => child.geometry?.type === 'RingGeometry')
if (ring !== undefined) {
  groupSyncs.push(buttonGroup(
    document.getElementById('gridtoggles'),
    [
      { label: '网格：开', value: true },
      { label: '网格：关', value: false },
    ],
    (value) => {
      state.gridHelper.visible = value
      syncAll()
    },
    (value) => state.gridHelper.visible === value,
  ))
  groupSyncs.push(buttonGroup(
    document.getElementById('gridtoggles'),
    [
      { label: '原点环：开', value: true },
      { label: '原点环：关', value: false },
    ],
    (value) => {
      ring.visible = value
      syncAll()
    },
    (value) => ring.visible === value,
  ))
}

const modelSelect = document.getElementById('models')
for (const model of MODELS) {
  const option = document.createElement('option')
  option.value = model.url
  option.textContent = `${model.name} (${(model.bytes / 1024).toFixed(0)} KB)`
  modelSelect.appendChild(option)
}

/**
 * Install a mesh into the scene, build its edge overlay, and report the cost.
 *
 * @param geometry - the part's geometry.
 * @param name - label for the report panel.
 * @returns the cost figures the panel shows.
 */
function showModel(geometry, name) {
  if (mesh !== null) {
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }
  if (edges !== null) {
    edges.removeFromParent()
    edges.geometry.dispose()
    edges = null
  }
  geometry.computeVertexNormals()
  mesh = new THREE.Mesh(geometry, state.material)
  mesh.name = 'sample:mesh'
  // CAD files are Z-up; the viewer's rotation brings them upright on screen.
  const root = new THREE.Group()
  root.rotation.x = modelUpRotation(true)
  root.add(mesh)
  state.scene.add(root)
  state.mesh = root.children[0]

  const edgeMs = rebuildEdges()
  state.zUp = true
  state.fit()
  state.scene.updateMatrixWorld(true)

  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  modelRadius = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-3)
  const size = new THREE.Vector3()
  geometry.boundingBox.getSize(size)
  modelSpan = Math.max(size.x, size.y, size.z, 1e-3)
  updateClipPlanes()

  return {
    edgeMs,
    name,
    segments: edges === null ? 0 : edges.geometry.getAttribute('position').count / 2,
  }
}

/**
 * Parse a mesh file into geometry.
 *
 * Only mesh formats are needed here: the question is how the *surface* reads, and
 * a triangulated export of the same building exercises exactly the case that
 * looks unclear. (The plugin's own STEP path is untouched by this sampler.)
 *
 * @param buffer - the file bytes.
 * @returns the geometry.
 */
function parseMesh(buffer) {
  return new STLLoader().parse(buffer)
}

/** Load one model by URL and switch to it. */
async function loadModel(url) {
  const response = await fetch(url)
  const buffer = await response.arrayBuffer()
  const started = performance.now()
  const geometry = parseMesh(buffer)
  const parseMs = performance.now() - started
  const result = showModel(geometry, url.split('/').pop())
  stats = result
  stats.parseMs = parseMs
  select(active)
}

modelSelect.onchange = () => loadModel(modelSelect.value)

// Load the smallest model first so the page appears immediately.
try {
  const smallest = [...MODELS].sort((a, b) => a.bytes - b.bytes)[0]
  await loadModel(smallest.url)
  loop()
} catch (error) {
  fail(String(error?.message ?? error))
}
