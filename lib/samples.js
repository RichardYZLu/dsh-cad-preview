// src/samples/appearance.ts
import * as THREE3 from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

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
  const canvas2 = document.createElement("canvas");
  canvas2.width = 64;
  canvas2.height = 64;
  const context = canvas2.getContext("2d");
  context.font = FONT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  context.fillText(letter, 32, 34);
  const texture = new THREE.CanvasTexture(canvas2);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  );
  sprite.scale.setScalar(0.62);
  sprite.userData.texture = texture;
  return sprite;
}
function createAxisGizmo() {
  const canvas2 = document.createElement("canvas");
  canvas2.className = "cadpv-gizmo";
  canvas2.width = SIZE;
  canvas2.height = SIZE;
  canvas2.setAttribute("aria-hidden", "true");
  Object.assign(canvas2.style, {
    position: "absolute",
    right: "6px",
    bottom: "6px",
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    pointerEvents: "none",
    zIndex: "2"
  });
  const renderer = new THREE.WebGLRenderer({ canvas: canvas2, antialias: true, alpha: true });
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
    const width = Math.max(1, canvas2.clientWidth || SIZE);
    const height = Math.max(1, canvas2.clientHeight || SIZE);
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
    canvas: canvas2,
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
var OrbitRig = class {
  constructor(canvas2, camera, onChange) {
    this.canvas = canvas2;
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
    const canvas2 = this.canvas;
    this.onPointerDown = (event) => {
      canvas2.setPointerCapture?.(event.pointerId);
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
    canvas2.addEventListener("pointerdown", this.onPointerDown);
    canvas2.addEventListener("pointermove", this.onPointerMove);
    canvas2.addEventListener("pointerup", this.onPointerUp);
    canvas2.addEventListener("pointercancel", this.onPointerUp);
    canvas2.addEventListener("wheel", this.onWheel, { passive: false });
    canvas2.addEventListener("contextmenu", this.onContextMenu);
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
    const canvas2 = this.canvas;
    canvas2.removeEventListener("pointerdown", this.onPointerDown);
    canvas2.removeEventListener("pointermove", this.onPointerMove);
    canvas2.removeEventListener("pointerup", this.onPointerUp);
    canvas2.removeEventListener("pointercancel", this.onPointerUp);
    canvas2.removeEventListener("wheel", this.onWheel);
    canvas2.removeEventListener("contextmenu", this.onContextMenu);
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
function settlePlacement(mesh2, centerXZ, ground) {
  const parent = mesh2.parent;
  const base = mesh2.position.clone();
  const measure = () => {
    mesh2.updateMatrixWorld(true);
    if (parent !== null) parent.updateMatrixWorld(true);
    return modelBounds(mesh2);
  };
  let box = measure();
  if (box.isEmpty()) return box;
  const center = box.getCenter(new THREE2.Vector3());
  const origin = mesh2.getWorldPosition(new THREE2.Vector3());
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
  mesh2.position.copy(base).add(delta);
  box = measure();
  return box;
}
function createViewerScene(canvas2) {
  const renderer = new THREE2.WebGLRenderer({ canvas: canvas2, antialias: true, alpha: true });
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
  let edges2 = null;
  let currentMesh = null;
  function rebuildEdges2(mesh2) {
    if (edges2 !== null) {
      edges2.removeFromParent();
      edges2.geometry.dispose();
      edges2 = null;
    }
    if (mesh2 === null || mesh2.geometry === void 0) return;
    const geometry = new THREE2.EdgesGeometry(mesh2.geometry, 30);
    if (geometry.getAttribute("position").count === 0) {
      geometry.dispose();
      return;
    }
    edges2 = new THREE2.LineSegments(geometry, edgeMaterial);
    edges2.userData.helper = true;
    edges2.frustumCulled = false;
    mesh2.add(edges2);
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
  canvas2.parentElement?.appendChild(gizmo.canvas);
  const cameraTarget = new THREE2.Vector3();
  const groundWorld = new THREE2.Vector3();
  const modelOriginWorld = new THREE2.Vector3();
  const modelBox = new THREE2.Box3();
  const modelUpWorld = new THREE2.Vector3(0, 1, 0);
  const frame = () => {
    renderer.render(scene, camera);
    gizmo.render(camera, cameraTarget, modelUpWorld);
  };
  const draw2 = () => frame();
  const rig = new OrbitRig(canvas2, camera, draw2);
  rig.onChange = () => {
    cameraTarget.copy(rig.target);
    frame();
  };
  camera.aspect = 1;
  const resize = () => {
    const width = Math.max(1, canvas2.clientWidth);
    const height = Math.max(1, canvas2.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    gizmo.resize();
    cameraTarget.copy(rig.target);
    frame();
  };
  resize();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas2);
  const state2 = {
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
      rebuildEdges2(next);
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
      if (edges2 !== null) {
        edges2.removeFromParent();
        edges2.geometry.dispose();
        edges2 = null;
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
  return state2;
}

// src/samples/appearance.ts
var stage = document.getElementById("stage");
var reportEl = document.getElementById("report");
function fail(message) {
  reportEl.innerHTML = `<b style="color:#ff6b6b">\u51FA\u9519\u4E86\uFF1A</b> ${message}`;
}
window.addEventListener("error", (event) => fail(event.message));
window.addEventListener("unhandledrejection", (event) => fail(String(event.reason)));
var canvas = document.createElement("canvas");
stage.appendChild(canvas);
var state = createViewerScene(canvas);
state.zUp = true;
applySurfaceOffset();
var mesh = null;
var edges = null;
var surfaceOffset = false;
function applySurfaceOffset() {
  state.material.polygonOffset = surfaceOffset;
  state.material.polygonOffsetFactor = surfaceOffset ? 1 : 0;
  state.material.polygonOffsetUnits = surfaceOffset ? 1 : 0;
  state.material.needsUpdate = true;
}
var MODELS = await fetch("/models").then((response) => response.json());
function structuralEdges(geometry, threshold) {
  const raw = new THREE3.EdgesGeometry(geometry, threshold);
  const count = raw.getAttribute("position").count;
  if (count === 0) {
    raw.dispose();
    return null;
  }
  return raw;
}
var builtThreshold = null;
var modelSpan = 1;
function effectiveThreshold() {
  return VARIANTS[active].threshold ?? 30;
}
function ensureEdges() {
  if (builtThreshold === effectiveThreshold()) return;
  stats.edgeMs = rebuildEdges();
  stats.segments = edges === null ? 0 : edges.geometry.getAttribute("position").count / 2;
}
var LINE_WIDTH_PX = 1;
function rebuildEdges() {
  if (edges !== null) {
    mesh.remove(edges);
    edges.geometry.dispose();
    edges.material.dispose();
    edges = null;
  }
  if (mesh === null) return 0;
  const started = performance.now();
  builtThreshold = effectiveThreshold();
  const raw = structuralEdges(mesh.geometry, builtThreshold);
  if (raw === null) return 0;
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(raw.getAttribute("position").array);
  raw.dispose();
  const material = new LineMaterial({
    color: 14673909,
    linewidth: LINE_WIDTH_PX,
    worldUnits: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4
  });
  edges = new LineSegments2(geometry, material);
  edges.frustumCulled = false;
  edges.userData.helper = true;
  mesh.add(edges);
  applyEdgeWidth();
  return performance.now() - started;
}
function applyEdgeWidth() {
  if (edges === null) return;
  edges.material.linewidth = LINE_WIDTH_PX;
  edges.material.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1);
  edges.material.needsUpdate = true;
}
var modelRadius = 1;
function updateClipPlanes() {
  const distance = state.camera.position.distanceTo(state.rig.target);
  state.camera.near = Math.max(distance * 2e-3, 1e-4);
  state.camera.far = distance + modelRadius * 6;
  state.camera.updateProjectionMatrix();
}
var composer = new EffectComposer(state.renderer);
composer.addPass(new RenderPass(state.scene, state.camera));
var ssao = new SSAOPass(state.scene, state.camera, 1024, 1024);
ssao.kernelRadius = 12;
ssao.minDistance = 2e-3;
ssao.maxDistance = 0.12;
composer.addPass(ssao);
composer.addPass(new OutputPass());
var compose = false;
state.renderer.domElement.addEventListener("pointerup", () => {
  ssao.camera = state.camera;
});
var originalResize = state.resize;
state.resize = () => {
  originalResize();
  composer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1);
  ssao.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1);
};
var faceColor = 14343906;
var backgroundChoice = "#14161b";
var edgeChoice = "background";
var LIGHTING = {
  soft: { ambient: 0.28, hemi: 0.35, key: 1.5, fill: 0.45, rim: 0.35 },
  // Low ambient and a strong key: surfaces facing different directions separate,
  // which is what "更强的明暗对比" asks for.
  contrast: { ambient: 0.1, hemi: 0.18, key: 2.4, fill: 0.22, rim: 0.18 },
  flat: { ambient: 1, hemi: 0.2, key: 0.5, fill: 0.3, rim: 0.2 }
};
var lights = { ambient: null, hemi: null, directional: [] };
state.scene.traverse((object) => {
  if (object.isAmbientLight) lights.ambient = object;
  else if (object.isHemisphereLight) lights.hemi = object;
  else if (object.isDirectionalLight) lights.directional.push(object);
});
function setLighting(name) {
  const preset = LIGHTING[name];
  if (lights.ambient !== null) lights.ambient.intensity = preset.ambient;
  if (lights.hemi !== null) lights.hemi.intensity = preset.hemi;
  const order = ["key", "fill", "rim"];
  lights.directional.forEach((light, index) => {
    const role = order[index];
    if (role !== void 0) light.intensity = preset[role];
  });
  lightingName = name;
}
var lightingName = "soft";
function luminance(hex) {
  const r = (hex >> 16 & 255) / 255;
  const g = (hex >> 8 & 255) / 255;
  const b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
var EDGE_CANDIDATES = [856343, 3752271, 7042178, 10135224, 14673909];
function resolveEdgeColor() {
  if (edgeChoice === "dark") return 856343;
  if (edgeChoice === "light") return 14673909;
  const face = luminance(faceColor);
  const background = luminance(parseCssColor(backgroundChoice));
  const drawn = state.material.visible;
  if (edgeChoice === "face") {
    return (drawn ? face : background) > 0.5 ? 856343 : 14673909;
  }
  if (edgeChoice === "background") {
    return background > 0.5 ? 856343 : 14673909;
  }
  let best = EDGE_CANDIDATES[0];
  let bestScore = -1;
  for (const candidate of EDGE_CANDIDATES) {
    const againstFace = Math.abs(luminance(candidate) - face);
    const againstBackground = Math.abs(luminance(candidate) - background);
    const score = drawn ? Math.min(againstFace, againstBackground) : againstBackground;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
function parseCssColor(css) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(css).trim());
  return match === null ? 8421504 : Number.parseInt(match[1], 16);
}
function applyBackground() {
  stage.style.background = backgroundChoice;
  applyGridContrast();
}
function applyGridContrast() {
  const dark = luminance(parseCssColor(backgroundChoice)) > 0.5;
  state.gridHelper.material.color.set(dark ? 4870754 : 16777215);
  state.gridHelper.material.needsUpdate = true;
}
function applyFace() {
  state.material.color.set(faceColor);
  state.material.metalness = 0;
  state.material.roughness = 0.85;
  state.material.wireframe = false;
  state.material.visible = true;
  state.material.needsUpdate = true;
}
function applyEdge() {
  if (edges === null) return;
  edges.material.color.set(resolveEdgeColor());
  edges.material.needsUpdate = true;
}
var VARIANTS = {
  current: {
    threshold: 30,
    blurb: "\u73B0\u72B6\uFF1A\u67D4\u548C\u914D\u5149 + 30\xB0 \u7ED3\u6784\u7EBF + \u7EBF\u6CBF\u89C6\u7EBF\u524D\u63A8\uFF080.2.12 \u7684\u65B9\u5411\uFF0C\u5DF2\u4FEE\u597D\u6DF1\u5EA6\u4E0E\u88C1\u526A\u9762\uFF09",
    apply() {
      applyFace();
      setLighting("soft");
      applyEdge();
      compose = false;
    }
  },
  "ao+strong": {
    threshold: 30,
    blurb: "\u73AF\u5883\u5149\u906E\u853D + \u5F3A\u7ED3\u6784\u7EBF\uFF08\u5408\u5E76\uFF09\uFF1A\u906E\u853D\u52A0\u6DF1\u51F9\u89D2\u4E0E\u63A5\u7F1D\u3001\u914D\u5149\u5BF9\u6BD4\u52A0\u5F3A\u3001\u7ED3\u6784\u7EBF\u753B\u6210\u5B9E\u5FC3 \u2014\u2014 \u6784\u4EF6\u5BC6\u96C6\u65F6\u6700\u6E05\u695A",
    apply() {
      applyFace();
      setLighting("contrast");
      applyEdge();
      compose = true;
    }
  },
  lines: {
    threshold: 1,
    blurb: "\u53EA\u753B\u7ED3\u6784\u7EBF\uFF1A1\xB0 \u63D0\u53D6\uFF08\u5706\u67F1\u7B49\u66F2\u9762\u5B8C\u6574\u4FDD\u7559\uFF09\uFF0C\u9762\u5168\u90E8\u9690\u85CF\uFF0C\u4E0D\u505A\u5C4F\u5E55\u7A7A\u95F4\u5254\u9664",
    apply() {
      state.material.visible = false;
      applyEdge();
      compose = false;
    }
  }
};
var active = "current";
var stats = { edgeMs: 0, name: "", segments: 0 };
function draw() {
  updateClipPlanes();
  state.camera.updateMatrixWorld(true);
  if (compose) composer.render();
  else state.renderer.render(state.scene, state.camera);
}
function loop() {
  requestAnimationFrame(loop);
  draw();
}
function select(key) {
  active = key;
  const variant = VARIANTS[key];
  ensureEdges();
  variant.apply();
  state.material.needsUpdate = true;
  if (edges !== null) edges.material.needsUpdate = true;
  showPanel();
}
function showPanel() {
  const variant = VARIANTS[active];
  const triangles = mesh === null ? 0 : (mesh.geometry.index === null ? mesh.geometry.getAttribute("position").count : mesh.geometry.index.count) / 3;
  reportEl.innerHTML = [
    `<b>${active}</b> \u2014 ${variant.blurb}`,
    `\u9762\u8272 #${faceColor.toString(16).padStart(6, "0")} \xB7 \u63CF\u8FB9 ${{ face: "\u968F\u9762\u8272", background: "\u968F\u80CC\u666F", balanced: "\u517C\u987E\u4E24\u8005" }[edgeChoice] ?? edgeChoice} #${resolveEdgeColor().toString(16).padStart(6, "0")} \xB7 \u914D\u5149 ${lightingName} \xB7 \u7ED3\u6784\u7EBF ${LINE_WIDTH_PX.toFixed(1)}px \u4E0D\u900F\u660E`,
    `\u6A21\u578B <code>${stats.name}</code> \xB7 \u4E09\u89D2\u9762 <code>${Math.round(triangles).toLocaleString()}</code> \xB7 \u7ED3\u6784\u7EBF <code>${Math.round(stats.segments).toLocaleString()}</code> \u6BB5\uFF08\u9608\u503C ${effectiveThreshold()}\xB0 \u56FA\u5B9A \xB7 \u5168\u91CF\u7ED8\u5236\uFF0C\u4E0D\u505A\u5254\u9664\uFF09 \xB7 \u6784\u5EFA <code>${stats.edgeMs.toFixed(0)}ms</code>`
  ].join("<br>");
}
function buttonGroup(container, options, onSelect, isActive) {
  const entries = options.map((option) => {
    const button = document.createElement("button");
    button.textContent = option.label;
    button.onclick = () => {
      onSelect(option.value);
      syncAll();
    };
    container.appendChild(button);
    return { button, option };
  });
  const sync = () => {
    for (const { button, option } of entries) button.classList.toggle("active", isActive(option.value));
  };
  sync();
  return sync;
}
var groupSyncs = [];
function syncAll() {
  for (const sync of groupSyncs) sync();
}
groupSyncs.push(buttonGroup(
  document.getElementById("variants"),
  [
    { label: "current", value: "current" },
    { label: "ao+strong", value: "ao+strong" },
    { label: "lines", value: "lines" }
  ],
  select,
  (value) => value === active
));
var FACE_COLORS = [
  { label: "\u767D", value: 15922681 },
  // Warmth (R−B) sits between the first cool grey 0xd8dee8 (−16) and the warm
  // 0xdcded8 (+4), and the lightness matches the original to four decimals — so
  // only the hue moves, and the contrast the palette relies on is untouched.
  { label: "\u6D45\u7070", value: 14343906 },
  { label: "\u84DD\u7070", value: 9413567 }
];
groupSyncs.push(buttonGroup(
  document.getElementById("faces"),
  FACE_COLORS,
  (value) => {
    faceColor = value;
    select(active);
  },
  (value) => value === faceColor
));
groupSyncs.push(buttonGroup(
  document.getElementById("edges"),
  [
    { label: "\u968F\u9762\u8272", value: "face" },
    { label: "\u968F\u80CC\u666F", value: "background" },
    { label: "\u517C\u987E\u4E24\u8005", value: "balanced" },
    { label: "\u6DF1\u8272", value: "dark" },
    { label: "\u6D45\u8272", value: "light" }
  ],
  (value) => {
    edgeChoice = value;
    select(active);
  },
  (value) => value === edgeChoice
));
groupSyncs.push(buttonGroup(
  document.getElementById("backgrounds"),
  [
    { label: "\u6DF1\u8272\u80CC\u666F", value: "#14161b" },
    { label: "\u4E2D\u7070\u80CC\u666F", value: "#9aa0a8" },
    { label: "\u6D45\u8272\u80CC\u666F", value: "#f4f6fa" }
  ],
  (value) => {
    backgroundChoice = value;
    applyBackground();
    select(active);
  },
  (value) => value === backgroundChoice
));
applyBackground();
var ring = state.helpers.children.find((child) => child.geometry?.type === "RingGeometry");
if (ring !== void 0) {
  groupSyncs.push(buttonGroup(
    document.getElementById("gridtoggles"),
    [
      { label: "\u7F51\u683C\uFF1A\u5F00", value: true },
      { label: "\u7F51\u683C\uFF1A\u5173", value: false }
    ],
    (value) => {
      state.gridHelper.visible = value;
      syncAll();
    },
    (value) => state.gridHelper.visible === value
  ));
  groupSyncs.push(buttonGroup(
    document.getElementById("gridtoggles"),
    [
      { label: "\u539F\u70B9\u73AF\uFF1A\u5F00", value: true },
      { label: "\u539F\u70B9\u73AF\uFF1A\u5173", value: false }
    ],
    (value) => {
      ring.visible = value;
      syncAll();
    },
    (value) => ring.visible === value
  ));
}
var modelSelect = document.getElementById("models");
for (const model of MODELS) {
  const option = document.createElement("option");
  option.value = model.url;
  option.textContent = `${model.name} (${(model.bytes / 1024).toFixed(0)} KB)`;
  modelSelect.appendChild(option);
}
function showModel(geometry, name) {
  if (mesh !== null) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }
  if (edges !== null) {
    edges.removeFromParent();
    edges.geometry.dispose();
    edges = null;
  }
  geometry.computeVertexNormals();
  mesh = new THREE3.Mesh(geometry, state.material);
  mesh.name = "sample:mesh";
  const root = new THREE3.Group();
  root.rotation.x = modelUpRotation(true);
  root.add(mesh);
  state.scene.add(root);
  state.mesh = root.children[0];
  const edgeMs = rebuildEdges();
  state.zUp = true;
  state.fit();
  state.scene.updateMatrixWorld(true);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  modelRadius = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-3);
  const size = new THREE3.Vector3();
  geometry.boundingBox.getSize(size);
  modelSpan = Math.max(size.x, size.y, size.z, 1e-3);
  updateClipPlanes();
  return {
    edgeMs,
    name,
    segments: edges === null ? 0 : edges.geometry.getAttribute("position").count / 2
  };
}
function parseMesh(buffer) {
  return new STLLoader().parse(buffer);
}
async function loadModel(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const started = performance.now();
  const geometry = parseMesh(buffer);
  const parseMs = performance.now() - started;
  const result = showModel(geometry, url.split("/").pop());
  stats = result;
  stats.parseMs = parseMs;
  select(active);
}
modelSelect.onchange = () => loadModel(modelSelect.value);
try {
  const smallest = [...MODELS].sort((a, b) => a.bytes - b.bytes)[0];
  await loadModel(smallest.url);
  loop();
} catch (error) {
  fail(String(error?.message ?? error));
}
