// The three.js viewport scene (SPEC-5 FR-4/FR-7/FR-14). Owns the WebGL renderer,
// a perspective camera with orbit controls, lighting, and a ground grid, and
// renders exactly one built part at a time. Rebuilding swaps the part in place
// and disposes the old GPU buffers. Pure three.js — no React — so the React
// component (Viewport.tsx) only has to mount/unmount it.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper.js";
import { standardViewDirection, type StandardView } from "./views.js";
import { sectionPlane, type SectionAxis } from "./section.js";
import { findClashes, type Clash } from "./interference.js";
import type { Pick, SelectionMode } from "../store/types.js";
import type { TransferMesh } from "../worker/protocol.js";
import { buildPart, disposePart, type BuiltPart } from "./buildMesh.js";
import { applyHighlight } from "./highlight.js";
import { boxSelect, faceIdAt, ndcRect, Picker } from "./pick.js";
import { decodeId, encodeIdFloat } from "./colorId.js";
import { applyPlacement, readPlacement, IDENTITY_PLACEMENT, type Placement } from "./placement.js";
import { formatMeasurement, measurePoints } from "./measure.js";
import type { Quat, Vec3 } from "../assembly/model.js";

/** Called on a click that resolves (or clears) a selection; additive on Shift. */
export type PickHandler = (pick: Pick | null, additive: boolean) => void;

/** Called when a gizmo drag commits a new body placement (FR-11). */
export type TransformHandler = (placement: Placement) => void;

/** Called with the measure readout (or null when cleared/incomplete). */
export type MeasureHandler = (result: string | null) => void;

/** A face pick on an assembly instance (M4.2): instance + faceId + world point. */
export interface InstanceFacePick {
  instanceId: string;
  faceId: number;
  worldPoint: Vec3;
}
export type InstancePickHandler = (pick: InstanceFacePick) => void;

export class SceneController {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly host: HTMLElement;
  private readonly ro: ResizeObserver;
  private part: BuiltPart | null = null;
  private raf = 0;
  private running = true;

  // --- assembly instance layer (M4) ----------------------------------------
  private readonly instanceGroup = new THREE.Group();
  /** The latest tagged mesh, reused to render each instance of the part. */
  private lastTransfer: TransferMesh | null = null;
  private instanceParts: { id: string; part: BuiltPart }[] = [];
  /** The solid bulk of every instance, drawn in ONE InstancedMesh (NFR-4); the
   * per-instance parts keep their edges/points (solid mesh hidden). */
  private instanceSolid: THREE.InstancedMesh | null = null;
  /** Geometry + faceIds source for the instanced solid (one shared build). */
  private instanceProto: BuiltPart | null = null;
  /** When set, a click resolves to an instance face for mate authoring (M4.2). */
  private instancePickHandler: InstancePickHandler | null = null;
  private readonly instanceRay = new THREE.Raycaster();
  /** Active simulation (M6.1): stepped each frame, drives instance poses. */
  private simulation: {
    ticksPerFrame: number;
    step: (n: number) => void;
    poses: () => { id: string; position: Vec3; orientation: Quat }[];
  } | null = null;
  /** Active section cut (clip plane), or null. Re-fit to the part's bbox on
   * every rebuild/placement so the t-fraction tracks the live geometry. */
  private section: { axis: SectionAxis; t: number } | null = null;

  // --- selection state (FR-8/FR-9) -----------------------------------------
  private readonly picker = new Picker();
  private selMode: SelectionMode = "face";
  private picks: readonly Pick[] = [];
  private hover: Pick | null = null;
  private pickHandler: PickHandler | null = null;
  /** Pointer-down position, to tell a click from an orbit drag. */
  private downAt: { x: number; y: number } | null = null;

  // --- rubber-band box select (FR-10) --------------------------------------
  /** Shift-drag origin (client px) while box-selecting, else null. */
  private boxStart: { x: number; y: number } | null = null;
  private readonly boxOverlay: HTMLDivElement;
  private boxHandler: ((picks: Pick[], additive: boolean) => void) | null = null;

