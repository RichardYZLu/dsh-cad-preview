/**
 * Headless check for the orientation gizmo.
 *
 * The gizmo only needs a DOM and a WebGL context, not a real renderer, so it
 * bundles for Node against a minimal stub of both.
 *
 * Scope, deliberately: this checks the DOM contract (placed, click-through,
 * disposed) and that the per-frame camera mirroring is safe to call. The arrow
 * *directions* are covered where they are decided — `modelSpaceToScreen` in the
 * smoke test — and the actual pixels need a browser, because rasterising with
 * three.js would mean mocking most of the WebGL feature probe.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// ── a DOM just good enough for a WebGLRenderer ───────────────────────────────

const makeContext2d = () => ({
  font: '',
  textAlign: '',
  textBaseline: '',
  fillStyle: '',
  fillText() {},
  clearRect() {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData() {},
  drawImage() {},
})

/** GL constants three.js reads back have to be numbers; everything else is a stub. */
const makeGl = () => {
  const base = {
    canvas: null,
    drawingBufferWidth: 64,
    drawingBufferHeight: 64,
    getExtension: () => null,
    // three.js calls `getParameter(...)` for capability *strings* and compares
    // them with `indexOf`, and for a few numeric limits. Constant keys cannot
    // be told apart through this stub (the proxy answers `gl.VERSION` with a
    // number), so the value has to satisfy both: a numeric string works for
    // every comparison three.js performs here.
    getParameter: (parameter) => {
      // VIEWPORT / SCISSOR_BOX are read as arrays.
      if (parameter === 0x0ba2 || parameter === 0x0c10) return [0, 0, 64, 64]
      return '8'
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    getContextAttributes: () => ({ alpha: true, antialias: true }),
    isContextLost: () => false,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    getError: () => 0,
    checkFramebufferStatus: () => 36053,
    readPixels: () => undefined,
  }
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key]
      if (typeof key !== 'string') return undefined
      // Anything three.js *calls* becomes a no-op returning a plausible value;
      // anything it merely passes around (constants) becomes a number.
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return 1
      return () => ({})
    },
    has: () => true,
  })
}

/**
 * Install the DOM/WebGL stubs on `globalThis`.
 *
 * @returns a disposer restoring the previous globals.
 */
function installDom() {
  const saved = new Map()
  const put = (key, value) => {
    saved.set(key, globalThis[key])
    try {
      globalThis[key] = value
    } catch {
      // Node exposes some of these (navigator) as getter-only globals.
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
  }
  const makeCanvas = () => {
    const canvas = {
      width: 64,
      height: 64,
      clientWidth: 78,
      clientHeight: 78,
      style: {},
      className: '',
      setAttribute() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {},
      getContext: (kind) => (kind === '2d' ? makeContext2d() : makeGl()),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 78, height: 78 }),
      parentElement: null,
      appendChild() {},
    }
    return canvas
  }
  const body = {
    appendChild() {},
    removeChild() {},
    querySelectorAll: () => [],
    dataset: {},
  }
  const element = {
    appendChild() {},
    removeChild() {},
    style: {},
    setAttribute() {},
    classList: { add() {}, remove() {} },
  }
  put('window', {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  put('document', {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { ...element, tagName: tag }),
    createElementNS: () => makeCanvas(),
    head: element,
    body,
    documentElement: body,
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  })
  put('self', globalThis.window)
  put('navigator', { userAgent: 'node' })
  put('requestAnimationFrame', (fn) => setTimeout(fn, 0))
  put('cancelAnimationFrame', (id) => clearTimeout(id))
  return () => {
    for (const [key, value] of saved) {
      try {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      } catch {
        // best effort: the stub is process-wide and the test exits anyway
      }
    }
  }
}

const restoreDom = installDom()

const workDir = mkdtempSync(join(tmpdir(), 'cadpv-gizmo-'))
const entry = join(workDir, 'gizmo-entry.mjs')

