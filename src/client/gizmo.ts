/**
 * Bottom-right orientation gizmo.
 *
 * A CAD viewer loses a lot when the scene's axes helper is off-screen or
 * edge-on, so this is a second, tiny WebGL view of the same orientation: three
 * arrows plus their letters, framed in the corner, mirroring the main camera so
 * it is readable without hunting for the in-scene helper.
 *
 * The camera trick is what keeps it cheap: an orthographic camera looking down
 * +Z from a fixed distance, with its rotation copied from the main camera,
 * renders exactly the axes as the main view sees them — no projection math and
 * no second scene graph per frame.
 */
import * as THREE from 'three'

const SIZE = 78
const DISTANCE = 4
const FONT = '600 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

/** The three axis definitions: direction, colour and letter. */
const AXES = [
  { letter: 'X', direction: new THREE.Vector3(1, 0, 0), color: 0xe5484d },
  { letter: 'Y', direction: new THREE.Vector3(0, 1, 0), color: 0x30a46c },
  { letter: 'Z', direction: new THREE.Vector3(0, 0, 1), color: 0x3d7bfd },
]

/**
 * Point a camera "through" the main view: parked past `distance` along the main
 * camera's own direction from the orbit target, rolled so the model's up axis is
 * screen-up.
 *
 * Roll is specified rather than inherited. Copying the main camera's quaternion
 * looks equivalent, but the gizmo must agree with the *model's* up axis (which
 * the viewer rotates into world +Y), and stating that explicitly is both
 * testable and immune to a roll difference between the two cameras.
 *
 * @param camera - the gizmo's orthographic camera.
 * @param mainCamera - the viewer's perspective camera.
 * @param target - the orbit target the main camera looks at.
 * @param modelUp - the model's up axis in world space (usually `(0, 1, 0)`).
 * @param distance - how far back the gizmo camera sits.
 */
export function placeGizmoCamera(camera, mainCamera, target, modelUp, distance = DISTANCE) {
  const offset = mainCamera.position.clone().sub(target ?? new THREE.Vector3())
  if (offset.lengthSq() === 0) offset.set(0, 0, 1)
  offset.normalize()
  camera.up.copy(modelUp ?? new THREE.Vector3(0, 1, 0))
  camera.position.copy(offset).multiplyScalar(distance)
  // A view direction parallel to `up` has no defined roll, so fall back.
  if (Math.abs(camera.up.dot(offset)) > 0.999) camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
}

/**
 * Render one letter as a sprite so the gizmo names its axes.
 *
 * @param letter - the axis letter.
 * @param color - CSS colour string matching the arrow.
 * @returns a sprite carrying that letter.
 */
function letterSprite(letter, color) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  context.font = FONT
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = color
  context.fillText(letter, 32, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  )
  sprite.scale.setScalar(0.62)
  sprite.userData.texture = texture
  return sprite
}

/**
 * Build the gizmo view.
 *
 * @returns `render(camera)`, `resize()` and `dispose()`.
 */
export function createAxisGizmo() {
  const canvas = document.createElement('canvas')
  canvas.className = 'cadpv-gizmo'
  canvas.width = SIZE
  canvas.height = SIZE
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'absolute',
    right: '6px',
    bottom: '6px',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    pointerEvents: 'none',
    zIndex: '2',
  })

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setClearAlpha(0)

  const scene = new THREE.Scene()
  // The arrows reproduce the *model's* frame, so they carry the same rotation
  // the viewer applies to the model: with a Z-up file stood upright, the blue Z
  // arrow points up the canvas, which is what "Z is up" has to look like.
  const arrows = new THREE.Group()
  scene.add(arrows)
  scene.add(new THREE.AmbientLight(0xffffff, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(2, 3, 4)
  scene.add(key)
  const back = new THREE.DirectionalLight(0xffffff, 1.4)
  back.position.set(-2, -3, -4)
  scene.add(back)

  // Both primitives point along +Y; each axis is that direction rotated into
  // place, so one geometry pair serves all three.
  const stub = new THREE.CylinderGeometry(0.055, 0.055, 1.1, 12, 1, false)
  const cone = new THREE.ConeGeometry(0.15, 0.38, 16)

  for (const axis of AXES) {
    const material = new THREE.MeshStandardMaterial({
      color: axis.color,
      roughness: 0.45,
      metalness: 0.1,
      emissive: axis.color,
      emissiveIntensity: 0.25,
    })
    const shaft = new THREE.Mesh(stub, material)
    const tip = new THREE.Mesh(cone, material)
    // Both geometries point along +Y, so the axis direction is a rotation of
    // that: the letter rides just past the cone.
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axis.direction,
    )
    shaft.quaternion.copy(quaternion)
    shaft.position.copy(axis.direction).multiplyScalar(0.55)
    tip.quaternion.copy(quaternion)
    tip.position.copy(axis.direction).multiplyScalar(1.29)
    const label = letterSprite(axis.letter, `#${axis.color.toString(16).padStart(6, '0')}`)
    label.position.copy(axis.direction).multiplyScalar(1.68)
    arrows.add(shaft, tip, label)
  }

  const camera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 100)
  const offset = new THREE.Vector3()
  const origin = new THREE.Vector3()

  const resize = () => {
    const ratio = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const width = Math.max(1, canvas.clientWidth || SIZE)
    const height = Math.max(1, canvas.clientHeight || SIZE)
    renderer.setPixelRatio(ratio)
    renderer.setSize(width, height, false)
    const half = 2.3
    const aspect = width / height
    camera.left = -half * aspect
    camera.right = half * aspect
    camera.top = half
    camera.bottom = -half
    camera.updateProjectionMatrix()
  }

  return {
    canvas,
    resize,
    /**
     * Match the gizmo to the model's orientation.
     *
     * @param rotationX - the same X rotation the viewer applies to the model.
     */
    setModelRotation(rotationX) {
      arrows.rotation.x = rotationX
    },
    /**
     * Mirror the main camera and draw.
     *
     * @param mainCamera - the viewer's perspective camera.
     * @param target - the orbit target the main camera looks at.
     * @param modelUp - the model's up axis in world space.
     */
    render(mainCamera, target, modelUp) {
      placeGizmoCamera(camera, mainCamera, target ?? origin, modelUp, DISTANCE)
      renderer.render(scene, camera)
    },
    dispose() {
      scene.traverse((node) => {
        if (node.isSprite) {
          node.material.map?.dispose()
          node.material.dispose()
        }
      })
      stub.dispose()
      cone.dispose()
      renderer.dispose()
    },
  }
}
