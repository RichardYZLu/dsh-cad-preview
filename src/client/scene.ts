/**
 * The viewer's three.js scene: the orbit rig and the graph/controls it drives.
 *
 * This lives outside the component for a reason beyond tidiness: the scene
 * wiring holds the ordering that is easy to get wrong. `OrbitRig`'s constructor
 * ends with `update()`, which calls its onChange — it draws *while `new` is
 * still returning* — so every binding the first frame touches must already
 * exist. As a plain module the wiring can be executed in a headless test
 * (`test/wiring.mjs`) instead of only inspected.
 */
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js'
import { createAxisGizmo } from './gizmo'

/** CAD and mesh tools export with Z up; a graphics renderer wants Y up. */
export function modelUpRotation(zUp) {
  return zUp ? -Math.PI / 2 : 0
}

/**
 * Map one model-space vector into the viewer's screen space.
 *
 * @param vector - `{ x, y, z }` in the file's own coordinates.
 * @param zUp - whether the file is Z-up.
 * @returns `{ x, y, z }` as rendered.
 */
export function modelSpaceToScreen(vector, zUp) {
  if (!zUp) return { x: vector.x, y: vector.y, z: vector.z }
  const euler = new THREE.Euler(modelUpRotation(true), 0, 0)
  return new THREE.Vector3(vector.x, vector.y, vector.z).applyEuler(euler)
}

/**
 * Orbit / pan / dolly controls over an explicit target and camera.
 *
 * Written against the core three.js API only (no addons): orbit on the
 * primary button, pan on the secondary, dolly on the wheel, plus touch.
 */
export class OrbitRig {
  constructor(canvas, camera, onChange) {
    this.canvas = canvas
    this.camera = camera
    this.onChange = onChange
    this.target = new THREE.Vector3()
    this.radius = 10
    this.theta = Math.PI / 4
    this.phi = Math.PI / 3
    this.pointers = new Map()
    this.mode = null
    this.lastPinch = 0
    this.bind()
    this.update()
  }

  setView(target, radius, theta, phi) {
    this.target.copy(target)
    this.radius = radius
    this.theta = theta
    this.phi = phi
    this.update()
  }

  /**
   * Retarget and re-dolly without touching the viewing angle.
   *
   * That is the whole difference between the two toolbar actions: "适配" brings
   * everything into frame while leaving the direction the user looks from alone;
   * "重置" restores the canonical angle.
   *
   * @param target - new orbit centre.
   * @param radius - new distance.
   */
  setDistance(target, radius) {
    this.target.copy(target)
    this.radius = radius
    this.update()
  }

  bind() {
    const canvas = this.canvas
    this.onPointerDown = (event) => {
      canvas.setPointerCapture?.(event.pointerId)
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (this.pointers.size === 1) this.mode = event.button === 2 || event.shiftKey ? 'pan' : 'orbit'
      else if (this.pointers.size === 2) this.mode = 'touch'
      this.lastPinch = 0
    }
    this.onPointerMove = (event) => {
      const previous = this.pointers.get(event.pointerId)
      if (previous === undefined) return
      const dx = event.clientX - previous.x
      const dy = event.clientY - previous.y
      previous.x = event.clientX
      previous.y = event.clientY
      if (this.pointers.size === 2) return this.handlePinch()
      if (this.mode === 'pan') this.pan(dx, dy)
      else this.orbit(dx, dy)
    }
    this.onPointerUp = (event) => {
      this.pointers.delete(event.pointerId)
      if (this.pointers.size === 0) this.mode = null
      else if (this.pointers.size === 1) this.mode = 'orbit'
    }
    this.onWheel = (event) => {
      event.preventDefault()
      this.radius = clamp(this.radius * Math.exp(event.deltaY * 0.0012), this.minRadius, this.maxRadius)
      this.update()
    }
    this.onContextMenu = (event) => event.preventDefault()

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  handlePinch() {
    const [a, b] = [...this.pointers.values()]
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (this.lastPinch === 0) {
      this.lastPinch = distance
      return
    }
    const ratio = this.lastPinch / Math.max(1, distance)
    this.lastPinch = distance
    this.radius = clamp(this.radius * ratio, this.minRadius, this.maxRadius)
    this.update()
  }

  orbit(dx, dy) {
    this.theta -= dx * 0.006
    this.phi = clamp(this.phi - dy * 0.006, 0.0001, Math.PI - 0.0001)
    this.update()
  }

  pan(dx, dy) {
    const camera = this.camera
    const distance = this.radius
    const height = 2 * Math.tan((camera.fov * Math.PI) / 360) * distance
    const width = height * camera.aspect
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
    this.target.addScaledVector(right, (-dx * width) / this.canvas.clientWidth)
    this.target.addScaledVector(up, (dy * height) / this.canvas.clientHeight)
    this.update()
  }

  update() {
    const sinPhi = Math.sin(this.phi)
    this.camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    )
    this.camera.lookAt(this.target)
    this.camera.updateMatrixWorld()
    this.onChange?.()
  }

