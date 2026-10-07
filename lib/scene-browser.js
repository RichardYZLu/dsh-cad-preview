// src/client/scene.ts
import * as THREE2 from "three";

// src/client/gizmo.ts
import * as THREE from "three";
var SIZE = 78;
var DISTANCE = 4;
var FONT = '600 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
var AXES = [
  { letter: "X", direction: new THREE.Vector3(1, 0, 0), color: 15026253 },
  { letter: "Y", direction: new THREE.Vector3(0, 1, 0), color: 3187820 },
  { letter: "Z", direction: new THREE.Vector3(0, 0, 1), color: 4029437 }
];
function placeGizmoCamera(camera, mainCamera, target, modelUp, distance = DISTANCE) {
  const offset = mainCamera.position.clone().sub(target ?? new THREE.Vector3());
  if (offset.lengthSq() === 0) offset.set(0, 0, 1);
  offset.normalize();
  camera.up.copy(modelUp ?? new THREE.Vector3(0, 1, 0));
  camera.position.copy(offset).multiplyScalar(distance);
  if (Math.abs(camera.up.dot(offset)) > 0.999) camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}
function letterSprite(letter, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.font = FONT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  context.fillText(letter, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  );
  sprite.scale.setScalar(0.62);
  sprite.userData.texture = texture;
  return sprite;
}
function createAxisGizmo() {
  const canvas = document.createElement("canvas");
  canvas.className = "cadpv-gizmo";
  canvas.width = SIZE;
  canvas.height = SIZE;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    right: "6px",
    bottom: "6px",
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    pointerEvents: "none",
    zIndex: "2"
  });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearAlpha(0);
  const scene = new THREE.Scene();
  const arrows = new THREE.Group();
  scene.add(arrows);
  scene.add(new THREE.AmbientLight(16777215, 1.6));
  const key = new THREE.DirectionalLight(16777215, 2.4);
  key.position.set(2, 3, 4);
  scene.add(key);
  const back = new THREE.DirectionalLight(16777215, 1.4);
  back.position.set(-2, -3, -4);
  scene.add(back);
  const stub = new THREE.CylinderGeometry(0.055, 0.055, 1.1, 12, 1, false);
  const cone = new THREE.ConeGeometry(0.15, 0.38, 16);
  for (const axis of AXES) {
    const material = new THREE.MeshStandardMaterial({
      color: axis.color,
      roughness: 0.45,
      metalness: 0.1,
      emissive: axis.color,
      emissiveIntensity: 0.25
    });
    const shaft = new THREE.Mesh(stub, material);
    const tip = new THREE.Mesh(cone, material);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axis.direction
    );
    shaft.quaternion.copy(quaternion);
    shaft.position.copy(axis.direction).multiplyScalar(0.55);
    tip.quaternion.copy(quaternion);
    tip.position.copy(axis.direction).multiplyScalar(1.29);
    const label = letterSprite(axis.letter, `#${axis.color.toString(16).padStart(6, "0")}`);
    label.position.copy(axis.direction).multiplyScalar(1.68);
    arrows.add(shaft, tip, label);
  }
  const camera = new THREE.OrthographicCamera(-2.3, 2.3, 2.3, -2.3, 0.1, 100);
  const offset = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const resize = () => {
    const ratio = Math.min(2, typeof window !== "undefined" && window.devicePixelRatio || 1);
    const width = Math.max(1, canvas.clientWidth || SIZE);
    const height = Math.max(1, canvas.clientHeight || SIZE);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    const half = 2.3;
    const aspect = width / height;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  };
  return {
    canvas,
    resize,
    /**
     * Match the gizmo to the model's orientation.
     *
     * @param rotationX - the same X rotation the viewer applies to the model.
     */
    setModelRotation(rotationX) {
      arrows.rotation.x = rotationX;
    },
    /**
     * Mirror the main camera and draw.
     *
     * @param mainCamera - the viewer's perspective camera.
     * @param target - the orbit target the main camera looks at.
     * @param modelUp - the model's up axis in world space.
     */
    render(mainCamera, target, modelUp) {
      placeGizmoCamera(camera, mainCamera, target ?? origin, modelUp, DISTANCE);
      renderer.render(scene, camera);
    },
    dispose() {
      scene.traverse((node) => {
        if (node.isSprite) {
          node.material.map?.dispose();
          node.material.dispose();
        }
      });
      stub.dispose();
      cone.dispose();
      renderer.dispose();
    }
  };
}

