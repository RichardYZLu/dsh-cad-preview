/**
 * Wiring test: execute the scene setup for real, headless.
 *
 * This is the test the earlier failure deserved. `OrbitRig`'s constructor ends
 * with `update()`, which calls its onChange — it draws *while `new` is still
 * returning* — so any binding the first frame touches must already be
 * initialised. Reading the source would not have caught that; calling
 * `createViewerScene(canvas)` does, because that constructor really runs.
 *
 * What is deliberately out of scope: actual rasterisation. The GL context is a
 * stub that answers three.js's capability probes, so `render()` is a no-op. The
 * arrows' directions are covered where they are decided (`scene.ts` mapping,
 * asserted in the smoke test) and the gizmo's camera contract in test/gizmo.mjs.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installDom, makeCanvas } from './support/dom-stub.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

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

const dom = installDom()
const workDir = mkdtempSync(join(tmpdir(), 'cadpv-wiring-'))
const entry = join(workDir, 'scene-entry.mjs')

try {
  const bundle = await build({
    entryPoints: [join(root, 'src', 'client', 'scene.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    write: false,
    logLevel: 'silent',
    external: ['three', 'three/examples/jsm/*'],
  })
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
  const scene = await import(pathToFileURL(entry).href)
  const THREE = await import(join(root, 'node_modules', 'three', 'build', 'three.module.js'))

  /** A canvas with a parent, so the gizmo's appendChild has somewhere to land. */
  const makeHost = () => {
    const canvas = makeCanvas()
    const parent = {
      children: [],
      appendChild(child) {
        parent.children.push(child)
      },
    }
    canvas.parentElement = parent
    return { canvas, parent }
  }

  check('createViewerScene survives the orbit rig drawing from inside its own constructor', () => {
    const host = makeHost()
    // The failure this covers: "Cannot access 'rig' before initialization",
    // thrown by the first draw because OrbitRig's constructor calls onChange
    // before `new` returns.
    const state = scene.createViewerScene(host.canvas)
    assert.equal(typeof state.fit, 'function')
    assert.equal(typeof state.resize, 'function')
    assert.equal(typeof state.dispose, 'function')
    assert.equal(typeof state.rig.setView, 'function')
    state.dispose()
  })

  check('the gizmo canvas is mounted into, and removed from, the viewer container', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    assert.equal(host.parent.children.length, 1, 'the gizmo canvas should be appended once')
    assert.equal(state.gizmo.canvas.style.position, 'absolute')
    state.dispose()
  })

  check('fit() and resize() are safe with no model loaded yet', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    assert.equal(state.mesh, null)
    assert.doesNotThrow(() => state.fit())
    assert.doesNotThrow(() => state.resize())
    state.dispose()
  })

  check('an up-orientation change is safe to apply to a live scene', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    state.zUp = false
    assert.doesNotThrow(() => state.fit())
    assert.equal(typeof scene.modelUpRotation(false), 'number')
    state.dispose()
  })

  check('fit() centres and grounds the model, and the grid lands on z = 0', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)

    // The reported file's shape and axis layout: 12095 × 14160 footprint on the
    // file's x/y, 5900 of height on the file's z (Z-up, as CAD exports are).
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(12095, 14160, 5900), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)
    state.mesh = mesh
    state.zUp = true
    state.fit()
    state.scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(mesh)
    const size = box.getSize(new THREE.Vector3())

    // 1. Stood upright: the file's 5900 of height is the on-screen height, and
    //    the footprint is the wide pair. The regression here read 12095 tall.
    assert.ok(Math.abs(size.y - 5900) < 1e-3, `on-screen height should be 5900, got ${size.y}`)
    assert.ok(
      Math.abs(size.x - 12095) < 1e-3 && Math.abs(size.z - 14160) < 1e-3,
      `footprint should be 12095 × 14160, got ${size.x} × ${size.z}`,
    )

    // 2. Centred on the view and grounded. This is the regression that put the
    //    model in a corner of the viewport with the grid beside it.
    assert.ok(
      Math.abs(box.min.x + box.max.x) < 1e-3 && Math.abs(box.min.z + box.max.z) < 1e-3,
      `the footprint must be centred on the world origin, got x ${box.min.x}…${box.max.x}, z ${box.min.z}…${box.max.z}`,
    )
    assert.ok(Math.abs(box.min.y) < 1e-3, `the model must be grounded, got base y = ${box.min.y}`)

    // 3. The grid is horizontal and sits exactly on that ground plane.
    const gridWorld = state.gridHelper.getWorldPosition(new THREE.Vector3())
    assert.ok(
      Math.abs(gridWorld.y - box.min.y) < 1e-3,
      `the grid must sit on the model's z = 0 ground (y ${box.min.y}), got y ${gridWorld.y}`,
    )
    // A GridHelper's lines live in its local XY plane: the plane normal is local
    // +Y. This assertion used +Z, which is why a -90° rotation could stand the
    // grid up as a wall with the suite still green.
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(
      state.gridHelper.getWorldQuaternion(new THREE.Quaternion()),
    )
    assert.ok(
      Math.abs(Math.abs(normal.y) - 1) < 1e-6,
      `the grid plane must be horizontal, normal ${normal.toArray()}`,
    )
    // Sized to the footprint with a visible margin: a ground plane that bleeds
    // off every edge of the frame reads as a wall instead of a floor.
    assert.ok(
      state.gridHelper.scale.x > 14160 && state.gridHelper.scale.x < 14160 * 1.6,
      `grid span should hug the footprint with margin, got ${state.gridHelper.scale.x}`,
    )

    // 4. The camera orbits the model's *volume*, not the ground it stands on.
    //    Aiming at the base puts the eye level with the ground plane, which made
    //    it read as a wall behind the model.
    const focus = state.rig.target
    assert.ok(
      Math.abs(focus.y - (box.min.y + box.max.y) / 2) < 1e-3,
      `the orbit target should sit at the model's mid-height, got y = ${focus.y}`,
    )
    assert.ok(
      Math.abs(focus.x) < 1e-3 && Math.abs(focus.z) < 1e-3,
      `and on the model's vertical axis, got ${focus.toArray()}`,
    )

    // 5. The grid's world *plane* is horizontal and level with the model base.
    //    Measured through the plane itself (a point on it plus its world normal),
    //    not through the helper group's own transform — the group carries no
    //    rotation, so asserting on it proved nothing.
    const halfLocal = state.gridHelper.scale.x / 2
    const gridQuaternion = state.gridHelper.getWorldQuaternion(new THREE.Quaternion())
    // A GridHelper's lines lie in its local XY plane, so its normal is local +Y.
    // Testing +Z instead is what let a -90° rotation stand the grid up as a wall
    // while this suite stayed green.
    const planeNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(gridQuaternion)
    assert.ok(
      Math.abs(Math.abs(planeNormal.y) - 1) < 1e-6,
      `the grid's world normal must be vertical, got ${planeNormal.toArray()}`,
    )
    const planeOrigin = state.gridHelper.getWorldPosition(new THREE.Vector3())
    // A GridHelper's in-plane axes are its local +X and +Z; local +Y is the
    // normal. Mixing those up builds "corners" that leave the plane entirely,
    // which is what an earlier version of this assertion did.
    const along = new THREE.Vector3(1, 0, 0).applyQuaternion(gridQuaternion)
    const across = new THREE.Vector3(0, 0, 1).applyQuaternion(gridQuaternion)
    const half = state.gridHelper.scale.x / 2
    for (const [u, v] of [[half, 0], [0, half], [-half, -half], [0, -half]]) {
      const corner = planeOrigin.clone().addScaledVector(along, u).addScaledVector(across, v)
      assert.ok(
        Math.abs(corner.y - box.min.y) < 1e-3,
        `every point of the grid plane must sit on the model base (y ${box.min.y}), got ${corner.toArray()}`,
      )
    }

    // 5. The ground plane must land *inside* the frame with its edges visible.
    //    A ground plane that overflows the viewport on the near and far edge is
    //    indistinguishable from a wall behind the model — that is exactly how a
    //    correct, horizontal grid kept being reported as a wall.
    state.camera.updateMatrixWorld(true)
    state.camera.updateProjectionMatrix()
    const viewProjection = new THREE.Matrix4().multiplyMatrices(
      state.camera.projectionMatrix,
      state.camera.matrixWorldInverse,
    )
    const gridCorner = new THREE.Vector3()
    const gridCorners = [
      [halfLocal, 0], [0, halfLocal], [-halfLocal, 0], [0, -halfLocal],
    ].map(([u, v]) => {
      const point = planeOrigin.clone().addScaledVector(along, u).addScaledVector(across, v)
      return point.applyMatrix4(viewProjection)
    })
    void gridCorner
    for (const corner of gridCorners) {
      assert.ok(
        Math.abs(corner.x) < 1 && Math.abs(corner.y) < 1 && corner.z < 1,
        `the grid must be fully framed (edges visible), got NDC ${corner.toArray()}`,
      )
    }

    // 6. The origin ring marks the model's OWN origin — (0,0,0) in the file —
    //    which on an asymmetric model is nowhere near the bounding-box centre.
    const ring = state.helpers.children.find((child) => child.geometry?.type === 'RingGeometry')
    assert.ok(ring !== undefined, 'the origin ring must exist')
    const ringWorld = ring.getWorldPosition(new THREE.Vector3())
    const originWorld = mesh.getWorldPosition(new THREE.Vector3())
    assert.ok(
      ringWorld.distanceTo(originWorld) < 1e-6,
      `the ring must sit on the model's own origin ${originWorld.toArray()}, got ${ringWorld.toArray()}`,
    )
    assert.ok(
      Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(ring.getWorldQuaternion(new THREE.Quaternion())).y) > 0.999,
      'and lie flat on the ground plane',
    )

    // 7. Idempotent: nothing derived from the model may feed back into its
    //    placement. Repeated fits used to move it by metres.
    state.fit()
    state.fit()
    const again = new THREE.Box3().setFromObject(mesh)
    assert.ok(
      again.min.distanceTo(box.min) < 1e-3,
      `repeated fit() moved the model from ${box.min.toArray()} to ${again.min.toArray()}`,
    )
    state.scene.remove(root)
    state.dispose()
  })

  check('适配 re-frames without touching the angle, 重置 restores the angle alone', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(12095, 14160, 5900), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)
    state.mesh = mesh
    state.zUp = true
    state.fit()

    // A user has orbited somewhere else and zoomed in.
    state.rig.theta = -1.234
    state.rig.phi = 0.85
    state.rig.radius = 1234
    const before = { theta: state.rig.theta, phi: state.rig.phi }

    // 「适配」: same direction, everything back in frame.
    state.frameAll()
    assert.ok(
      Math.abs(state.rig.theta - before.theta) < 1e-9 && Math.abs(state.rig.phi - before.phi) < 1e-9,
      `适配 must not change the viewing angle, got theta ${state.rig.theta} phi ${state.rig.phi}`,
    )
    assert.ok(state.rig.radius > 1234 * 2, `适配 must pull back to fit, got radius ${state.rig.radius}`)
    const sphere = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere())
    const vertical = (state.camera.fov * Math.PI) / 180
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(state.camera.aspect, 1e-3))
    const needed = sphere.radius / Math.sin(Math.min(vertical, horizontal) / 2)
    assert.ok(
      state.rig.radius >= needed,
      `适配 must actually fit the model (radius ${state.rig.radius} < needed ${needed})`,
    )
    assert.ok(
      Math.abs(state.rig.target.y - sphere.center.y) < 1e-3,
      '适配 aims at the model volume centre',
    )

    // 「重置」: all three — re-centre the model, fit it, and return to the
    // canonical 3/4 view. Deliberately NOT "restore the angle only": a user who
    // has dragged the model out of frame expects this button to bring it back.
    mesh.position.x += 4000
    mesh.position.z -= 2500
    mesh.updateMatrixWorld(true)
    state.rig.theta = -2.1
    state.rig.phi = 0.4
    state.resetView()
    assert.ok(Math.abs(state.rig.theta - Math.PI / 4) < 1e-9, '重置 restores the canonical azimuth')
    assert.ok(Math.abs(state.rig.phi - (55 * Math.PI) / 180) < 1e-9, '重置 restores the canonical polar angle')

    const box2 = new THREE.Box3().setFromObject(mesh)
    assert.ok(
      Math.abs(box2.min.x + box2.max.x) < 1e-3 && Math.abs(box2.min.z + box2.max.z) < 1e-3,
      `重置 must re-centre the model, got x ${box2.min.x}…${box2.max.x} z ${box2.min.z}…${box2.max.z}`,
    )
    assert.ok(Math.abs(box2.min.y) < 1e-3, 'and re-ground it')
    const sphere2 = box2.getBoundingSphere(new THREE.Sphere())
    const vertical2 = (state.camera.fov * Math.PI) / 180
    const horizontal2 = 2 * Math.atan(Math.tan(vertical2 / 2) * Math.max(state.camera.aspect, 1e-3))
    assert.ok(
      state.rig.radius >= sphere2.radius / Math.sin(Math.min(vertical2, horizontal2) / 2),
      '重置 must fit the whole model into the frame',
    )
    state.scene.remove(root)
    state.dispose()
  })

  check('a shaded model gets a structural-edge overlay that cannot skew its bounds', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(12095, 14160, 5900), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)

    // Assigning the mesh is what builds the overlay — no separate call to forget.
    state.mesh = mesh
    const overlay = mesh.children.find((child) => child.isLineSegments2 === true)
    assert.ok(overlay !== undefined, 'the structural-edge overlay must be attached')
    assert.ok(overlay.userData.helper === true, 'and marked as a helper')

    state.zUp = true
    state.fit()
    state.scene.updateMatrixWorld(true)
    // The overlay must not be measured into the model's bounds, or the placement
    // would drift (the same trap the grid once fell into).
    const box = new THREE.Box3().setFromObject(mesh)
    const size = box.getSize(new THREE.Vector3())
    assert.ok(
      Math.abs(size.y - 5900) < 1e-3 && Math.abs(box.min.y) < 1e-3,
      `the overlay must not disturb placement, got height ${size.y} base ${box.min.y}`,
    )

    // Replacing the mesh must drop the old overlay instead of leaking it.
    const next = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 10), new THREE.MeshBasicMaterial())
    root.add(next)
    const stale = overlay
    state.mesh = next
    assert.ok(stale.parent === null, 'the previous overlay must be detached')
    assert.ok(
      next.children.find((child) => child.isLineSegments2 === true) !== undefined,
      'and a fresh overlay attached to the new mesh',
    )
    state.scene.remove(root)
    state.dispose()
  })

  check('the shaded default draws 1px opaque pixel-width edges with the offset on the line', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 200, 100), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)
    state.mesh = mesh
    state.zUp = true
    state.fit()

    const overlay = mesh.children.find((child) => child.isLineSegments2 === true)
    assert.ok(overlay !== undefined, 'the overlay must be a fat line object')
    // A pixel-measured width is what keeps the drawing's weight constant as the
    // camera zooms; a world-unit width would thicken and the colour would shift.
    assert.ok(overlay.material.worldUnits === false, 'the edge width must be in pixels')
    assert.ok(Math.abs(overlay.material.linewidth - 1) < 1e-9, `edge width should be 1px, got ${overlay.material.linewidth}`)
    assert.ok(overlay.material.transparent !== true, 'edges must be opaque, not blended with the surface')
    // Fat lines are quads, so polygon offset reaches them — unlike GL_LINES.
    assert.ok(overlay.material.polygonOffset === true, 'the line must carry its own depth offset')
    assert.ok(state.material.polygonOffset !== true, 'and the surface must not add a second one')
    assert.ok(state.appearance === 'shaded', `default appearance, got ${state.appearance}`)
    state.scene.remove(root)
    state.dispose()
  })

  check('線框 switches to the 1° line drawing and back', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    // A cylinder: at 30° its facet edges are all dropped, at 1° they survive.
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 120, 48), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)
    state.mesh = mesh
    state.zUp = true
    state.fit()
    // A fat-line geometry keeps the segment list in `instanceStart`; its
    // `position` attribute is just the shared quad.
    const segments = () =>
      mesh.children.find((child) => child.isLineSegments2 === true).geometry.getAttribute('instanceStart').count
    const shaded = segments()
    assert.ok(shaded > 0, 'the shaded view must have edges')

    state.setAppearance('lines')
    assert.ok(state.appearance === 'lines', 'appearance must switch')
    assert.ok(state.material.visible === false, 'the surfaces must be hidden in the line drawing')
    const drawn = segments()
    assert.ok(drawn > shaded, `1° must add edges (30°: ${shaded} segments, 1°: ${drawn})`)

    // The edges that matter are the cylinder's *facet* boundaries — the vertical
    // lines along its side. At 30° they are all below the threshold and only the
    // two cap rims survive, which is the "cylinders vanish" report; at 1° they are
    // present. Counting direction is what distinguishes the two.
    const verticalEdges = () => {
      const geometry = mesh.children.find((child) => child.isLineSegments2 === true).geometry
      const start = geometry.getAttribute('instanceStart')
      const end = geometry.getAttribute('instanceEnd')
      let vertical = 0
      for (let i = 0; i < start.count; i += 1) {
        const along = Math.abs(end.getY(i) - start.getY(i))
        const across = Math.max(
          Math.abs(end.getX(i) - start.getX(i)),
          Math.abs(end.getZ(i) - start.getZ(i)),
        )
        if (along > across * 10) vertical += 1
      }
      return vertical
    }
    assert.ok(
      verticalEdges() > 20,
      `the 1° drawing must keep the cylinder's side edges, got ${verticalEdges()}`,
    )

    state.setAppearance('shaded')
    assert.ok(
      verticalEdges() === 0,
      `and 30° must not, got ${verticalEdges()}`,
    )

    assert.ok(state.material.visible === true, 'and come back with the surfaces')
    state.scene.remove(root)
    state.dispose()
  })

  check('clip planes follow the camera and never cut into the model', () => {
    const host = makeHost()
    const state = scene.createViewerScene(host.canvas)
    const root = new THREE.Group()
    root.rotation.x = scene.modelUpRotation(true)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(12000, 14000, 6000), new THREE.MeshBasicMaterial())
    root.add(mesh)
    state.scene.add(root)
    state.mesh = mesh
    state.zUp = true
    state.fit()

    // The old fixed pair was 0.01..100000: at building scale that resolves ~9 m of
    // depth, so every joint z-fights. Fitted planes must be far tighter than that.
    assert.ok(state.camera.far < 1000000, `far should be fitted, got ${state.camera.far}`)

    // Zooming in must drag `near` in with it: a `near` larger than the gap to the
    // model's front surface slices the model open.
    state.rig.radius = state.rig.radius / 20
    state.rig.update()
    state.frameAll()
    const distance = state.camera.position.distanceTo(state.rig.target)
    assert.ok(
      state.camera.near < distance * 0.01,
      `near must stay just in front of the camera (near ${state.camera.near}, distance ${distance})`,
    )
    state.scene.remove(root)
    state.dispose()
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
  dom.restore()
}