  dispose() {
    const canvas = this.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.pointers.clear()
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Default fill, chosen in the sampler: 浅灰, warmed slightly from the old grey. */
const FACE_COLOR = 0xdadee2

/** Edge colours, dark to light. Which one is used follows the GUI background. */
const EDGE_DARK = 0x0d1117
const EDGE_LIGHT = 0xdfe7f5

/** Edge width in pixels, and why it cannot be 1-with-antialiasing: a 1-pixel line
 * covers proportionally less of a larger model, so its apparent weight — and with
 * MSAA its colour — shifts with zoom. A pixel width keeps it constant. */
const EDGE_WIDTH_PX = 1.0

/** Structural-edge extraction angle per appearance. See `setAppearance`. */
const EDGE_THRESHOLD = { shaded: 30, lines: 1 }

/** Relative luminance of a packed colour, 0 (black) to 1 (white). */
function luminance(hex) {
  const r = ((hex >> 16) & 0xff) / 255
  const g = ((hex >> 8) & 0xff) / 255
  const b = (hex & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Bounds of a model root's **geometry**, helper subtrees excluded.
 *
 * World space is the one frame both the framing and the grid agree on; mixing it
 * with a parent-local offset is what left the model floating and off-centre.
 *
 * The helpers are model-frame objects, so they must never feed back into the box
 * that decides where the model is centred: a grid as large as the model folded
 * into that calculation is what made fit() drift and pushed the plane off the
 * model's z = 0 ground. The exclusion has to be subtree-wide — the group carries
 * the mark, but the meshes inside it are what a naive walk would measure.
 *
 * @param root - the model root (one mesh, or a group carrying several).
 *   instead of world space.
 * @returns an empty box when the root carries no geometry yet.
 */
function modelBounds(root) {
  const box = new THREE.Box3()
  const meshBox = new THREE.Box3()
  const visit = (node) => {
    if (node.userData.helper === true) return
    if (node.isMesh === true) {
      const geometry = node.geometry
      if (geometry !== undefined) {
        if (geometry.boundingBox === null) geometry.computeBoundingBox()
        meshBox.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld)
        box.union(meshBox)
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return box
}

/**
 * World position of the model's own z = 0 plane after the viewer placed it.
 *
 * The model root carries the geometry centre and the up-rotation, so the file's
 * ground plane is not at any single box corner. For the CAD convention it is the
 * plane the model was grounded on (the near face on the vertical axis); for a
 * Y-up file it is the geometry's own local z = 0, which needs the local box.
 *
 * @param mesh - the model root.
 * @param worldBox - its bounds after placement, in world space.
 * @param zUp - whether the file was treated as Z-up.
 * @returns the point the grid must be centred on.
 */
function modelGroundWorld(mesh, worldBox, zUp) {
  const footprint = new THREE.Vector3(0, 0, 0)
  if (zUp) {
    // Grounded on the vertical axis, centred on the other two.
    footprint.y = worldBox.min.y
  } else {
    const geometry = mesh.geometry
    if (geometry !== undefined && geometry.boundingBox === null) geometry.computeBoundingBox()
    const local = geometry?.boundingBox?.min?.z
    footprint.z = Number.isFinite(local) ? local : 0
  }
  return footprint
}

/**
 * Move a model root so its geometry satisfies a world-space goal.
 *
 * Both goals are stated in world space because that is where the camera and the
 * grid live: centre the footprint horizontally, and put the model's own
 * z = 0 plane on the world origin's ground. The delta is then converted into the
 * parent's frame with its inverse — applying a world delta directly to a rotated
 * root would rotate it a second time.
 *
 * @param mesh - the model root.
 * @param ground - world position the model's z = 0 plane should land on.
 * @param centerXZ - whether to centre the footprint on the world origin.
 * @returns the world-space bounds after the move.
 */
function settlePlacement(mesh, centerXZ, ground) {
  const parent = mesh.parent
  const base = mesh.position.clone()
  const measure = () => {
    mesh.updateMatrixWorld(true)
    if (parent !== null) parent.updateMatrixWorld(true)
    return modelBounds(mesh)
  }
  let box = measure()
  if (box.isEmpty()) return box

  const center = box.getCenter(new THREE.Vector3())
  const origin = mesh.getWorldPosition(new THREE.Vector3())
  const delta = new THREE.Vector3(
    centerXZ ? -center.x : 0,
    // Grounding drops the model onto the world origin's ground plane, which is
    // where the grid is; without it the model floats half its height up.
    ground ? -box.min.y : -origin.y,
    centerXZ ? -center.z : 0,
  )
  if (parent !== null) {
    parent.updateMatrixWorld(true)
    delta.applyMatrix4(new THREE.Matrix4().extractRotation(parent.matrixWorld).invert())
  }
  mesh.position.copy(base).add(delta)
  box = measure()
  return box
}

/**
 * The model's z = 0 plane, expressed in the root's own frame.
 *
 * A CAD file's ground is z = 0 in *its* coordinates, which is not any corner of
 * the bounding box once the root is rotated. Taking the plane's footprint centre
 * (x/z of the box) and grounding it on the box's near face gives a point that
 * must be moved onto the world origin.
 *
 * @param box - the model's bounds in its own frame.
 * @returns the point on the z = 0 plane to place at the world origin.
 */
function modelGroundPoint(box) {
  const center = box.getCenter(new THREE.Vector3())
  return new THREE.Vector3(center.x, box.min.y, center.z)
}

/**
 * Build the renderer, scene, orbit rig, helpers and gizmo for one canvas.
 *
 * @param canvas - the viewer's own canvas element.
 * @returns the scene state the component drives (`fit`, `resize`, `dispose`, …).
 */
export function createViewerScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  // Lighting is what makes geometry readable: an ambient light turned up near 1
  // washes every surface to the same tone, so corners, recesses and the
  // difference between a wall and a floor all vanish. Keep ambient low and let
  // the directional lights carry the shading.
  // The "contrast" preset: ambient kept low so the directional lights carry the
  // shading. A bright ambient washes every orientation to the same tone, which is
  // what makes a model of hundreds of blocks unreadable.
  scene.add(new THREE.AmbientLight(0xffffff, 0.1))
  // A little warm/cool separation so neighbouring faces do not read as one mass.
  scene.add(new THREE.HemisphereLight(0xdfe7f5, 0x2a2f38, 0.18))
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(3, 5, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.22)
  fill.position.set(-4, -1.5, -3)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xc8d4e8, 0.18)
  rim.position.set(0, -4, 2)
  scene.add(rim)

  // 浅灰 #dadee2, chosen in the sampler as the default fill.
  const material = new THREE.MeshStandardMaterial({
    color: FACE_COLOR,
    metalness: 0.0,
    roughness: 0.85,
    flatShading: false,
  })

  // Structural edges: a shaded surface with no line work reads as a blob once a
  // model has hundreds of small blocks, and a full wireframe is useless — it draws
  // every triangle of a tessellated CAD part. Drawing *only* the edges where the
  // surface actually turns is what makes the block structure legible.
  //
  // Fat lines rather than GL_LINES, for two reasons: a pixel-measured width keeps
  // the drawing's weight constant as the camera zooms (a 1-pixel line looks
  // progressively fainter on a larger model), and being instanced quads they do
  // respond to `polygonOffset`, which GL_LINES does not — so the depth fight with
  // the surface underneath is settled by the standard mechanism.
  let edges = null
  /** The model root currently installed in the scene. */
  let currentMesh = null
  /** Which appearance is in force: `shaded` (default) or `lines`. */
  let appearance = 'shaded'

  /** Edge colour, chosen against the GUI background. */
  let edgeColor = EDGE_LIGHT

  /**
   * Tint the grid and colour the edges to suit the surface behind the canvas.
   *
   * The viewer sits on the app's own background, which follows the GUI theme, so
   * the drawing has to be checked against *that* rather than an assumed dark
   * backdrop. `GridHelper` draws with vertex colours and `material.color`
   * multiplies them, so the tint can only darken the grid — which is exactly what
   * a light background needs.
   */
  function applyPalette() {
    const background = detectBackgroundLuminance()
    const onDark = background < 0.5
    edgeColor = onDark ? EDGE_LIGHT : EDGE_DARK
    if (edges !== null) {
      edges.material.color.set(edgeColor)
      edges.material.needsUpdate = true
    }
    gridHelper.material.color.set(onDark ? 0xffffff : 0x4a5262)
    gridHelper.material.needsUpdate = true
  }

  /**
   * Luminance of the first opaque background found above the canvas.
   *
   * Walking the ancestors is what makes "follow the GUI" work without a theme
   * API: whatever the app paints behind the viewer is what the lines must read
   * against.
   *
   * @returns the luminance, defaulting to dark when nothing is found.
   */
  function detectBackgroundLuminance() {
    let node = canvas
    while (node !== null && node !== undefined) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null
      const parsed = parseColor(style?.backgroundColor ?? '')
      if (parsed !== null) return luminance(parsed)
      node = node.parentElement
    }
    return 0.1
  }

  /**
   * Parse `rgb()` / `rgba()` / `#rrggbb` into a packed colour.
   *
   * @param css - the computed colour string.
   * @returns the packed colour, or null when transparent or unparsable.
   */
  function parseColor(css) {
    const text = String(css).trim()
    if (text === '' || text === 'transparent') return null
    const hex = /^#([0-9a-f]{6})$/i.exec(text)
    if (hex !== null) return Number.parseInt(hex[1], 16)
    const parts = /^rgba?\(([^)]+)\)$/.exec(text)
    if (parts === null) return null
    const values = parts[1].split(',').map((value) => Number.parseFloat(value))
    if (values.length < 3 || values.some((value) => Number.isNaN(value))) return null
    if (values.length === 4 && values[3] === 0) return null
    return (Math.round(values[0]) << 16) | (Math.round(values[1]) << 8) | Math.round(values[2])
  }

  /**
   * Rebuild the edge overlay for a model at the current appearance's angle.
   *
   * @param mesh - the model root, or null to drop the overlay.
   */
  function rebuildEdges(mesh) {
    if (edges !== null) {
      edges.removeFromParent()
      edges.geometry.dispose()
      edges.material.dispose()
      edges = null
    }
    if (mesh === null || mesh.geometry === undefined) return
    const raw = new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD[appearance])
    if (raw.getAttribute('position').count === 0) {
      raw.dispose()
      return
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(raw.getAttribute('position').array)
    raw.dispose()
    const material = new LineMaterial({
      color: edgeColor,
      linewidth: EDGE_WIDTH_PX,
      worldUnits: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    edges = new LineSegments2(geometry, material)
    edges.userData.helper = true
    edges.frustumCulled = false
    mesh.add(edges)
    syncEdgeResolution()
  }

  // The palette follows the app's background, so it has to be re-checked when the
  // theme changes. Both signals are cheap and cover the ways a GUI switches: the
  // OS colour scheme, and a class/attribute on the document element.
  const themeQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const onThemeChange = () => applyPalette()
  themeQuery?.addEventListener?.('change', onThemeChange)
  const themeObserver =
    typeof MutationObserver === 'function' && typeof document !== 'undefined'
      ? new MutationObserver(onThemeChange)
      : null
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  })

  /** Keep the fat-line viewport in step so a pixel width means a pixel. */
  function syncEdgeResolution() {
    if (edges === null) return
    edges.material.resolution.set(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight))
    edges.material.needsUpdate = true
  }

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000)
  camera.position.set(6, 5, 8)