// src/client/scene.ts
function modelUpRotation(zUp) {
  return zUp ? -Math.PI / 2 : 0;
}
function modelSpaceToScreen(vector, zUp) {
  if (!zUp) return { x: vector.x, y: vector.y, z: vector.z };
  const euler = new THREE2.Euler(modelUpRotation(true), 0, 0);
  return new THREE2.Vector3(vector.x, vector.y, vector.z).applyEuler(euler);
}
var OrbitRig = class {
  constructor(canvas, camera, onChange) {
    this.canvas = canvas;
    this.camera = camera;
    this.onChange = onChange;
    this.target = new THREE2.Vector3();
    this.radius = 10;
    this.theta = Math.PI / 4;
    this.phi = Math.PI / 3;
    this.pointers = /* @__PURE__ */ new Map();
    this.mode = null;
    this.lastPinch = 0;
    this.bind();
    this.update();
  }
  setView(target, radius, theta, phi) {
    this.target.copy(target);
    this.radius = radius;
    this.theta = theta;
    this.phi = phi;
    this.update();
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
    this.target.copy(target);
    this.radius = radius;
    this.update();
  }
  bind() {
    const canvas = this.canvas;
    this.onPointerDown = (event) => {
      canvas.setPointerCapture?.(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) this.mode = event.button === 2 || event.shiftKey ? "pan" : "orbit";
      else if (this.pointers.size === 2) this.mode = "touch";
      this.lastPinch = 0;
    };
    this.onPointerMove = (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (previous === void 0) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;
      if (this.pointers.size === 2) return this.handlePinch();
      if (this.mode === "pan") this.pan(dx, dy);
      else this.orbit(dx, dy);
    };
    this.onPointerUp = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size === 0) this.mode = null;
      else if (this.pointers.size === 1) this.mode = "orbit";
    };
    this.onWheel = (event) => {
      event.preventDefault();
      this.radius = clamp(this.radius * Math.exp(event.deltaY * 12e-4), this.minRadius, this.maxRadius);
      this.update();
    };
    this.onContextMenu = (event) => event.preventDefault();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }
  handlePinch() {
    const [a, b] = [...this.pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (this.lastPinch === 0) {
      this.lastPinch = distance;
      return;
    }
    const ratio = this.lastPinch / Math.max(1, distance);
    this.lastPinch = distance;
    this.radius = clamp(this.radius * ratio, this.minRadius, this.maxRadius);
    this.update();
  }
  orbit(dx, dy) {
    this.theta -= dx * 6e-3;
    this.phi = clamp(this.phi - dy * 6e-3, 1e-4, Math.PI - 1e-4);
    this.update();
  }
  pan(dx, dy) {
    const camera = this.camera;
    const distance = this.radius;
    const height = 2 * Math.tan(camera.fov * Math.PI / 360) * distance;
    const width = height * camera.aspect;
    const right = new THREE2.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE2.Vector3().setFromMatrixColumn(camera.matrix, 1);
    this.target.addScaledVector(right, -dx * width / this.canvas.clientWidth);
    this.target.addScaledVector(up, dy * height / this.canvas.clientHeight);
    this.update();
  }
  update() {
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta)
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.onChange?.();
  }
  dispose() {
    const canvas = this.canvas;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.pointers.clear();
  }
};
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function modelBounds(root) {
  const box = new THREE2.Box3();
  const meshBox = new THREE2.Box3();
  const visit = (node) => {
    if (node.userData.helper === true) return;
    if (node.isMesh === true) {
      const geometry = node.geometry;
      if (geometry !== void 0) {
        if (geometry.boundingBox === null) geometry.computeBoundingBox();
        meshBox.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld);
        box.union(meshBox);
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return box;
}
function settlePlacement(mesh, centerXZ, ground) {
  const parent = mesh.parent;
  const base = mesh.position.clone();
  const measure = () => {
    mesh.updateMatrixWorld(true);
    if (parent !== null) parent.updateMatrixWorld(true);
    return modelBounds(mesh);
  };
  let box = measure();
  if (box.isEmpty()) return box;
  const center = box.getCenter(new THREE2.Vector3());
  const origin = mesh.getWorldPosition(new THREE2.Vector3());
  const delta = new THREE2.Vector3(
    centerXZ ? -center.x : 0,
    // Grounding drops the model onto the world origin's ground plane, which is
    // where the grid is; without it the model floats half its height up.
    ground ? -box.min.y : -origin.y,
    centerXZ ? -center.z : 0
  );
  if (parent !== null) {
    parent.updateMatrixWorld(true);
    delta.applyMatrix4(new THREE2.Matrix4().extractRotation(parent.matrixWorld).invert());
  }
  mesh.position.copy(base).add(delta);
  box = measure();
  return box;
}
function createViewerScene(canvas) {
  const renderer = new THREE2.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE2.SRGBColorSpace;
  const scene = new THREE2.Scene();
  scene.add(new THREE2.AmbientLight(16777215, 0.28));
  scene.add(new THREE2.HemisphereLight(14673909, 2764600, 0.35));
  const key = new THREE2.DirectionalLight(16777215, 1.5);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE2.DirectionalLight(16777215, 0.45);
  fill.position.set(-4, -1.5, -3);
  scene.add(fill);
  const rim = new THREE2.DirectionalLight(13161704, 0.35);
  rim.position.set(0, -4, 2);
  scene.add(rim);
  const material = new THREE2.MeshStandardMaterial({
    color: 10135224,
    metalness: 0,
    roughness: 0.85,
    flatShading: false
  });
  const edgeMaterial = new THREE2.LineBasicMaterial({
    color: 1778224,
    transparent: true,
    opacity: 0.55,
    // Without the offset, line and surface z-fight and the lines break up.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  });
  let edges = null;
  let currentMesh = null;
  function rebuildEdges(mesh) {
    if (edges !== null) {
      edges.removeFromParent();
      edges.geometry.dispose();
      edges = null;
    }
    if (mesh === null || mesh.geometry === void 0) return;
    const geometry = new THREE2.EdgesGeometry(mesh.geometry, 30);
    if (geometry.getAttribute("position").count === 0) {
      geometry.dispose();
      return;
    }
    edges = new THREE2.LineSegments(geometry, edgeMaterial);
    edges.userData.helper = true;
    edges.frustumCulled = false;
    mesh.add(edges);
  }
  const camera = new THREE2.PerspectiveCamera(45, 1, 0.01, 1e5);
  camera.position.set(6, 5, 8);
  const helpers = new THREE2.Group();
  helpers.userData.helper = true;
  scene.add(helpers);
  const gridHelper = new THREE2.GridHelper(1, 24, 10134706, 14146530);
  gridHelper.userData.helper = true;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.45;
  gridHelper.material.depthWrite = false;
  helpers.add(gridHelper);
  const originRing = new THREE2.Mesh(
    new THREE2.RingGeometry(0.35, 0.42, 48),
    new THREE2.MeshBasicMaterial({ color: 5073918, transparent: true, opacity: 0.55, side: THREE2.DoubleSide })
  );
  originRing.userData.helper = true;
  originRing.rotation.x = -Math.PI / 2;
  originRing.visible = false;
  helpers.add(originRing);
  const axes = originRing;
  const placeholder = new THREE2.Mesh(
    new THREE2.TorusKnotGeometry(1, 0.32, 128, 24),
    new THREE2.MeshStandardMaterial({ color: 5073918, wireframe: true, transparent: true, opacity: 0.35 })
  );
  scene.add(placeholder);
  const gizmo = createAxisGizmo();
  canvas.parentElement?.appendChild(gizmo.canvas);
  const cameraTarget = new THREE2.Vector3();
  const groundWorld = new THREE2.Vector3();
  const modelOriginWorld = new THREE2.Vector3();
  const modelBox = new THREE2.Box3();
  const modelUpWorld = new THREE2.Vector3(0, 1, 0);
  const frame = () => {
    renderer.render(scene, camera);
    gizmo.render(camera, cameraTarget, modelUpWorld);
  };
  const draw = () => frame();
  const rig = new OrbitRig(canvas, camera, draw);
  rig.onChange = () => {
    cameraTarget.copy(rig.target);
    frame();
  };
  camera.aspect = 1;
  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    gizmo.resize();
    cameraTarget.copy(rig.target);
    frame();
  };
  resize();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
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
      return currentMesh;
    },
    set mesh(next) {
      currentMesh = next;
      rebuildEdges(next);
    },
    /** Whether the loaded model is treated as Z-up (CAD convention). */
    zUp: true,
    resize,
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
      modelUpWorld.set(0, 1, 0);
      gizmo.setModelRotation(modelUpRotation(this.zUp === true));
      const box = new THREE2.Box3();
      if (this.mesh) {
        box.copy(settlePlacement(this.mesh, true, true));
        if (!box.isEmpty()) {
          const centre = box.getCenter(new THREE2.Vector3());
          groundWorld.set(centre.x, box.min.y, centre.z);
          this.mesh.updateMatrixWorld(true);
          modelOriginWorld.copy(this.mesh.getWorldPosition(new THREE2.Vector3()));
        }
      }
      if (box.isEmpty()) box.setFromCenterAndSize(new THREE2.Vector3(), new THREE2.Vector3(4, 4, 4));
      if (this.mesh !== null) {
        const span = 1.02 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        const safeSpan = Number.isFinite(span) && span > 1e-6 ? span : 1;
        gridHelper.scale.setScalar(safeSpan);
        axes.scale.setScalar(safeSpan * 0.08);
        axes.visible = true;
        helpers.rotation.set(0, 0, 0);
        helpers.position.copy(groundWorld);
        axes.position.copy(modelOriginWorld).sub(groundWorld);
      } else {
        gridHelper.scale.setScalar(10);
        axes.visible = false;
        axes.position.set(0, 0, 0);
        helpers.rotation.set(0, 0, 0);
        helpers.position.set(0, 0, 0);
      }
      helpers.updateMatrixWorld(true);
      modelBox.copy(box);
      return box;
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
      const box = this.mesh === null ? this.place() : modelBox;
      const focus = box.getCenter(new THREE2.Vector3());
      cameraTarget.copy(focus);
      const sphere = box.getBoundingSphere(new THREE2.Sphere());
      const radius = Math.max(sphere.radius, 1e-3);
      const vertical = this.camera.fov * Math.PI / 180;
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(this.camera.aspect, 1e-3));
      const fitDistance = radius / Math.sin(Math.min(vertical, horizontal) / 2);
      rig.minRadius = Math.max(radius * 0.05, 1e-4);
      rig.maxRadius = Math.max(radius * 400, 100);
      rig.setDistance(cameraTarget, Math.max(fitDistance * margin, radius * 0.1));
      this.resize();
    },
    /**
     * Put everything back to how the file first appeared: re-centre and re-ground
     * the model, fit it into the frame, and return to the canonical 3/4 view.
     *
     * This is the full reset — "适配" is the one that only changes the distance.
     */
    resetView() {
      this.place();
      this.frameAll(1.12);
      rig.setView(cameraTarget, rig.radius, Math.PI / 4, 55 * Math.PI / 180);
      this.resize();
    },
    /**
     * Full initial framing: place the model, then adopt the canonical 3/4 view.
     * Used when a model is first shown and when the up-axis changes.
     */
    fit() {
      this.place();
      this.frameAll(1.12);
      rig.setView(cameraTarget, rig.radius, Math.PI / 4, 55 * Math.PI / 180);
      this.resize();
    },
    dispose() {
      observer?.disconnect();
      rig.dispose();
      gizmo.dispose();
      gizmo.canvas.remove();
      if (edges !== null) {
        edges.removeFromParent();
        edges.geometry.dispose();
        edges = null;
      }
      if (this.mesh) {
        this.mesh.geometry.dispose();
        this.mesh.remove(helpers);
        scene.remove(this.mesh);
      }
      placeholder.geometry.dispose();
      placeholder.material.dispose();
      material.dispose();
      gridHelper.geometry.dispose();
      gridHelper.material.dispose();
      axes.geometry.dispose();
      axes.material.dispose();
      renderer.dispose();
    }
  };
  return state;
}
export {
  OrbitRig,
  clamp,
  createViewerScene,
  modelSpaceToScreen,
  modelUpRotation
};