try {
  const bundle = await build({
    entryPoints: [join(root, 'src', 'client', 'gizmo.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['three', 'three/examples/jsm/*'],
    write: false,
    logLevel: 'silent',
  })
  // `three` resolves from this package at test time, not from the temp dir.
  const source = bundle.outputFiles[0].text
    .replace(
      /from\s*"three"/g,
      `from ${JSON.stringify(join(root, 'node_modules', 'three', 'build', 'three.module.js'))}`,
    )
    // The vendored addons are imported by absolute path: Node then resolves their
    // own `three` import through the repo's node_modules, so one instance is used.
    .replace(
      /from\s*"three\/examples\/jsm\/([^"]+)"/g,
      (_match, relative) => `from ${JSON.stringify(join(root, 'vendor', 'three', 'examples', 'jsm', relative))}`,
    )
  writeFileSync(entry, source)

  const THREE = await import(join(root, 'node_modules', 'three', 'build', 'three.module.js'))
  const { createAxisGizmo, placeGizmoCamera } = await import(entry)

  let passed = 0
  let failed = 0
  const check = (name, fn) => {
    try {
      fn()
      passed += 1
      console.log(`  ok   ${name}`)
    } catch (error) {
      failed += 1
      console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
    }
  }

  check('createAxisGizmo builds a positioned canvas and the view API', () => {
    const gizmo = createAxisGizmo()
    assert.equal(typeof gizmo.render, 'function')
    assert.equal(typeof gizmo.resize, 'function')
    assert.equal(typeof gizmo.dispose, 'function')
    assert.equal(gizmo.canvas.style.position, 'absolute')
    assert.equal(gizmo.canvas.style.right, '6px')
    assert.equal(gizmo.canvas.style.bottom, '6px')
    assert.equal(gizmo.canvas.style.pointerEvents, 'none')
    gizmo.dispose()
  })

  check('the gizmo camera sits on the main view direction at the fixed distance', () => {
    const main = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    main.position.set(10, 5, 10)
    main.lookAt(0, 0, 0)
    main.updateMatrixWorld(true)

    const gizmoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    placeGizmoCamera(gizmoCamera, main, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 4)

    const mainDir = main.position.clone().normalize()
    const gizmoDir = gizmoCamera.position.clone().normalize()
    assert.ok(mainDir.distanceTo(gizmoDir) < 1e-9, 'gizmo must sit on the same view direction')
    assert.ok(Math.abs(gizmoCamera.position.length() - 4) < 1e-9, 'at the fixed distance')
  })

  check('the model up axis reads as canvas-up in the gizmo, from any orbit angle', () => {
    // The reported bug: the vertical arrow did not read as up. The invariant
    // that fixes it, and that a pixel test would have to agree with: the model's
    // up axis projects onto the gizmo canvas' vertical (x ≈ 0) pointing up, for
    // every orbit position. When the view looks straight down that axis it
    // projects to the centre, where its screen direction is undefined.
    //
    // Deliberately not asserted: that the other two axes stay horizontal — from
    // a raised camera they legitimately project downwards, which is ordinary
    // foreshortening rather than a roll error.
    const gizmoCamera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 100)
    const main = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    const up = new THREE.Vector3(0, 1, 0)
    const positions = [
      new THREE.Vector3(0, 0, 30),
      new THREE.Vector3(30, 0, 0.001),
      new THREE.Vector3(-30, 0, 0.001),
      new THREE.Vector3(0.001, 0, -30),
      new THREE.Vector3(20, 12, 18),
      new THREE.Vector3(-15, -9, 21),
      new THREE.Vector3(0, 30, 0.001),
      new THREE.Vector3(0, -30, 0.001),
      new THREE.Vector3(11, 26, 9),
    ]

    for (const position of positions) {
      main.position.copy(position)
      main.lookAt(0, 0, 0)
      main.updateMatrixWorld(true)
      placeGizmoCamera(gizmoCamera, main, new THREE.Vector3(0, 0, 0), up, 4)
      gizmoCamera.updateMatrixWorld(true)

      const projected = up.clone().project(gizmoCamera)
      const at = position.toArray().join(',')
      const degenerate = Math.abs(projected.x) < 1e-6 && Math.abs(projected.y) < 1e-6
      if (degenerate) continue
      assert.ok(
        Math.abs(projected.x) < 1e-6,
        `model up must sit on the canvas vertical at ${at}, got x=${projected.x}`,
      )
      assert.ok(projected.y > 0, `model up must point up the canvas at ${at}, got y=${projected.y}`)
    }
  })

  check('with a Z-up model stood upright, the blue Z arrow points up the canvas', () => {
    // The model's own rotation puts its +Z (CAD up) on world +Y; the gizmo has
    // to inherit that, otherwise it renders the un-rotated frame and Z reads as
    // horizontal. This is the exact complaint that prompted the change.
    const gizmo = createAxisGizmo()
    const main = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    main.position.set(0, 0, 30)
    main.lookAt(0, 0, 0)
    main.updateMatrixWorld(true)

    const rotated = new THREE.Group()
    rotated.rotation.x = -Math.PI / 2 // what the viewer does to a Z-up model
    gizmo.setModelRotation(rotated.rotation.x)

    // The gizmo's arrows now point along the rotated basis: blue Z ends up on
    // world +Y, which the gizmo camera (up = +Y) shows as canvas-up.
    const blueDirection = new THREE.Vector3(0, 0, 1).applyEuler(rotated.rotation)
    assert.ok(Math.abs(blueDirection.y - 1) < 1e-9, 'the Z arrow must end up on world +Y')

    const gizmoCamera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 100)
    placeGizmoCamera(gizmoCamera, main, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 4)
    gizmoCamera.updateMatrixWorld(true)
    const projected = blueDirection.clone().project(gizmoCamera)
    assert.ok(Math.abs(projected.x) < 1e-6 && projected.y > 0.3, `blue Z should read as up, got ${projected.toArray()}`)
    gizmo.dispose()
  })

  check('a degenerate view (camera on the target) still yields a usable placement', () => {
    const main = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    main.position.set(0, 0, 0)
    main.updateMatrixWorld(true)
    const gizmoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    placeGizmoCamera(gizmoCamera, main, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 4)
    assert.ok(Math.abs(gizmoCamera.position.length() - 4) < 1e-9)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
  restoreDom()
}