  // The grid and the axis cross live in the *model's* frame, as children of the
  // model root. The viewer rotates that root into screen space, so a grid built
  // in model coordinates lands on the model's own ground plane by construction
  // rather than by bounding-box arithmetic in world space. Nothing is added to
  // the scene until a model exists (see `fit`), so an empty viewer shows no
  // stray grid.
  // The helpers are scene-level, deliberately: keeping them out of the model's
  // subtree is what stops a model-sized grid from being measured as part of the
  // model (that feedback made fit() drift and pushed the plane off the ground).
  const helpers = new THREE.Group()
  helpers.userData.helper = true
  scene.add(helpers)
  // The grid is built horizontal in world space, once and for all: a
  // GridHelper draws in its local XY plane, so a -90° X rotation puts it on the
  // ground. Keeping that constant here removes any dependence on the model's own
  // orientation, and the fit below only has to place it.
  //
  // Orientation, and why it is easy to get backwards: `GridHelper` builds its
  // lines in the local XY plane at y = 0 — it is *already* horizontal, so it
  // takes no rotation at all, while `RingGeometry` builds in that same plane as
  // a *vertical* disc and needs the -90° X rotation. Applying one convention to
  // both stands exactly one of them up as a wall, which is the bug this file
  // carried for several rounds.
  const gridHelper = new THREE.GridHelper(1, 24, 0x9aa4b2, 0xd7dbe2)
  gridHelper.userData.helper = true
  gridHelper.material.transparent = true
  gridHelper.material.opacity = 0.45
  gridHelper.material.depthWrite = false
  helpers.add(gridHelper)