  // --- GPU colour-id picking fallback (NFR-4) ------------------------------
  private readonly idScene = new THREE.Scene();
  private readonly idMaterial: THREE.ShaderMaterial;
  private idTarget: THREE.WebGLRenderTarget | null = null;
  private idMesh: THREE.Mesh | null = null;
  /** The part the cached id mesh was built for (rebuilt when the part swaps). */
  private idMeshPart: BuiltPart | null = null;

  // --- view helper + camera animation (FR-12) ------------------------------
  private readonly viewHelper: ViewHelper;
  private readonly clock = new THREE.Clock();
  private camAnim: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    t: number;
    dur: number;
  } | null = null;

  // --- measure tool (FR-13) ------------------------------------------------
  private measuring = false;
  private measurePts: THREE.Vector3[] = [];
  private readonly measureGroup = new THREE.Group();
  private measureHandler: MeasureHandler | null = null;

  // --- transform gizmo (FR-11) ---------------------------------------------
  private readonly gizmo: TransformControls;
  private transformHandler: TransformHandler | null = null;
  /** The persisted placement; the part group is positioned to match it. */
  private placement: Placement = IDENTITY_PLACEMENT;
  private gizmoVisible = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.scene.background = new THREE.Color(0x0b0d12);

    const { clientWidth: w, clientHeight: h } = host;
    this.camera = new THREE.PerspectiveCamera(45, (w || 1) / (h || 1), 0.001, 100);
    this.camera.position.set(0.12, 0.1, 0.16);
    this.camera.up.set(0, 0, 1); // Z-up, matching the CAD/sim convention.

    // preserveDrawingBuffer so captureThumbnail() can read the canvas back
    // (M5.3 project thumbnails).
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
    // updateStyle=true so the canvas gets a CSS size (host px); see resize().
    this.renderer.setSize(w || 1, h || 1, true);
    host.appendChild(this.renderer.domElement);

    // Rubber-band selection rectangle overlay (FR-10), hidden until a Shift-drag.
    this.boxOverlay = document.createElement("div");
    this.boxOverlay.dataset["testid"] = "box-select-rect";
    Object.assign(this.boxOverlay.style, {
      position: "absolute",
      border: "1px solid #4ea1ff",
      background: "rgba(78,161,255,0.12)",
      pointerEvents: "none",
      display: "none",
      zIndex: "5",
    });
    host.appendChild(this.boxOverlay);

    // GPU id-pick material: outputs the per-vertex `idColor` attribute raw (no
    // lights / tone-mapping / sRGB), so the readback bytes match the encoded id.
    this.idMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 idColor;
        varying vec3 vId;
        void main() { vId = idColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec3 vId;
        void main() { gl_FragColor = vec4(vId, 1.0); }
      `,
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0.02);

    // Transform gizmo: hidden until a component is selected. Dragging it disables
    // the orbit camera; on release the new pose is read off the group and handed
    // back as a parametric placement (FR-11) — the drag is never a free mesh move.
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener("mouseUp", () => this.commitTransform());
    this.scene.add(this.gizmo.getHelper());

    // Clickable axis triad (FR-12): a corner gizmo that reorients the camera to
    // the clicked axis. It renders as an overlay after the main scene.
    this.viewHelper = new ViewHelper(this.camera, this.renderer.domElement);
    this.renderer.autoClear = false;

    this.measureGroup.name = "measure";
    this.scene.add(this.measureGroup);
    this.instanceGroup.name = "instances";
    this.scene.add(this.instanceGroup);

    // Lighting: a key directional + soft ambient so faces read with depth.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.3, -0.4, 0.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-0.3, 0.3, 0.2);
    this.scene.add(fill);

    // Ground grid in the XY plane (Z-up), sized for ~centimetre parts.
    const grid = new THREE.GridHelper(0.4, 40, 0x33405a, 0x1b2230);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default → rotate to XY.
    this.scene.add(grid);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);

    // Pointer-driven selection: hover on move, select on a click (a press that
    // didn't turn into an orbit drag). The capture-phase handlers don't fight
    // OrbitControls, which consumes drags.
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);

    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Replace the rendered geometry with a freshly built part (or clear it). */
  setMesh(transfer: TransferMesh | null): void {
    if (this.part) {
      this.scene.remove(this.part.group);
      disposePart(this.part);
      this.part = null;
    }
    this.lastTransfer = transfer;
    if (!transfer) return;
    this.part = buildPart(transfer);
    applyPlacement(this.part.group, this.placement);
    this.scene.add(this.part.group);
    this.refreshHighlight();
    this.syncGizmoAttachment();
    this.applySection(); // re-fit the section cut to the new geometry's bbox
  }

  /**
   * Render N instances of the part at their poses (M4). With instances present,
   * the single base part is hidden and each instance is an independent clone
   * (shared geometry) tagged with its instanceId for picking. Empty/null shows
   * the base part again.
   */
  setInstances(
    instances: readonly { id: string; position: Vec3; orientation: Quat }[] | null,
  ): void {
    for (const { part } of this.instanceParts) {
      this.instanceGroup.remove(part.group);
      disposePart(part);
    }
    this.instanceParts = [];
    if (this.instanceSolid) {
      this.instanceGroup.remove(this.instanceSolid);
      this.disposeInstanceSolid(this.instanceSolid);
      this.instanceSolid = null;
    }
    if (this.instanceProto) {
      disposePart(this.instanceProto);
      this.instanceProto = null;
    }

    if (!instances || instances.length === 0 || !this.lastTransfer) {
      if (this.part) this.part.group.visible = true;
      return;
    }
    if (this.part) this.part.group.visible = false;

    // Per-instance parts keep edges/points (their solid mesh is hidden); the
    // solid bulk of all instances is drawn once via an InstancedMesh (NFR-4).
    for (const inst of instances) {
      const part = buildPart(this.lastTransfer);
      part.mesh.visible = false; // solid drawn by the InstancedMesh instead
      part.group.position.set(inst.position[0], inst.position[1], inst.position[2]);
      part.group.quaternion.set(
        inst.orientation[0],
        inst.orientation[1],
        inst.orientation[2],
        inst.orientation[3],
      );
      part.group.userData["instanceId"] = inst.id;
      this.instanceParts.push({ id: inst.id, part });
      this.instanceGroup.add(part.group);
    }

    this.instanceProto = buildPart(this.lastTransfer);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd6dbe6, metalness: 0.1, roughness: 0.6 });
    this.instanceSolid = new THREE.InstancedMesh(
      this.instanceProto.mesh.geometry,
      mat,
      instances.length,
    );
    this.instanceSolid.name = "instance-solids";
    this.instanceGroup.add(this.instanceSolid);
    this.syncInstanceMatrices();
  }

  /** Copy each per-instance group's world transform into the InstancedMesh. */
  private syncInstanceMatrices(): void {
    const solid = this.instanceSolid;
    if (!solid) return;
    const m = new THREE.Matrix4();
    this.instanceParts.forEach(({ part }, i) => {
      m.compose(part.group.position, part.group.quaternion, part.group.scale);
      solid.setMatrixAt(i, m);
    });
    solid.instanceMatrix.needsUpdate = true;
    solid.computeBoundingSphere();
  }

  /** Free an instanced solid: its material(s) AND its instance GPU buffers.
   * (InstancedMesh.dispose only frees instanceMatrix/instanceColor, not the
   * material we allocated, so dispose the material too.) */
  private disposeInstanceSolid(solid: THREE.InstancedMesh): void {
    const mat = solid.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    solid.dispose();
  }

  /** Author mates by clicking instance faces; null disables it (M4.2). */
  setInstancePickHandler(handler: InstancePickHandler | null): void {
    this.instancePickHandler = handler;
  }

  /** Reposition existing instance groups by id, without rebuilding (M6.1 sim). */
  setInstancePoses(poses: readonly { id: string; position: Vec3; orientation: Quat }[]): void {
    for (const p of poses) {
      const entry = this.instanceParts.find((e) => e.id === p.id);
      if (!entry) continue;
      entry.part.group.position.set(p.position[0], p.position[1], p.position[2]);
      entry.part.group.quaternion.set(
        p.orientation[0],
        p.orientation[1],
        p.orientation[2],
        p.orientation[3],
      );
    }
    this.syncInstanceMatrices();
  }

  /**
   * Drive the instance layer from a simulation (M6.1). Each frame the sim steps
   * a fixed number of ticks and its body poses update the instance groups; null
   * stops it (the caller re-derives the render from the document).
   */
  setSimulation(
    sim: {
      ticksPerFrame: number;
      step: (n: number) => void;
      poses: () => { id: string; position: Vec3; orientation: Quat }[];
    } | null,
  ): void {
    this.simulation = sim;
  }

  /** Resolve a click to a face on an assembly instance (world hit point). The
   * solid is one InstancedMesh, so the hit carries `instanceId` (which instance)
   * and `faceIndex` (which triangle → faceId via the shared proto). */
  private pickInstanceFace(ndc: THREE.Vector2): InstanceFacePick | null {
    if (!this.instanceSolid || !this.instanceProto) return null;
    this.instanceRay.setFromCamera(ndc, this.camera);
    const hit = this.instanceRay.intersectObject(this.instanceSolid, false)[0];
    if (!hit || hit.faceIndex == null || hit.instanceId == null) return null;
    const entry = this.instanceParts[hit.instanceId];
    if (!entry) return null;
    const faceId = faceIdAt(this.instanceProto, hit.faceIndex);
    if (faceId == null) return null;
    return { instanceId: entry.id, faceId, worldPoint: [hit.point.x, hit.point.y, hit.point.z] };
  }

  /** Set the persisted placement and position the part group to match (FR-11). */
  setPlacement(p: Placement): void {
    this.placement = p;
    if (this.part) applyPlacement(this.part.group, p);
    if (this.section) this.applySection(); // the bbox moved with the placement
  }

  /** Enable/adjust the section cut (clip plane), or disable it (null). */
  setSection(section: { axis: SectionAxis; t: number } | null): void {
    this.section = section;
    this.applySection();
  }

  /** Bounding-box (broad-phase) interference between the assembly instances:
   * the clashing id pairs. Each instance's world AABB is taken from its posed
   * part group; conservative for rotated/non-box parts, exact for axis-aligned
   * boxes. Empty when fewer than two instances are placed. */
  findInterferences(): Clash[] {
    this.instanceGroup.updateMatrixWorld(true); // poses may be set but not yet drawn
    const boxes = this.instanceParts.map(({ id, part }) => {
      const b = new THREE.Box3().setFromObject(part.group);
      return {
        id,
        min: [b.min.x, b.min.y, b.min.z] as [number, number, number],
        max: [b.max.x, b.max.y, b.max.z] as [number, number, number],
      };
    });
    return findClashes(boxes);
  }

  /** Recompute the world clip plane from the current part's bbox + section state.
   * Global renderer.clippingPlanes clip every rendered object (part + instances). */
  private applySection(): void {
    if (!this.section || !this.part) {
      this.renderer.clippingPlanes = [];
      return;
    }
    const box = new THREE.Box3().setFromObject(this.part.group);
    const { axis, t } = this.section;
    const min = axis === "x" ? box.min.x : axis === "y" ? box.min.y : box.min.z;
    const max = axis === "x" ? box.max.x : axis === "y" ? box.max.y : box.max.z;
    const { normal, constant } = sectionPlane(min, max, axis, t);
    this.renderer.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(normal[0], normal[1], normal[2]), constant),
    ];
  }

  /** Show/hide the transform gizmo (shown when a component is selected). */
  showGizmo(visible: boolean): void {
    this.gizmoVisible = visible;
    this.syncGizmoAttachment();
  }

  /** Switch the gizmo between translate and rotate (FR-11). */
  setTransformMode(mode: "translate" | "rotate"): void {
    this.gizmo.setMode(mode);
  }

  setTransformHandler(handler: TransformHandler): void {
    this.transformHandler = handler;
  }

  setMeasureHandler(handler: MeasureHandler): void {
    this.measureHandler = handler;
  }

  /** Enter/leave measure mode (FR-13); leaving clears the in-progress markers. */
  setMeasuring(active: boolean): void {
    this.measuring = active;
    if (!active) this.resetMeasure();
  }

  private resetMeasure(): void {
    this.measurePts = [];
    for (const c of this.measureGroup.children) {
      const o = c as THREE.Mesh | THREE.Line;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.measureGroup.clear();
  }

  /** Record a measure point; on the second point compute + report the distance. */
  private addMeasurePoint(p: THREE.Vector3): void {
    if (this.measurePts.length >= 2) this.resetMeasure(); // start a fresh measure
    this.measurePts.push(p.clone());

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.0015, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd34a, depthTest: false }),
    );
    marker.position.copy(p);
    marker.renderOrder = 999;
    this.measureGroup.add(marker);

    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts as [THREE.Vector3, THREE.Vector3];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0xffd34a, depthTest: false }),
      );
      line.renderOrder = 999;
      this.measureGroup.add(line);
      this.measureHandler?.(formatMeasurement(measurePoints(a, b)));
    } else {
      this.measureHandler?.(null);
    }
  }

  private syncGizmoAttachment(): void {
    if (this.gizmoVisible && this.part) this.gizmo.attach(this.part.group);
    else this.gizmo.detach();
  }

  /** Read the dragged group's pose back as a placement and persist it (FR-11). */
  private commitTransform(): void {
    if (!this.part) return;
    const p = readPlacement(this.part.group);
    this.placement = p;
    this.transformHandler?.(p);
  }

  /** Set which entity kind is pickable; clears the transient hover. */
  setSelectionMode(mode: SelectionMode): void {
    this.selMode = mode;
    this.hover = null;
    this.refreshHighlight();
  }

  /** Update the selected set (driven by the store) and repaint highlights. */
  setPicks(picks: readonly Pick[]): void {
    this.picks = picks;
    this.refreshHighlight();
  }

  /** Register the click→selection callback (Viewport writes it to the store). */
  setPickHandler(handler: PickHandler): void {
    this.pickHandler = handler;
  }

  private refreshHighlight(): void {
    if (this.part) applyHighlight(this.part, this.picks, this.hover);
  }

  /** Pointer event → normalized device coords against the canvas rect. */
  private ndcFrom(e: PointerEvent): THREE.Vector2 {
    return this.ndcFromClient(e.clientX, e.clientY);
  }

  private ndcFromClient(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  /** Install the rubber-band box-select callback (FR-10). */
  setBoxSelectHandler(handler: (picks: Pick[], additive: boolean) => void): void {
    this.boxHandler = handler;
  }

  /** (Re)build the id-pick mesh for the current part: the same geometry with a
   * per-face `idColor` attribute (each face's vertices coloured by its faceId). */
  private ensureIdMesh(): THREE.Mesh | null {
    if (!this.part) return null;
    if (this.idMeshPart === this.part && this.idMesh) return this.idMesh;
    if (this.idMesh) this.idScene.remove(this.idMesh);
    const geom = this.part.mesh.geometry;
    const faceIds = this.part.mesh.userData["faceIds"] as number[] | undefined;
    const index = geom.getIndex();
    const pos = geom.getAttribute("position");
    if (!faceIds || !index) return null;
    const colors = new Float32Array(pos.count * 3);
    geom.groups.forEach((g, gi) => {
      const id = faceIds[gi];
      if (id == null) return;
      const [r, gg, b] = encodeIdFloat(id);
      for (let k = g.start; k < g.start + g.count; k++) {
        const vi = index.getX(k);
        colors[vi * 3] = r;
        colors[vi * 3 + 1] = gg;
        colors[vi * 3 + 2] = b;
      }
    });
    geom.setAttribute("idColor", new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geom, this.idMaterial);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    this.idScene.add(mesh);
    this.idMesh = mesh;
    this.idMeshPart = this.part;
    return mesh;
  }

  /**
   * GPU colour-id face pick (NFR-4 fallback): render the part's faces id-coloured
   * to an offscreen buffer and read back the pixel under `ndc`. Returns the
   * faceId, or null on a miss (the cleared buffer).
   */
  /** Does the cursor ray pass near the part's world bounds? (gates the GPU pick) */
  private rayHitsPart(ndc: { x: number; y: number }): boolean {
    if (!this.part) return false;
    const box = new THREE.Box3().setFromObject(this.part.group);
    if (box.isEmpty()) return false;
    this.instanceRay.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    return this.instanceRay.ray.intersectsBox(box);
  }

  gpuPickFace(ndc: { x: number; y: number }): number | null {
    const mesh = this.ensureIdMesh();
    if (!mesh || !this.part) return null;
    this.part.mesh.updateWorldMatrix(true, false);
    mesh.matrix.copy(this.part.mesh.matrixWorld);
    mesh.matrixWorld.copy(this.part.mesh.matrixWorld);

    const w = Math.max(1, Math.floor(this.renderer.domElement.width));
    const h = Math.max(1, Math.floor(this.renderer.domElement.height));
    if (!this.idTarget) this.idTarget = new THREE.WebGLRenderTarget(w, h);
    else if (this.idTarget.width !== w || this.idTarget.height !== h) this.idTarget.setSize(w, h);

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.idTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.idScene, this.camera);

    // NDC (−1..1, y up) → buffer pixel (origin bottom-left for readback).
    const px = Math.min(w - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * w)));
    const py = Math.min(h - 1, Math.max(0, Math.round((ndc.y * 0.5 + 0.5) * h)));
    const buf = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.idTarget, px, py, 1, 1, buf);
    this.renderer.setRenderTarget(prevTarget);
    return decodeId(buf[0]!, buf[1]!, buf[2]!);
  }

  /** Draw the rubber-band rectangle (host-relative px) from the drag origin. */
  private updateBoxOverlay(curX: number, curY: number): void {
    const r = this.host.getBoundingClientRect();
    const x0 = this.boxStart!.x - r.left;
    const y0 = this.boxStart!.y - r.top;
    const x1 = curX - r.left;
    const y1 = curY - r.top;
    Object.assign(this.boxOverlay.style, {
      display: "block",
      left: `${Math.min(x0, x1)}px`,
      top: `${Math.min(y0, y1)}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
  }

  /** Representative NDC points of every pickable entity for the current mode. */
  private selectionCandidates(): { id: number; x: number; y: number }[] {
    if (!this.part) return [];
    const project = (p: THREE.Vector3): { x: number; y: number } => {
      const v = p.clone().project(this.camera);
      return { x: v.x, y: v.y };
    };
    const out: { id: number; x: number; y: number }[] = [];
    if (this.selMode === "edge") {
      for (const line of this.part.edges) {
        const id = line.userData["edgeId"];
        if (typeof id !== "number") continue;
        line.geometry.computeBoundingSphere();
        const c = line.geometry.boundingSphere?.center;
        if (c) {
          const w = c.clone().applyMatrix4(line.matrixWorld);
          out.push({ id, ...project(w) });
        }
      }
      return out;
    }
    if (this.selMode === "vertex" && this.part.vertexPoints) {
      const vp = this.part.vertexPoints;
      const ids = vp.userData["vertexIds"] as number[] | undefined;
      const pos = vp.geometry.getAttribute("position");
      if (ids) {
        for (let i = 0; i < ids.length; i++) {
          const w = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(vp.matrixWorld);
          out.push({ id: ids[i]!, ...project(w) });
        }
      }
      return out;
    }
    // face / body: the centroid of each per-face triangle group.
    const mesh = this.part.mesh;
    const faceIds = mesh.userData["faceIds"] as number[] | undefined;
    const geom = mesh.geometry;
    const pos = geom.getAttribute("position");
    const index = geom.getIndex();
    if (!faceIds || !index) return out;
    mesh.updateWorldMatrix(true, false);
    geom.groups.forEach((g, gi) => {
      const id = faceIds[gi];
      if (id == null) return;
      const c = new THREE.Vector3();
      const v = new THREE.Vector3();
      for (let k = g.start; k < g.start + g.count; k++) {
        c.add(v.fromBufferAttribute(pos, index.getX(k)));
      }
      if (g.count > 0) c.multiplyScalar(1 / g.count).applyMatrix4(mesh.matrixWorld);
      out.push({ id, ...project(c) });
    });
    return out;
  }

  /** Box-select the entities whose representative point lies in the dragged rect. */
  private finishBoxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    if (!this.boxHandler || !this.part) return;
    const a = this.ndcFromClient(x0, y0);
    const b = this.ndcFromClient(x1, y1);
    const rect = ndcRect({ x: a.x, y: a.y }, { x: b.x, y: b.y });
    const ids = boxSelect(rect, this.selectionCandidates());
    const picks: Pick[] =
      this.selMode === "body"
        ? ids.length > 0
          ? [{ kind: "body", id: 0 }]
          : []
        : ids.map((id) => ({ kind: this.selMode, id }));
    this.boxHandler(picks, additive);
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.part) return;
    // Shift-drag past the click threshold becomes a rubber-band box select; it
    // suppresses orbit + hover while active (FR-10).
    if (this.boxStart) {
      if (Math.hypot(e.clientX - this.boxStart.x, e.clientY - this.boxStart.y) > 4) {
        this.controls.enabled = false;
        this.updateBoxOverlay(e.clientX, e.clientY);
      }
      return;
    }
    const next = this.picker.pick(this.part, this.ndcFrom(e), this.camera, this.selMode);
    const changed =
      (next?.id ?? null) !== (this.hover?.id ?? null) ||
      (next?.kind ?? null) !== (this.hover?.kind ?? null);
    if (changed) {
      this.hover = next;
      this.refreshHighlight();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    // A click on the corner view triad reorients the camera; swallow it so it
    // doesn't also select or orbit.
    if (this.viewHelper.handleClick(e)) {
      this.downAt = null;
      return;
    }
    this.downAt = { x: e.clientX, y: e.clientY };
    // Shift-drag starts a box select (a Shift-click without movement still falls
    // through to additive single-pick).
    if (e.shiftKey && this.boxHandler) this.boxStart = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.downAt;
    this.downAt = null;
    // Finish a rubber-band box select if one was dragged (FR-10).
    const box = this.boxStart;
    this.boxStart = null;
    if (box && this.boxOverlay.style.display !== "none") {
      this.controls.enabled = true;
      this.boxOverlay.style.display = "none";
      this.finishBoxSelect(box.x, box.y, e.clientX, e.clientY, e.ctrlKey || e.metaKey);
      return;
    }
    this.controls.enabled = true;
    if (!down || !this.part) return;
    // A drag (orbit) moves the pointer; only a near-stationary release acts.
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const ndc = this.ndcFrom(e);

    // Assembly mate authoring: a click resolves to an instance face (M4.2).
    if (this.instancePickHandler && this.instanceParts.length > 0) {
      const ip = this.pickInstanceFace(ndc);
      if (ip) this.instancePickHandler(ip);
      return;
    }

    if (this.measuring) {
      const p = this.picker.pickPoint(this.part, ndc, this.camera);
      if (p) this.addMeasurePoint(p);
      return;
    }

    if (!this.pickHandler) return;
    let pick = this.picker.pick(this.part, ndc, this.camera, this.selMode);
    // GPU colour-id fallback (NFR-4): if the ray/triangle test just missed a
    // face/body, the id buffer may still have a fragment under the cursor. Gated
    // on a cheap ray–bounds test so an empty-space deselect click doesn't pay the
    // offscreen render + GPU→CPU readback.
    if (!pick && (this.selMode === "face" || this.selMode === "body") && this.rayHitsPart(ndc)) {
      const id = this.gpuPickFace(ndc);
      if (id != null) pick = { kind: this.selMode, id };
    }
    this.pickHandler(pick, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  /** The current part (for picking in M1), or null if the scene is empty. */
  get builtPart(): BuiltPart | null {
    return this.part;
  }

  /**
   * Render the scene and capture a downscaled PNG data-URL of the viewport for
   * a project thumbnail (M5.3 / FR-43). `size` is the max edge in pixels.
   */
  captureThumbnail(size = 256): string {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const w = src.width;
    const h = src.height;
    if (w === 0 || h === 0) return "";
    const scale = Math.min(1, size / Math.max(w, h));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Re-apply devicePixelRatio so moving to a different-density monitor stays
    // crisp (it can change without a code path other than a resize; §5.8).
    this.renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
    // updateStyle=true: set the canvas CSS size to the host's CSS px while the
    // drawing buffer stays w·dpr × h·dpr. With updateStyle=false the canvas had
    // no CSS size, so on a HiDPI display (dpr=2) it displayed at the 2× buffer
    // size and the scene rendered off the visible viewport (blank canvas).
    this.renderer.setSize(w, h, true);
  }

  private tick(): void {
    if (!this.running) return;
    const delta = this.clock.getDelta();
    this.advanceCameraAnim(delta);
    if (this.viewHelper.animating) this.viewHelper.update(delta);
    // Simulation (M6.1): fixed-tick step, then drive the instance groups from
    // the live body poses (deterministic — not scaled by wall-clock delta).
    if (this.simulation) {
      this.simulation.step(this.simulation.ticksPerFrame);
      this.setInstancePoses(this.simulation.poses());
    }
    this.controls.update();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.viewHelper.render(this.renderer);
    this.raf = requestAnimationFrame(this.tick);
  }

  // --- standard views / fit (FR-12) ----------------------------------------

  /** Animate the camera to a named standard view, keeping the current framing. */
  standardView(view: StandardView): void {
    this.setViewDirection(standardViewDirection(view));
  }

  /** Animate the camera so it looks along `dir` (target → camera), keeping the
   * current target + framing. Used by the clickable view cube (FR-12). */
  setViewDirection(dir: THREE.Vector3): void {
    const target = this.controls.target.clone();
    const radius = this.camera.position.distanceTo(target) || 0.2;
    this.animateCameraTo(target.clone().addScaledVector(dir.clone().normalize(), radius), target);
  }

  /** Frame the current part (or the grid) so it fills the view (FR-12). */
  fitToView(): void {
    const box = new THREE.Box3();
    if (this.part) box.setFromObject(this.part.group);
    if (box.isEmpty())
      box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(0.1, 0.1, 0.1));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    // Distance so the bounding sphere fits the vertical FOV, with margin.
    const dist = (radius * 1.6) / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 1e-9) dir.set(standardViewDirection("iso").x, 0, 0);
    this.animateCameraTo(center.clone().addScaledVector(dir, dist), center);
  }

  private animateCameraTo(toPos: THREE.Vector3, toTarget: THREE.Vector3, dur = 0.4): void {
    this.camAnim = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
      t: 0,
      dur,
    };
  }

  private advanceCameraAnim(delta: number): void {
    const a = this.camAnim;
    if (!a) return;
    a.t = Math.min(1, a.t + delta / a.dur);
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - (-2 * a.t + 2) ** 2 / 2; // easeInOutQuad
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
    if (a.t >= 1) this.camAnim = null;
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointerup", this.onPointerUp);
    this.resetMeasure();
    for (const { part } of this.instanceParts) disposePart(part);
    this.instanceParts = [];
    if (this.instanceSolid) this.disposeInstanceSolid(this.instanceSolid);
    if (this.instanceProto) disposePart(this.instanceProto);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.viewHelper.dispose();
    this.controls.dispose();
    if (this.part) disposePart(this.part);
    this.renderer.dispose();
    el.remove();
    this.boxOverlay.remove();
    this.idTarget?.dispose();
    this.idMaterial.dispose();
  }
}