  // A flat ring plus the three coloured axis lines would double up with the
  // gizmo; a subtle ring reads as "the origin" without competing.
  const originRing = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.42, 48),
    new THREE.MeshBasicMaterial({ color: 0x4d6bfe, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  )
  originRing.userData.helper = true
  // Kept horizontal (`RingGeometry` is built vertical, hence the -90°), because
  // a CAD file's origin sits on its z = 0 ground plane.
  originRing.rotation.x = -Math.PI / 2
  originRing.visible = false
  helpers.add(originRing)
  const axes = originRing

  const placeholder = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.32, 128, 24),
    new THREE.MeshStandardMaterial({ color: 0x4d6bfe, wireframe: true, transparent: true, opacity: 0.35 }),
  )
  scene.add(placeholder)

  const gizmo = createAxisGizmo()
  canvas.parentElement?.appendChild(gizmo.canvas)

  // Declared before anything that can draw: `OrbitRig`'s constructor ends with
  // `update()`, which calls its onChange — i.e. it draws *while `new` is still
  // returning*. Anything the frame path touches must already be initialised,
  // and the rig binding deliberately is not (hence no `rig` below).
  const cameraTarget = new THREE.Vector3()
  /** World position of the model's z = 0 plane, for the grid. */
  const groundWorld = new THREE.Vector3()
  /** World position of the model's own origin — (0,0,0) in the file. */
  const modelOriginWorld = new THREE.Vector3()
  /** The model's world bounds: measured on placement, reused when re-framing. */
  const modelBox = new THREE.Box3()
  /** The model's up axis in world space; the gizmo draws its roll from this. */
  /**
   * The model's up axis in world space, one vector so the frame path allocates
   * nothing. The viewer rotates Z-up files by -90° about X, so their own up
   * (model +Z) becomes world +Y — which is what keeps the gizmo's vertical
   * arrow on screen-up.
   */
  const modelUpWorld = new THREE.Vector3(0, 1, 0)

  // Depth precision. The camera used to ship a fixed 0.01..100000 pair — a 10^7
  // ratio — which at building scale leaves ~9 metres of depth resolving power, so
  // every joint between parts z-fights and the surfaces shimmer while it moves.
  // Fitting the planes to the camera distance recovers five orders of magnitude.
  //
  // `near` must stay *inside* the model's front surface: scaling it with the model
  // radius instead makes it larger than the camera-to-surface gap as soon as the
  // camera moves in, and the near plane slices the model open.
  let modelRadius = 1

  /** Fit the clip planes to the current camera distance. */
  const updateClipPlanes = () => {
    const distance = camera.position.distanceTo(cameraTarget)
    camera.near = Math.max(distance * 0.002, 1e-4)
    camera.far = distance + modelRadius * 6
    camera.updateProjectionMatrix()
  }

  // Ambient occlusion, on by default: it darkens the crevices where hundreds of
  // parts meet, which is the cue that separates a stack of blocks from a blob.
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const ssao = new SSAOPass(scene, camera, 1024, 1024)
  ssao.kernelRadius = 12
  ssao.minDistance = 0.002
  ssao.maxDistance = 0.12
  composer.addPass(ssao)
  composer.addPass(new OutputPass())

  /** The one place a frame is drawn, so the gizmo can never drift out of sync. */
  const frame = () => {
    updateClipPlanes()
    if (appearance === 'shaded') composer.render()
    else renderer.render(scene, camera)
    gizmo.render(camera, cameraTarget, modelUpWorld)
  }

  const draw = () => frame()

  const rig = new OrbitRig(canvas, camera, draw)
  rig.onChange = () => {
    cameraTarget.copy(rig.target)
    frame()
  }
  camera.aspect = 1

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    composer.setSize(width, height)
    ssao.setSize(width, height)
    syncEdgeResolution()
    gizmo.resize()
    cameraTarget.copy(rig.target)
    frame()
  }
  resize()
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
  observer?.observe(canvas)

  const state = {
    scene,
    camera,
    renderer,
    rig,
    material,
    helpers,
    placeholder,
    gridHelper,
    axes,
    gizmo,
    /**
     * The loaded model root.
     *
     * Assigned through the setter below so the structural-edge overlay is
     * rebuilt in the same step — impossible to forget to call, and the old
     * overlay is disposed rather than left parented to a removed mesh.
     */
    get mesh() {
      return currentMesh
    },
    set mesh(next) {
      currentMesh = next
      // Fit the clip planes to the model, and remember the surfaces' visibility
      // for the appearance in force (the mesh may arrive while `lines` is on).
      if (next === null || next.geometry === undefined) {
        modelRadius = 1
      } else {
        next.geometry.computeBoundingSphere()
        modelRadius = Math.max(next.geometry.boundingSphere?.radius ?? 1, 1e-3)
      }
      material.visible = appearance === 'shaded'
      rebuildEdges(next)
      applyPalette()
    },
    /** Whether the loaded model is treated as Z-up (CAD convention). */
    zUp: true,
    resize,
    /**
     * Switch between the shaded view and the line drawing.
     *
     * `lines` is what the toolbar's "线框" action means here: the surfaces go away
     * and the extraction drops to 1°, which is the angle that keeps a cylinder's
     * facets (a 24-sided one turns 15° per facet, so 30° would erase it) while
     * flat block faces still contribute nothing.
     *
     * @param next - `shaded` or `lines`.
     */
    setAppearance(next) {
      const wanted = next === 'lines' ? 'lines' : 'shaded'
      if (wanted === appearance) return
      appearance = wanted
      material.visible = wanted === 'shaded'
      if (this.mesh !== null) rebuildEdges(this.mesh)
      applyPalette()
      frame()
    },

    /** Which appearance is in force. */
    get appearance() {
      return appearance
    },

    /**
     * Place the model and its helpers, and measure it.
     *
     * A one-time job per load and per up-axis change — it must NOT run for a
     * re-frame, or the canonical 3/4 angle would be applied silently behind the
     * user's back.
     *
     * @returns the model's world bounds (a placeholder box when none is loaded).
     */
    place() {
      modelUpWorld.set(0, 1, 0)
      gizmo.setModelRotation(modelUpRotation(this.zUp === true))
      const box = new THREE.Box3()
      if (this.mesh) {
        box.copy(settlePlacement(this.mesh, true, true))
        if (!box.isEmpty()) {
          const centre = box.getCenter(new THREE.Vector3())
          groundWorld.set(centre.x, box.min.y, centre.z)
          this.mesh.updateMatrixWorld(true)
          modelOriginWorld.copy(this.mesh.getWorldPosition(new THREE.Vector3()))
        }
      }
      if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(4, 4, 4))
      if (this.mesh !== null) {
        const span = 1.02 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
        const safeSpan = Number.isFinite(span) && span > 1e-6 ? span : 1
        gridHelper.scale.setScalar(safeSpan)
        axes.scale.setScalar(safeSpan * 0.08)
        axes.visible = true
        helpers.rotation.set(0, 0, 0)
        helpers.position.copy(groundWorld)
        axes.position.copy(modelOriginWorld).sub(groundWorld)
      } else {
        gridHelper.scale.setScalar(10)
        axes.visible = false
        axes.position.set(0, 0, 0)
        helpers.rotation.set(0, 0, 0)
        helpers.position.set(0, 0, 0)
      }
      helpers.updateMatrixWorld(true)
      applyPalette()
      updateClipPlanes()
      modelBox.copy(box)
      return box
    },

    /**
     * Bring the whole model into frame WITHOUT touching the viewing angle.
     *
     * The toolbar's "适配": keep theta/phi, aim at the model's volume centre, and
     * choose the distance that fits its bounding sphere into the narrower of the
     * two frustum dimensions, with a small margin.
     *
     * @param margin - multiplier on the fitted distance.
     */
    frameAll(margin = 1.12) {
      const box = this.mesh === null ? this.place() : modelBox
      const focus = box.getCenter(new THREE.Vector3())
      cameraTarget.copy(focus)
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const radius = Math.max(sphere.radius, 1e-3)
      const vertical = (this.camera.fov * Math.PI) / 180
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(this.camera.aspect, 1e-3))
      const fitDistance = radius / Math.sin(Math.min(vertical, horizontal) / 2)
      rig.minRadius = Math.max(radius * 0.05, 1e-4)
      rig.maxRadius = Math.max(radius * 400, 100)
      rig.setDistance(cameraTarget, Math.max(fitDistance * margin, radius * 0.1))
      this.resize()
    },

    /**
     * Put everything back to how the file first appeared: re-centre and re-ground
     * the model, fit it into the frame, and return to the canonical 3/4 view.
     *
     * This is the full reset — "适配" is the one that only changes the distance.
     */
    resetView() {
      // Placement is idempotent by design (the placement tests call it three
      // times in a row), so re-running it is what brings a model the user
      // dragged out of position back to the middle.
      this.place()
      this.frameAll(1.12)
      rig.setView(cameraTarget, rig.radius, Math.PI / 4, (55 * Math.PI) / 180)
      this.resize()
    },

    /**
     * Full initial framing: place the model, then adopt the canonical 3/4 view.
     * Used when a model is first shown and when the up-axis changes.
     */
    fit() {
      this.place()
      this.frameAll(1.12)
      rig.setView(cameraTarget, rig.radius, Math.PI / 4, (55 * Math.PI) / 180)
      this.resize()
    },

    dispose() {
      observer?.disconnect()
      rig.dispose()
      gizmo.dispose()
      gizmo.canvas.remove()
      if (edges !== null) {
        edges.removeFromParent()
        edges.geometry.dispose()
        edges.material.dispose()
        edges = null
      }
      themeQuery?.removeEventListener?.('change', onThemeChange)
      themeObserver?.disconnect()
      ssao.dispose?.()
      composer.dispose?.()
      if (this.mesh) {
        this.mesh.geometry.dispose()
        this.mesh.remove(helpers)
        scene.remove(this.mesh)
      }
      placeholder.geometry.dispose()
      placeholder.material.dispose()
      material.dispose()
      gridHelper.geometry.dispose()
      gridHelper.material.dispose()
      axes.geometry.dispose()
      axes.material.dispose()
      renderer.dispose()
    },
  }

  return state
}
