// The shared action registry: one ActionDef per user action (id, label, enabled,
// run, optional icon/active). It is the single source of run/enabled/label logic
// for BOTH surfaces that present actions — the right-click context menu and the
// workspace ribbon. The context-menu's catalog (three/contextmenu/config.ts) is
// the home of the selection-driven actions; this registry re-exposes them as
// ActionDefs (dropping the menu-only `visible`/`group`) and ADDS the ribbon/toolbar
// ops that the context menu never had (loft, sweep, combine, I/O, undo/redo,
// selection mode, insert instance). The ribbon lists a panel's full tool set and
// greys via `enabled` — it never uses the context menu's `visible`.

import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { assemblyToAssy, parseAssy, realizeAssembly } from "../assembly/assy.js";
import { startingSketchModel } from "../sketch/defaultPlane.js";
import { getProjectableEdgePolylines } from "../sketch/projectableEdges.js";
import type { AssemblyModel } from "../assembly/model.js";
import { voxelDocToMesh } from "../voxel/doc.js";
import { voxelMeshToGlbBase64 } from "../voxel/glb.js";
import { exportMeshGlb } from "../mesh/exportGlb.js";
import type { EdgeRef, FaceRef, NurbsSurface, VertexRef } from "@plastiq/cad";
import {
  planeSurface,
  cylinderSurface,
  sphereSurface,
  worldPolylinesToPlaneSegments,
} from "@plastiq/cad";
import {
  booleanBodyFeature,
  edgeRefsFromPicks,
  faceRefsFromPicks,
  loftFromSketchFeatures,
  surfaceLoftFromSketchFeatures,
  surfaceSweepFromSketchFeature,
  surfaceSweepFromSketchAlongPickedEdges,
  sweepFromSketchFeature,
  sweepFromSketchAlongPickedEdges,
  helixSweepFromSketchFeature,
  vertexRefsFromPicks,
} from "../viewport/dressup.js";
import type { Profile } from "../sketch/profile.js";
import type { MeshDoc, SelectionMode } from "../store/types.js";
import { CONTEXT_ACTIONS } from "../three/contextmenu/config.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";
import { useSketchStore } from "../sketch/sketchStore.js";

/** A user action, surface-agnostic. `enabled`/`label` are evaluated against the
 * resolved ContextTarget; `run` performs the real side effect. */
export interface ActionDef {
  id: string;
  label: (ctx: ContextTarget) => string;
  /** Optional glyph for the ribbon button. */
  icon?: string;
  enabled: (ctx: ContextTarget) => boolean;
  run: (ctx: ContextTarget) => void;
  /** Optional toggle-active predicate (e.g. selection mode / section on) for the ribbon. */
  active?: (ctx: ContextTarget) => boolean;
  /**
   * Optional context visibility (from the context-menu catalog). The ribbon greys
   * via `enabled` only; the command palette filters on this so sketch/sim actions
   * that are `enabled: always` do not appear runnable outside their context (R13/C3).
   * Absent → always visible in the palette.
   */
  visible?: (ctx: ContextTarget) => boolean;
}

const cad = (): ReturnType<typeof useCadStore.getState> => useCadStore.getState();
const vox = (): ReturnType<typeof useVoxelStore.getState> => useVoxelStore.getState();
const always = (): boolean => true;

type V3 = [number, number, number];

/** Unit vector, or null if near-zero. */
function unit3(v: readonly [number, number, number]): V3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Edge tangent from the EdgeRef signature (n0 × n1). Valid for two planar faces
 * meeting at a straight edge — the same signature tessellation stores — so the
 * ribbon can bake direction without an OCCT round-trip (C6).
 */
function edgeDirectionFromRef(edge: EdgeRef): V3 | null {
  const [n0, n1] = edge.faceNormals;
  return unit3([
    n0[1] * n1[2] - n0[2] * n1[1],
    n0[2] * n1[0] - n0[0] * n1[2],
    n0[0] * n1[1] - n0[1] * n1[0],
  ]);
}

function faceOrigin(face: FaceRef, fallback: V3): V3 {
  const c = face.centroid;
  return c ? [c[0], c[1], c[2]] : fallback;
}

/** SI origin from a VertexRef signature (R12) — the B-rep corner point. */
function vertexOrigin(v: VertexRef): V3 {
  return [v.position[0], v.position[1], v.position[2]];
}

/**
 * Placement params for a round primitive (§4.11), selection-driven per the C6
 * convention: a picked face gives its centroid as the origin and its normal as
 * the axis, so "select a face → Cylinder" lands a boss (or, with op:"cut", a
 * bore) ON that face. A picked vertex (R12) places the origin on that corner's
 * VertexRef.position (still a vector in params — the hole/primitive contract).
 * With nothing picked it falls back to the world origin, +Z.
 *
 * Returns EVERY placement key even at its default — see the §9 note at the
 * primitive actions: the properties panel can only edit params that creation
 * baked, so an omitted key is an uneditable one forever.
 */
function primitivePlacementParams(ctx: ContextTarget): Record<string, number> {
  // Vertex pick wins for origin: a corner is a more precise point placement
  // than a face centroid (R12 measure / hole / point placements).
  const vertex = vertexRefsFromPicks(ctx.picks, ctx.refs)[0];
  const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
  const axis = face ? unit3(face.normal) : null;
  const origin = vertex
    ? vertexOrigin(vertex)
    : face
      ? faceOrigin(face, ctx.worldPoint)
      : ([0, 0, 0] as V3);
  const a = axis ?? ([0, 0, 1] as V3);
  return {
    ox: origin[0],
    oy: origin[1],
    oz: origin[2],
    ax: a[0],
    ay: a[1],
    az: a[2],
    // A full revolution. The evaluator treats angle >= 2π as "no partial sweep"
    // and selects OCCT's full-solid ctor, so this default is the complete solid
    // while still being present for the panel to edit down to a wedge.
    angle: 2 * Math.PI,
  };
}

/** The round-primitive ribbon actions, plus Bore (§4.11). */
function primitiveActions(): ActionDef[] {
  const specs: {
    id: string;
    type: string;
    label: string;
    icon: string;
    params: Record<string, number>;
  }[] = [
    // Defaults are SI metres, matching every other registry default (§4.9).
    {
      id: "cylinder",
      type: "cylinder",
      label: "Cylinder",
      icon: "⬭",
      params: { radius: 0.01, height: 0.03 },
    },
    { id: "sphere", type: "sphere", label: "Sphere", icon: "●", params: { radius: 0.015 } },
    {
      id: "cone",
      type: "cone",
      label: "Cone",
      icon: "▲",
      params: { radius1: 0.015, radius2: 0, height: 0.03 },
    },
    {
      id: "torus",
      type: "torus",
      label: "Torus",
      icon: "◎",
      params: { majorRadius: 0.02, minorRadius: 0.006 },
    },
  ];
  const additive: ActionDef[] = specs.map(({ id, type, label, icon, params }) => ({
    id,
    label: () => label,
    icon,
    enabled: always,
    run: (ctx: ContextTarget) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      cad().addFeature({
        type,
        params: { ...params, ...primitivePlacementParams(ctx) },
        // Join-by-default once a body exists (the extrude convention).
        data: { op: "join" },
      });
      cad().setStatus(
        face
          ? `${label}: added on the selected face, grown along its outward normal — use Bore to cut INTO a face`
          : `${label}: added at the origin along +Z — select a face first to place it there`,
      );
    },
  }));
  return [...additive, boreAction(), holeAction(), thickenAction(), ...freeformActions()];
}

/**
 * §13.2/§14 thicken — grow the current solid (typically an open face/shell from
 * a surface feature, or any sheet body) into a solid plate of wall `thickness`.
 * Requires an existing body; thickness + bothSides are editable in Properties.
 */
function thickenAction(): ActionDef {
  return {
    id: "thicken",
    label: () => "Thicken",
    icon: "▥",
    // Enabled when any solid exists (the rebuild path errors if none).
    enabled: always,
    run: () => {
      cad().addFeature({
        type: "thicken",
        params: { thickness: 0.002 },
        data: { bothSides: false },
      });
      cad().setStatus(
        "Thicken: 2 mm wall on the current body — edit thickness / bothSides in Properties",
      );
    },
  };
}

/** §13.2 real hole feature — a proper parametric hole (simple/counterbore/
 * countersink/spotface, blind or through, drill tip) driven by the kernel `hole`
 * op, versus `bore`'s single composed cylinder-cut. Drills along the picked
 * face's INWARD normal. Every dimension + the kind are editable in Properties.
 *
 * Origin remains a 3-vector in feature data (the hole kernel contract). When the
 * selection includes a vertex, the origin is taken from that VertexRef's
 * position signature (R12) and the VertexRef is also stored as `originVertex` so
 * a rebuild can re-resolve the corner after an upstream edit. */
function holeAction(): ActionDef {
  return {
    id: "hole",
    label: () => "Hole",
    icon: "⌾",
    enabled: (ctx) => faceRefsFromPicks(ctx.picks, ctx.refs).length > 0,
    run: (ctx) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (!face) return;
      const n = unit3(face.normal) ?? ([0, 0, 1] as V3);
      // Prefer a co-selected vertex's VertexRef for the drill point (R12); else
      // face centroid / click world point as before.
      const vertex = vertexRefsFromPicks(ctx.picks, ctx.refs)[0];
      const o = vertex ? vertexOrigin(vertex) : faceOrigin(face, ctx.worldPoint);
      cad().addFeature({
        type: "hole",
        params: { diameter: 0.006, depth: 0.02 },
        data: {
          origin: [o[0], o[1], o[2]],
          axis: [-n[0], -n[1], -n[2]], // drill INTO the body along the inward normal
          kind: "simple",
          // Persistent corner signature when the origin came from a vertex pick.
          ...(vertex ? { originVertex: vertex } : {}),
        },
      });
      cad().setStatus(
        vertex
          ? "Hole: Ø6 × 20 mm at the selected vertex into the face — set diameter/depth and kind in Properties"
          : "Hole: Ø6 × 20 mm into the selected face — set diameter/depth and kind (counterbore/countersink) in Properties",
      );
    },
  };
}

/** Serialize a freeform NurbsSurface into plain JSON for feature.data.surface. */
function serializeFreeformSurface(s: NurbsSurface): Record<string, unknown> {
  const out: Record<string, unknown> = {
    degU: s.degU,
    degV: s.degV,
    knotsU: s.knotsU.slice(),
    knotsV: s.knotsV.slice(),
    controlNet: s.controlNet.map((row) => row.map((p) => [p[0], p[1], p[2]] as V3)),
  };
  if (s.weights) out.weights = s.weights.map((row) => row.slice());
  return out;
}

/**
 * §15 freeform primitives — plane / cylinder / sphere control-lattice generators.
 * Stores NurbsSurface JSON on the feature; rebuild samples via pure-TS evaluate
 * and commits a face Solid through surfaceFromPoints (viewport tessellation path).
 */
function freeformActions(): ActionDef[] {
  return [
    {
      id: "freeform-plane",
      label: () => "Freeform Plane",
      icon: "▱",
      enabled: always,
      run: (ctx) => {
        const place = primitivePlacementParams(ctx);
        const origin: V3 = [place.ox!, place.oy!, place.oz!];
        // Build a local frame from the picked face normal (or +Z): u along a
        // helper ⊥ normal, v = n × u so the plane lies on the face.
        const n = unit3([place.ax!, place.ay!, place.az!]) ?? ([0, 0, 1] as V3);
        const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const ux = n[1] * helper[2] - n[2] * helper[1];
        const uy = n[2] * helper[0] - n[0] * helper[2];
        const uz = n[0] * helper[1] - n[1] * helper[0];
        const ul = Math.hypot(ux, uy, uz) || 1;
        const uDir: V3 = [ux / ul, uy / ul, uz / ul];
        const vDir: V3 = [
          n[1] * uDir[2] - n[2] * uDir[1],
          n[2] * uDir[0] - n[0] * uDir[2],
          n[0] * uDir[1] - n[1] * uDir[0],
        ];
        const uSize = 0.04;
        const vSize = 0.03;
        const surface = planeSurface(origin, uDir, vDir, uSize, vSize);
        cad().addFeature({
          type: "freeform",
          name: "Freeform Plane",
          params: {
            uSize,
            vSize,
            ox: origin[0],
            oy: origin[1],
            oz: origin[2],
            resU: 8,
            resV: 8,
          },
          data: {
            kind: "plane",
            uDir,
            vDir,
            surface: serializeFreeformSurface(surface),
            op: "new",
          },
        });
        cad().setStatus("Freeform plane: 40 × 30 mm NURBS patch — edit sizes in Properties");
      },
    },
    {
      id: "freeform-cylinder",
      label: () => "Freeform Cylinder",
      icon: "⌭",
      enabled: always,
      run: (ctx) => {
        const place = primitivePlacementParams(ctx);
        const origin: V3 = [place.ox!, place.oy!, place.oz!];
        const axis: V3 = [place.ax!, place.ay!, place.az!];
        const radius = 0.01;
        const height = 0.03;
        const surface = cylinderSurface(origin, axis, radius, height);
        cad().addFeature({
          type: "freeform",
          name: "Freeform Cylinder",
          params: {
            radius,
            height,
            ox: origin[0],
            oy: origin[1],
            oz: origin[2],
            ax: axis[0],
            ay: axis[1],
            az: axis[2],
            resU: 16,
            resV: 8,
          },
          data: {
            kind: "cylinder",
            surface: serializeFreeformSurface(surface),
            op: "new",
          },
        });
        cad().setStatus(
          "Freeform cylinder: Ø20 × 30 mm NURBS wall — edit radius/height in Properties",
        );
      },
    },
    {
      id: "freeform-sphere",
      label: () => "Freeform Sphere",
      icon: "◍",
      enabled: always,
      run: (ctx) => {
        const place = primitivePlacementParams(ctx);
        const origin: V3 = [place.ox!, place.oy!, place.oz!];
        const radius = 0.015;
        const surface = sphereSurface(origin, radius);
        cad().addFeature({
          type: "freeform",
          name: "Freeform Sphere",
          params: {
            radius,
            ox: origin[0],
            oy: origin[1],
            oz: origin[2],
            resU: 16,
            resV: 12,
          },
          data: {
            kind: "sphere",
            surface: serializeFreeformSurface(surface),
            op: "new",
          },
        });
        cad().setStatus("Freeform sphere: Ø30 mm NURBS surface — edit radius in Properties");
      },
    },
  ];
}

/**
 * Bore — a cylinder that CUTS INTO the picked face (§4.11).
 *
 * This exists because the additive placement above cannot be reused for a cut.
 * The primitives grow along the face's OUTWARD normal, which is right for a
 * boss and useless for a hole: the tool sits entirely outside the material, so
 * flipping Op to "cut" in Properties removes exactly nothing (verified — the
 * box's volume came back unchanged). An earlier status text here told users to
 * do precisely that; it was promising an operation the placement could not
 * perform, which is the same honesty defect as §2.3's fictional sweep editor.
 *
 * So the tool is aimed along the INWARD normal instead, and starts slightly
 * proud of the face: a tool face exactly coincident with the target's is the
 * classic boolean corner case, and the overshoot costs nothing because the
 * material above the face is already outside the solid.
 */
function boreAction(): ActionDef {
  const OVERSHOOT = 1e-4; // 0.1 mm proud of the face — well above the 1e-7 fuzz.
  return {
    id: "bore",
    label: () => "Bore",
    icon: "◍",
    // A bore is meaningless without a face to cut into: with nothing picked
    // there is no inward direction to infer, and a silently-misplaced cut is
    // exactly the "it did nothing" failure this action exists to avoid.
    enabled: (ctx) => faceRefsFromPicks(ctx.picks, ctx.refs).length > 0,
    run: (ctx) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (!face) return;
      const n = unit3(face.normal) ?? ([0, 0, 1] as V3);
      const o = faceOrigin(face, ctx.worldPoint);
      const depth = 0.03;
      cad().addFeature({
        type: "cylinder",
        params: {
          radius: 0.005,
          // The overshoot is added to the depth too, so the requested depth is
          // measured from the FACE rather than from the start of the tool.
          height: depth + OVERSHOOT,
          ox: o[0] + n[0] * OVERSHOOT,
          oy: o[1] + n[1] * OVERSHOOT,
          oz: o[2] + n[2] * OVERSHOOT,
          ax: -n[0],
          ay: -n[1],
          az: -n[2],
          angle: 2 * Math.PI,
        },
        data: { op: "cut" },
      });
      cad().setStatus(
        "Bore: cutting into the selected face along its inward normal — set Radius / Height in Properties",
      );
    },
  };
}

function edgeOrigin(edge: EdgeRef, fallback: V3): V3 {
  const m = edge.midpoint;
  return m ? [m[0], m[1], m[2]] : fallback;
}

/** A rectangle inside the seeded box footprint, so an appended Extrude/Cut has a
 * profile to consume without opening the sketcher (the toolbar's demo "Sketch"). */
const DEFAULT_RECT: Profile = {
  kind: "loop",
  start: [0.015, 0.01],
  segments: [
    { kind: "line", to: [0.045, 0.01] },
    { kind: "line", to: [0.045, 0.03] },
    { kind: "line", to: [0.015, 0.03] },
  ],
};

/** Download a string export via the viewport's __plastiqExport seam (FR-42/43). */
async function exportFile(
  format: "gltf" | "step" | "iges",
  ext: string,
  mime: string,
  label: string,
): Promise<void> {
  const exporter = (
    globalThis as {
      __plastiqExport?: (
        f: "gltf" | "step" | "iges",
      ) => Promise<{ content: string; bodyCount: number }>;
    }
  ).__plastiqExport;
  if (!exporter) return;
  try {
    const { content, bodyCount } = await exporter(format);
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `part.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
    // Report the body count (§2.11.2): "exported STEP" used to be printed even
    // when an N-instance assembly had been silently reduced to one body.
    cad().setStatus(
      bodyCount > 1 ? `exported ${label} — ${bodyCount} bodies` : `exported ${label}`,
    );
  } catch (e) {
    cad().setStatus(`export failed: ${(e as Error).message}`);
  }
}

/** Imports at/above this size get a status warning (never a block): the source
 * text is the import feature's source of truth, so it rides along in browser
 * storage — crash recovery keeps it as a single content-addressed payload
 * (persistence/recovery.ts, Review #13), and storage pressure can make that
 * payload (and hence the feature) unrecoverable until re-imported. Warn so the
 * user saves the project promptly. */
export const LARGE_IMPORT_WARN_BYTES = 8 * 1024 * 1024;

/** Status-line message for a completed interchange import — size-aware (FR-43). */
export function importStatusMessage(name: string, bytes: number, format = "STEP"): string {
  if (bytes < LARGE_IMPORT_WARN_BYTES) return `imported ${name}`;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return (
    `imported ${name} (${mb} MB) — large ${format}: kept out of quick crash-recovery ` +
    `snapshots and stored once in browser storage; save your project to keep it safe`
  );
}

/** Open a file picker and import the chosen STEP as a base body (FR-43). A
 * large file is imported all the same, with a size warning on the status line
 * (recovery-snapshot implications — see LARGE_IMPORT_WARN_BYTES). */
export function importStepFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((step) => {
      cad().addFeature({ type: "importStep", name: file.name, data: { step } });
      cad().setStatus(importStatusMessage(file.name, step.length));
    });
  };
  input.click();
}

/** Open a file picker and persist an IGES import as a rebuildable base feature. */
export function importIgesFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".iges,.igs";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((iges) => {
      cad().addFeature({ type: "importIges", name: file.name, data: { iges } });
      cad().setStatus(importStatusMessage(file.name, iges.length, "IGES"));
    });
  };
  input.click();
}

/** Replace the live interactive assembly (the one AssemblyTree/BomSection read) with a
 * realized `.assy` model — the import path's store entry point (M4.5). Undoable: pushes
 * one history snapshot, mirroring store.ts `pushHistory` (same shape + its HISTORY_LIMIT
 * of 100). Transient assembly state (solve verdict, mate picks, joint drives,
 * interference results) is cleared — it described the replaced assembly. */
function loadAssemblyModel(model: AssemblyModel): void {
  useCadStore.setState((s) => ({
    past: [
      ...s.past,
      structuredClone({
        features: s.features,
        params: s.params,
        assembly: s.assembly,
        nextSeq: s.nextSeq,
        assemblyResult: s.assemblyResult,
      }),
    ].slice(-100),
    future: [],
    assembly: model,
    assemblyResult: null,
    matePicks: [],
    jointDrive: {},
    interferences: null,
  }));
}

/** Parse + realize `.assy` JSON text and load it as the live assembly — the read side
 * of the declarative `.assy` bridge (assembly/assy.ts). Any problem (bad JSON, schema
 * violations, sub-assembly cycles) surfaces on the status line and leaves the store
 * untouched. Exported so tests can drive the flow without the file picker. */
export function importAssyText(name: string, text: string): void {
  try {
    const model = realizeAssembly(parseAssy(JSON.parse(text)));
    loadAssemblyModel(model);
    // Honest status (§2.11.3): say what actually loaded, and the multi-part
    // caveat — every instance renders the currently OPEN part; `.assy` part
    // names bind no geometry until the multi-part library milestone.
    const counts = [`${model.instances.length} instance(s)`];
    if (model.mates.length > 0) counts.push(`${model.mates.length} mate(s)`);
    if (model.joints.length > 0) counts.push(`${model.joints.length} joint(s)`);
    cad().setStatus(
      `imported ${name}: ${counts.join(", ")} — all instances render the open part (part names bind no geometry yet)`,
    );
  } catch (e) {
    cad().setStatus(`import failed: ${(e as Error).message}`);
  }
}

/** Open a file picker and import the chosen `.assy` (JSON) document as the live
 * assembly. Mirrors importStepFromDisk's picker mechanism. */
export function importAssyFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".assy,.json";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => importAssyText(file.name, text));
  };
  input.click();
}

/** Download the live interactive assembly as a flat `.assy` JSON document
 * (assemblyToAssy — the write side of the bridge; re-importable via Import .assy). */
export function exportAssyFromStore(): void {
  const doc = assemblyToAssy(cad().assembly);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "assembly.assy";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
  cad().setStatus("exported assembly.assy");
}

const hasExporter = (): boolean =>
  typeof (globalThis as { __plastiqExport?: unknown }).__plastiqExport === "function";

// --- ribbon/toolbar-only actions (absent from the context-menu catalog) ---
// Each `run` is the exact call the current Toolbar/AssemblyTree make, so behaviour
// is preserved when the scrolling toolbar is replaced.
const RIBBON_ONLY: ActionDef[] = [
  // CREATE
  {
    id: "sketch-rect",
    label: () => "Sketch",
    icon: "✎",
    // Opens the sketcher (T13); sample rect remains as a separate discoverability path.
    enabled: always,
    run: () => {
      useSketchStore
        .getState()
        .enterSketch("XY", 0, undefined, startingSketchModel("XY", cad().selectionRefs.faces));
      cad().setStatus("Sketch: draw a closed profile, then Finish");
    },
  },
  {
    // §13.3 project-body-edges: coplanar mesh edges → construction lines on the
    // active sketch. Uses the viewport edge-polyline cache + pure plane projection
    // (no worker round-trip). Exact body∩plane via sectionCurves is available
    // kernel-side as `sectionCurvesToPlaneSegments` for tests / rebuild paths.
    id: "project-edges",
    label: () => "Project edges",
    icon: "⊏",
    enabled: () => {
      const sk = useSketchStore.getState();
      return sk.active && sk.resolvedFrame != null;
    },
    run: () => {
      const sk = useSketchStore.getState();
      const plane = sk.resolvedFrame;
      if (!sk.active || !plane) {
        cad().setStatus("Project edges: open a sketch first");
        return;
      }
      const polys = getProjectableEdgePolylines();
      if (!polys || polys.length === 0) {
        cad().setStatus("Project edges: no body edges available — rebuild the part first");
        return;
      }
      const segs = worldPolylinesToPlaneSegments(plane, polys);
      if (segs.length === 0) {
        cad().setStatus(
          "Project edges: no edges lie on the sketch plane (only coplanar edges project)",
        );
        return;
      }
      const before = sk.model.entities.length;
      sk.appendProjectedSegments(segs);
      const added = useSketchStore.getState().model.entities.length - before;
      cad().setStatus(
        `Project edges: added ${added} construction line${added === 1 ? "" : "s"} from the body`,
      );
    },
  },
  {
    // A one-click starter sketch: injects a real, editable 30×20 mm rectangle
    // profile WITHOUT opening the sketcher (the sketcher, "Sketch", is for
    // drawing your own). The registry long described this as "a separate
    // discoverability path", but it was wired into NO ribbon panel or menu —
    // dead, unreachable code. It is a legitimate CAD affordance (a quick
    // rectangle to extrude), so it is surfaced rather than deleted.
    id: "sample-rect",
    label: () => "Rectangle",
    icon: "▭",
    enabled: always,
    run: () => {
      // Land it on the model's top face, not the bare XY plane (§13.8 P0): with
      // a body already present, XY/0 is buried INSIDE it, so the rectangle you
      // just "inserted" would extrude into solid material and appear to do
      // nothing. `startingSketchModel` resolves the same parametric face spec the
      // sketcher's own default uses; an empty document still gets plain XY.
      const model = startingSketchModel("XY", cad().selectionRefs.faces);
      const plane = model.face
        ? { kind: "face" as const, face: model.face, offset: 0 }
        : { base: "XY" as const, offset: 0 };
      cad().addFeature({ type: "sketch", data: { profile: DEFAULT_RECT, plane } });
      cad().setStatus(
        model.face
          ? "Rectangle sketch inserted on the top face — extrude it, or edit its profile"
          : "Rectangle sketch inserted — extrude it, or edit its profile",
      );
    },
  },
  {
    id: "rib",
    label: () => "Rib / linear form",
    icon: "▰",
    enabled: () =>
      cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      ),
    run: () => {
      const sketches = cad().features.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const selected = sketches.find((f) => f.id === cad().selectedFeatureId);
      const profile = selected ?? sketches[sketches.length - 1];
      if (!profile) {
        cad().setStatus("Rib: finish a sketch profile first");
        return;
      }
      cad().addFeature({
        type: "rib",
        params: { length: 0.01 },
        data: { sketchId: profile.id, op: "join" },
        deps: [profile.id],
      });
      cad().setStatus(
        `Rib: 10 mm native linear form from sketch ${profile.id} — edit length/direction in Properties`,
      );
    },
  },
  {
    id: "loft",
    label: () => "Loft",
    icon: "⬗",
    // Product path: ALL finished sketches as multi-sections (≥2) — no demo frustum (C4).
    enabled: (ctx) => {
      void ctx;
      const n = cad().features.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      ).length;
      return n >= 2;
    },
    run: () => {
      const feats = cad().features;
      // Multi-section: every finished sketch profile, in tree order (not only last two).
      const sketchIds = feats
        .filter((f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null)
        .map((f) => f.id);
      if (sketchIds.length < 2) {
        cad().setStatus("Loft: finish ≥2 sketches first (no demo loft)");
        return;
      }
      const f = loftFromSketchFeatures(feats, sketchIds);
      if (!f) {
        cad().setStatus("Loft: could not build from the finished sketches");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(`Loft: ${sketchIds.length} sections from sketches ${sketchIds.join(" + ")}`);
    },
  },
  {
    id: "sweep",
    label: () => "Sweep",
    icon: "❧",
    // Product path: selected sketch (else last) as profile + picked edges as path (C4).
    // No hardcoded demo pipe.
    enabled: (ctx) => {
      void ctx;
      return cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
    },
    run: (ctx) => {
      const feats = cad().features;
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      // Prefer the feature-tree selection when it is a finished sketch profile.
      const selId = cad().selectedFeatureId;
      const selectedSketch = selId != null ? sketches.find((s) => s.id === selId) : undefined;
      const profile = selectedSketch ?? sketches[sketches.length - 1];
      if (!profile) {
        cad().setStatus("Sweep: finish a sketch profile first (no demo sweep)");
        return;
      }
      // Sweep along the PICKED edge chain when one is selected: the spine is
      // stored as persistent EdgeRefs and re-resolved every rebuild, so the pipe
      // follows those edges parametrically. With no edges picked, fall back to a
      // straight path along the profile plane's normal — a real, editable spine
      // (Properties → Path), not a canned elbow.
      const fromEdges = sweepFromSketchAlongPickedEdges(feats, profile.id, ctx.picks, ctx.refs);
      if (fromEdges) {
        const n = ctx.picks.filter((p) => p.kind === "edge").length;
        cad().addFeature(fromEdges);
        cad().setStatus(
          `Sweep: profile from sketch ${profile.id} along ${n} picked edge${n === 1 ? "" : "s"}`,
        );
        return;
      }
      const path = {
        kind: "polyline" as const,
        points: [
          [0, 0, 0],
          [0, 0, 0.04],
        ] as [number, number, number][],
      };
      const f = sweepFromSketchFeature(feats, profile.id, path);
      if (!f) {
        cad().setStatus("Sweep: could not build from the sketch profile");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(
        `Sweep: profile from sketch ${profile.id} along a default 40 mm path — pick edges first, or edit Properties → Path`,
      );
    },
  },
  {
    // §13.2 helical pipe: same sweep feature type with data.helix (kernel helix()
    // wire consumed by sweepAlongWire). Not a separate FEATURE_TYPES entry.
    id: "helixSweep",
    label: () => "Helix sweep",
    icon: "🌀",
    enabled: (ctx) => {
      void ctx;
      return cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
    },
    run: () => {
      const feats = cad().features;
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const selId = cad().selectedFeatureId;
      const selectedSketch = selId != null ? sketches.find((s) => s.id === selId) : undefined;
      const profile = selectedSketch ?? sketches[sketches.length - 1];
      if (!profile) {
        cad().setStatus("Helix sweep: finish a sketch profile first");
        return;
      }
      // Defaults SI: Ø20 mm helix, 5 mm pitch, 4 turns, right-handed (Properties editable).
      const helix = {
        radius: 0.01,
        pitch: 0.005,
        turns: 4,
        handedness: "right" as const,
      };
      const f = helixSweepFromSketchFeature(feats, profile.id, helix);
      if (!f) {
        cad().setStatus("Helix sweep: could not build from the sketch profile");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(
        `Helix sweep: profile from sketch ${profile.id} along Ø20 × pitch 5 mm × 4 turns — edit helix in Properties`,
      );
    },
  },
  // §14 SURFACE pillar — open sheets + closure. Mirrors solid loft/sweep authoring
  // but installs shell/face bodies (thicken to plate; sew/solidify to close).
  {
    id: "surfaceLoft",
    label: () => "Surface Loft",
    icon: "◇",
    enabled: (ctx) => {
      void ctx;
      const n = cad().features.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      ).length;
      return n >= 2;
    },
    run: () => {
      const feats = cad().features;
      const sketchIds = feats
        .filter((f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null)
        .map((f) => f.id);
      if (sketchIds.length < 2) {
        cad().setStatus("Surface loft: finish ≥2 sketches first");
        return;
      }
      // Multi-section like solid loft: every finished sketch in tree order.
      const f = surfaceLoftFromSketchFeatures(feats, sketchIds);
      if (!f) {
        cad().setStatus("Surface loft: could not build from the finished sketches");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(
        `Surface loft: shell from ${sketchIds.length} sketches ${sketchIds.join(" + ")} — Thicken to solidify`,
      );
    },
  },
  {
    id: "surfaceSweep",
    label: () => "Surface Sweep",
    icon: "⌒",
    enabled: (ctx) => {
      void ctx;
      return cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
    },
    run: (ctx) => {
      const feats = cad().features;
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const selId = cad().selectedFeatureId;
      const selectedSketch = selId != null ? sketches.find((s) => s.id === selId) : undefined;
      const profile = selectedSketch ?? sketches[sketches.length - 1];
      if (!profile) {
        cad().setStatus("Surface sweep: finish a sketch profile first");
        return;
      }
      const fromEdges = surfaceSweepFromSketchAlongPickedEdges(
        feats,
        profile.id,
        ctx.picks,
        ctx.refs,
      );
      if (fromEdges) {
        const n = ctx.picks.filter((p) => p.kind === "edge").length;
        cad().addFeature(fromEdges);
        cad().setStatus(
          `Surface sweep: shell from sketch ${profile.id} along ${n} picked edge${n === 1 ? "" : "s"}`,
        );
        return;
      }
      const path = {
        kind: "polyline" as const,
        points: [
          [0, 0, 0],
          [0, 0, 0.04],
        ] as [number, number, number][],
      };
      const f = surfaceSweepFromSketchFeature(feats, profile.id, path);
      if (!f) {
        cad().setStatus("Surface sweep: could not build from the sketch profile");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(
        `Surface sweep: shell from sketch ${profile.id} along a default 40 mm path — Thicken to solidify`,
      );
    },
  },
  {
    id: "surfaceRevolve",
    label: () => "Surface Revolve",
    icon: "◌",
    enabled: (ctx) => {
      void ctx;
      return cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
    },
    run: (ctx) => {
      const feats = cad().features;
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const selId = cad().selectedFeatureId;
      const selectedSketch = selId != null ? sketches.find((s) => s.id === selId) : undefined;
      const last = selectedSketch ?? sketches[sketches.length - 1];
      if (!last) {
        cad().setStatus("Surface revolve: finish a sketch profile first");
        return;
      }
      const prof = last.data?.["profile"] as Profile | undefined;
      if (!prof) {
        cad().setStatus("Surface revolve: sketch has no profile");
        return;
      }
      const plane = last.data?.["plane"];
      const edges = edgeRefsFromPicks(ctx.picks, ctx.refs);
      const axisEdge = edges[0];
      cad().addFeature({
        type: "surfaceRevolve",
        params: {
          angle: Math.PI * 2,
          ox: 0,
          oy: 0,
          oz: 0,
          ax: 0,
          ay: 1,
          az: 0,
        },
        data: {
          profile: prof,
          ...(plane ? { plane } : {}),
          ...(axisEdge ? { axisEdge } : {}),
        },
      });
      cad().setStatus(
        axisEdge
          ? `Surface revolve: shell from sketch ${last.id} about picked edge — Thicken to solidify`
          : `Surface revolve: shell from sketch ${last.id} about +Y — pick an edge first for a custom axis`,
      );
    },
  },
  {
    id: "offsetSurface",
    label: () => "Offset Surface",
    icon: "⧉",
    enabled: always,
    run: () => {
      cad().addFeature({
        type: "offsetSurface",
        params: { distance: 0.002 },
      });
      cad().setStatus(
        "Offset surface: 2 mm offset of the current body — edit distance in Properties",
      );
    },
  },
  {
    id: "sew",
    label: () => "Sew",
    icon: " intern",
    enabled: always,
    run: () => {
      cad().addFeature({
        type: "sew",
        params: { tolerance: 1e-6 },
      });
      cad().setStatus("Sew: stitch the current body's faces into a shell");
    },
  },
  {
    id: "solidify",
    label: () => "Solidify",
    icon: "⬢",
    enabled: always,
    run: () => {
      cad().addFeature({ type: "solidify" });
      cad().setStatus("Solidify: promote a closed shell to a solid (sew free edges first)");
    },
  },
  {
    id: "patch",
    label: () => "Patch",
    icon: "▣",
    // §14 free-edge fill: needs ≥3 picked free edges forming a closed loop.
    enabled: (ctx) => edgeRefsFromPicks(ctx.picks, ctx.refs).length >= 3,
    run: (ctx) => {
      const edges = edgeRefsFromPicks(ctx.picks, ctx.refs);
      if (edges.length < 3) {
        cad().setStatus("Patch: pick ≥3 free edges of an open shell (isFree boundary)");
        return;
      }
      cad().addFeature({
        type: "patch",
        data: { edges, continuity: "c0" },
      });
      cad().setStatus(
        `Patch: fill ${edges.length} free edges into a face — prefer naked boundary edges on a shell`,
      );
    },
  },
  {
    id: "trim",
    label: () => "Trim",
    icon: "✂",
    enabled: always,
    run: (ctx) => {
      // Default mid-YZ trim (keep +X half). Face pick supplies the plane when available.
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      const plane = face
        ? {
            origin: face.centroid ?? ([0, 0, 0] as [number, number, number]),
            normal: face.normal ?? ([1, 0, 0] as [number, number, number]),
            xAxis: [0, 1, 0] as [number, number, number],
          }
        : {
            origin: [0.02, 0, 0] as [number, number, number],
            normal: [1, 0, 0] as [number, number, number],
            xAxis: [0, 1, 0] as [number, number, number],
          };
      cad().addFeature({
        type: "trim",
        data: { plane, keep: "positive" },
      });
      cad().setStatus(
        face
          ? "Trim: keep +side of the selected face plane — flip keep in Properties"
          : "Trim: keep +X half at x=20 mm — select a face for the cut plane, or edit in Properties",
      );
    },
  },
  // PRIMITIVES — round solids without the sketcher (§4.11).
  //
  // Box was the kernel's only primitive, so every round shape had to come from
  // extruding a circle sketch — which made the severed sketcher (§2.6/§2.7) a
  // single point of failure for all round geometry. These place a real analytic
  // cylinder/sphere/cone/torus, and `data.op` lets one CUT: subtracting a
  // cylinder is a bore, with no sketch involved at all.
  //
  // Every param is baked at creation — including the placement and sweep angle
  // even when they are at their defaults. That is deliberate: `FeatureEditor`
  // iterates ONLY `Object.entries(feature.params)`, so a param the creation
  // action omits can never be added by the panel afterwards (§9). Omitting
  // ox/oy/oz/ax/ay/az here would repeat exactly the defect that leaves mirror's
  // ny/nz/oy/oz and revolve's axis permanently unreachable.
  ...primitiveActions(),

  // COMBINE — selection-driven plane / direction / axis when a face or edge is
  // picked (C6). Defaults stay sensible; status explains how to drive them.
  {
    id: "mirror",
    label: () => "Mirror",
    icon: "◫",
    enabled: always,
    run: (ctx) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (face) {
        const n = unit3(face.normal) ?? ([1, 0, 0] as V3);
        const o = faceOrigin(face, ctx.worldPoint);
        cad().addFeature({
          type: "mirror",
          params: {
            nx: n[0],
            ny: n[1],
            nz: n[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            merge: 1,
          },
        });
        cad().setStatus("Mirror: plane from selected face normal + origin");
        return;
      }
      cad().addFeature({
        type: "mirror",
        params: { nx: 1, ny: 0, nz: 0, ox: 0, oy: 0, oz: 0, merge: 1 },
      });
      cad().setStatus(
        "Mirror: default YZ plane at origin — select a face for its plane, then run Mirror again",
      );
    },
  },
  {
    id: "scale",
    label: () => "Scale",
    icon: "⤢",
    enabled: always,
    run: () => {
      // Uniform resize (§2.5) — the kernel op existed but was reachable from
      // nowhere. Bake the FULL param set at creation so every field is editable
      // in Properties (avoids the C2 "uneditable defaults" trap): factor + pivot.
      cad().addFeature({ type: "scale", params: { factor: 2, px: 0, py: 0, pz: 0 } });
      cad().setStatus("Scale ×2 about origin — edit factor / pivot in Properties");
    },
  },
  {
    id: "linearPattern",
    label: () => "Linear pattern",
    icon: "▤",
    enabled: always,
    run: (ctx) => {
      const edge = edgeRefsFromPicks(ctx.picks, ctx.refs)[0];
      const dir = edge ? edgeDirectionFromRef(edge) : null;
      if (dir) {
        cad().addFeature({
          type: "linearPattern",
          params: { dx: dir[0], dy: dir[1], dz: dir[2], spacing: 0.08, count: 3 },
        });
        cad().setStatus(
          "Linear pattern: direction from selected edge — edit spacing/count in Properties",
        );
        return;
      }
      cad().addFeature({ type: "linearPattern", params: { dx: 1, spacing: 0.08, count: 3 } });
      cad().setStatus(
        "Linear pattern: default +X — select an edge for direction, then run Linear pattern again",
      );
    },
  },
  {
    id: "circularPattern",
    label: () => "Circular pattern",
    icon: "❋",
    enabled: always,
    run: (ctx) => {
      const edge = edgeRefsFromPicks(ctx.picks, ctx.refs)[0];
      const edgeDir = edge ? edgeDirectionFromRef(edge) : null;
      if (edge && edgeDir) {
        const o = edgeOrigin(edge, ctx.worldPoint);
        cad().addFeature({
          type: "circularPattern",
          params: {
            ax: edgeDir[0],
            ay: edgeDir[1],
            az: edgeDir[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            count: 4,
            angle: Math.PI * 2,
          },
        });
        cad().setStatus(
          "Circular pattern: axis from selected edge — edit count/angle in Properties",
        );
        return;
      }
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (face) {
        const n = unit3(face.normal) ?? ([0, 0, 1] as V3);
        const o = faceOrigin(face, ctx.worldPoint);
        cad().addFeature({
          type: "circularPattern",
          params: {
            ax: n[0],
            ay: n[1],
            az: n[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            count: 4,
            angle: Math.PI * 2,
          },
        });
        cad().setStatus(
          "Circular pattern: axis = selected face normal through face point — edit count/angle in Properties",
        );
        return;
      }
      cad().addFeature({
        type: "circularPattern",
        params: { az: 1, count: 4, angle: Math.PI * 2 },
      });
      cad().setStatus(
        "Circular pattern: default Z axis — select an edge (axis) or face (normal), then re-run",
      );
    },
  },
  {
    // §13.2 patternAlongPath — N instances along a spine polyline (or selected edges).
    id: "pathPattern",
    label: () => "Path pattern",
    icon: "〰",
    enabled: always,
    run: (ctx) => {
      const edges = edgeRefsFromPicks(ctx.picks, ctx.refs);
      if (edges.length > 0) {
        cad().addFeature({
          type: "pathPattern",
          params: { count: 3 },
          data: { pathEdges: edges, align: false },
        });
        cad().setStatus("Path pattern: along selected edge(s) — edit count / align in Properties");
        return;
      }
      // Default straight +X spine (160 mm) so count=3 places start/mid/end without a pick.
      cad().addFeature({
        type: "pathPattern",
        params: { count: 3 },
        data: {
          path: {
            kind: "polyline",
            points: [
              [0, 0, 0],
              [0.16, 0, 0],
            ],
          },
          align: false,
        },
      });
      cad().setStatus(
        "Path pattern: default +X polyline — select edge(s) for a model spine, then re-run",
      );
    },
  },
  {
    // §13.2 split — keep both sides of a plane cut (face pick → plane, else YZ at origin).
    id: "split",
    label: () => "Split",
    icon: "✂",
    enabled: always,
    run: (ctx) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (face) {
        const n = unit3(face.normal) ?? ([1, 0, 0] as V3);
        const o = faceOrigin(face, ctx.worldPoint);
        cad().addFeature({
          type: "split",
          data: {
            plane: {
              origin: [o[0], o[1], o[2]],
              normal: [n[0], n[1], n[2]],
            },
          },
        });
        cad().setStatus("Split: plane from selected face — both sides kept as multi-body");
        return;
      }
      cad().addFeature({
        type: "split",
        data: {
          plane: {
            origin: [0, 0, 0],
            normal: [1, 0, 0],
          },
        },
      });
      cad().setStatus(
        "Split: default YZ plane at origin — select a face for its plane, then re-run Split",
      );
    },
  },
  {
    // Primary boolean authoring (C5): tool = selected feature when possible
    // (sketch→extrude, or a solid primitive), else last finished sketch. Never a
    // fixed DEFAULT_RECT / demo box.
    id: "booleanBody",
    label: () => "Subtract tool",
    icon: "⊖",
    enabled: () => {
      const s = cad();
      const hasBody = s.features.some(
        (f) =>
          !f.suppressed &&
          (f.type === "box" ||
            f.type === "extrude" ||
            f.type === "revolve" ||
            f.type === "loft" ||
            f.type === "sweep" ||
            f.type === "cylinder" ||
            f.type === "sphere" ||
            f.type === "cone" ||
            f.type === "torus" ||
            f.type === "importStep"),
      );
      if (!hasBody) return false;
      const hasSketch = s.features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      // Also enable when the user has selected a solid primitive as the tool (C5).
      const sel =
        s.selectedFeatureId != null
          ? s.features.find((f) => f.id === s.selectedFeatureId && !f.suppressed)
          : undefined;
      const solidToolTypes = new Set(["box", "cylinder", "sphere", "cone", "torus"]);
      const hasSelectedSolidTool = sel != null && solidToolTypes.has(sel.type);
      return hasSketch || hasSelectedSolidTool;
    },
    run: () => {
      const feats = cad().features;
      const selId = cad().selectedFeatureId;
      const selected =
        selId != null ? feats.find((f) => f.id === selId && !f.suppressed) : undefined;
      const solidToolTypes = new Set(["box", "cylinder", "sphere", "cone", "torus"]);

      // Selected solid primitive → tool body is that primitive alone (C5 select tool).
      if (selected && solidToolTypes.has(selected.type)) {
        cad().addFeature(
          booleanBodyFeature("subtract", [
            {
              type: selected.type,
              params: { ...(selected.params ?? {}) },
              data: { ...(selected.data ?? {}), op: "new" },
            },
          ]),
        );
        cad().setStatus(`Subtract: tool from selected ${selected.type} ${selected.id}`);
        return;
      }

      // Selected sketch, else last finished sketch → extrude as tool.
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const toolSketch =
        selected?.type === "sketch" && selected.data?.["profile"] != null
          ? selected
          : sketches[sketches.length - 1];
      if (!toolSketch) {
        cad().setStatus("Subtract: select a tool sketch/primitive, or finish a sketch first");
        return;
      }
      const depth =
        typeof toolSketch.params?.["depth"] === "number"
          ? (toolSketch.params["depth"] as number)
          : 0.05;
      cad().addFeature(
        booleanBodyFeature("subtract", [
          {
            type: "sketch",
            data: { ...toolSketch.data, profile: toolSketch.data!["profile"] },
          },
          {
            type: "extrude",
            params: { height: depth > 0 ? depth : 0.05 },
            data: { op: "new" },
          },
        ]),
      );
      cad().setStatus(`Subtract: tool from sketch ${toolSketch.id}`);
    },
  },
  {
    id: "transform",
    label: () => "Move body",
    icon: "✥",
    enabled: always,
    // Opens the placement gizmo — not a transform feature (C7).
    run: () => {
      cad().setGizmoMode("translate");
      cad().setStatus("Move: drag the gizmo — placement writes on release");
    },
  },
  // I/O
  {
    id: "import-step",
    label: () => "Import STEP",
    icon: "⤒",
    enabled: always,
    run: () => importStepFromDisk(),
  },
  {
    id: "import-iges",
    label: () => "Import IGES",
    icon: "⤒",
    enabled: always,
    run: () => importIgesFromDisk(),
  },
  {
    id: "export-gltf",
    label: () => "Export glTF",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("gltf", "gltf", "model/gltf+json", "glTF"),
  },
  {
    id: "export-step",
    label: () => "Export STEP",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("step", "step", "application/step", "STEP"),
  },
  {
    id: "export-iges",
    label: () => "Export IGES",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("iges", "iges", "application/iges", "IGES"),
  },
  // EDIT — routed: while a voxel sculpt is open its edit history is the live one
  // (the parametric history still exists underneath but is not what Undo means then).
  {
    id: "undo",
    label: () => "Undo",
    icon: "↶",
    enabled: () => (voxelMode() ? vox().past.length > 0 : cad().past.length > 0),
    run: () => (voxelMode() ? vox().undo() : cad().undo()),
  },
  {
    id: "redo",
    label: () => "Redo",
    icon: "↷",
    enabled: () => (voxelMode() ? vox().future.length > 0 : cad().future.length > 0),
    run: () => (voxelMode() ? vox().redo() : cad().redo()),
  },
  // SELECTION MODE
  ...(["face", "edge", "vertex", "body"] as const).map(
    (mode): ActionDef => ({
      id: `selmode-${mode}`,
      label: () => mode.charAt(0).toUpperCase() + mode.slice(1),
      enabled: always,
      active: (ctx) => ctx.selMode === (mode as SelectionMode),
      run: () => cad().setSelMode(mode),
    }),
  ),
  // ASSEMBLY (global)
  {
    id: "insert-instance",
    label: () => "Insert instance",
    icon: "⧉",
    enabled: always,
    run: () => cad().addInstance(),
  },
  {
    id: "mate-mode",
    label: (ctx) => (ctx.mateMode ? "Exit mate" : "Mate"),
    icon: "⚯",
    enabled: (ctx) => ctx.explodeFactor === 0,
    active: (ctx) => ctx.mateMode,
    // Enter/leave mate authoring; the two-pick + apply flow lives in AssemblyTree.
    run: (ctx) => cad().setMateMode(!ctx.mateMode),
  },
  // Declarative `.assy` interchange (M4.5): import parses + realizes a JSON document
  // into the live assembly; export downloads the live assembly back out (assy.ts).
  {
    id: "import-assy",
    label: () => "Import .assy",
    icon: "⤒",
    enabled: always,
    run: () => importAssyFromDisk(),
  },
  {
    id: "export-assy",
    label: () => "Export .assy",
    icon: "⤓",
    // Nothing to export until the assembly has at least one instance (matches
    // BomSection's gating on the same store slice).
    enabled: () => cad().assembly.instances.length > 0,
    run: () => exportAssyFromStore(),
  },
];

/** Re-expose each context-menu action as an ActionDef (drop menu-only `group`/
 * danger; keep `visible` for palette context-gating + optional toggle-active). */
const CONTEXT_DEFS: Record<string, ActionDef> = Object.fromEntries(
  CONTEXT_ACTIONS.map((a) => [
    a.id,
    {
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      run: a.run,
      active: a.active,
      visible: a.visible,
    },
  ]),
);

// --- Voxel-sculpt actions (ADR-0010 wiring) ------------------------------------
// The Sculpt workspace's tool set. All voxel-scoped `enabled` predicates read the
// voxel store directly (like meshMode below); the sidebar/topbar subscribe to it so
// greying/highlighting stay live.

/** Ribbon glyph for each §16 SDF brush. */
function brushIcon(brush: string): string {
  switch (brush) {
    case "draw":
      return "●";
    case "clay":
      return "◉";
    case "smooth":
      return "〰";
    case "flatten":
      return "▬";
    case "inflate":
      return "◎";
    case "pinch":
      return "⟩⟨";
    case "grab":
      return "✥";
    default:
      return "·";
  }
}

/** Stage the open sculpt's SURFACE mesh as a mesh document — the exact `MeshDoc`
 * shape the AI panel's MeshConvertSection consumes — so "Convert to CAD (STEP)"
 * runs the SAME mesh→B-rep reconstruct path a generated mesh uses (ADR-0010).
 * Mirrors that section's own post-convert behaviour: the staged doc is a fresh
 * UNTITLED document; the original voxel project is left untouched on disk. */
function stageVoxelForConvert(): void {
  const doc = vox().doc;
  if (!doc || doc.cells.length === 0) return;
  const glb = voxelMeshToGlbBase64(voxelDocToMesh(doc));
  const name = doc.name ?? useProjectsStore.getState().currentName;
  const meshDoc: MeshDoc = {
    kind: "mesh",
    name,
    glb,
    source: { mode: "voxel", providerId: "voxel-sculpt" },
  };
  vox().close();
  useProjectsStore.setState({
    activeMeshDoc: meshDoc,
    currentId: null,
    currentName: name,
    status: "sculpt surface staged as a mesh — run “Convert to CAD (STEP)” in the AI panel",
  });
  cad().setWorkspace("design"); // the mesh view + convert panel live outside Sculpt
}

const VOXEL_ACTIONS: ActionDef[] = [
  {
    id: "voxel-new",
    label: () => "New Sculpt",
    icon: "⬚",
    // The Sculpt entry point: always available outside mesh mode (the doc-mode gate
    // below disables it there); in voxel mode it starts a fresh untitled sculpt.
    enabled: always,
    run: () => useProjectsStore.getState().newVoxelProject(),
  },
  {
    id: "voxel-add",
    label: () => "Add voxels",
    icon: "⊞",
    enabled: () => voxelMode(),
    active: () => voxelMode() && vox().tool === "add",
    run: () => vox().setTool("add"),
  },
  {
    id: "voxel-erase",
    label: () => "Erase voxels",
    icon: "⊟",
    enabled: () => voxelMode(),
    active: () => voxelMode() && vox().tool === "erase",
    run: () => vox().setTool("erase"),
  },
  // §16 SDF brush set — each selects the brush tool; pointer path is VoxelSculpt.
  ...(["draw", "clay", "smooth", "flatten", "inflate", "pinch", "grab"] as const).map(
    (brush) =>
      ({
        id: `voxel-brush-${brush}`,
        label: () => brush.charAt(0).toUpperCase() + brush.slice(1),
        icon: brushIcon(brush),
        enabled: () => voxelMode(),
        active: () => voxelMode() && vox().tool === brush,
        run: () => {
          vox().setTool(brush);
          cad().setStatus(`sculpt brush: ${brush} — drag on the surface`);
        },
      }) satisfies ActionDef,
  ),
  {
    id: "voxel-convert-cad",
    label: () => "Convert to CAD",
    icon: "⇄",
    enabled: () => voxelMode() && (vox().doc?.cells.length ?? 0) > 0,
    run: () => stageVoxelForConvert(),
  },
  {
    id: "voxel-export-glb",
    label: () => "Export GLB",
    icon: "⤓",
    enabled: () => voxelMode() && (vox().doc?.cells.length ?? 0) > 0,
    run: () => {
      const doc = vox().doc;
      if (!doc || doc.cells.length === 0) return;
      const file = exportMeshGlb(voxelMeshToGlbBase64(voxelDocToMesh(doc)), doc.name ?? "sculpt");
      cad().setStatus(`exported ${file}`);
    },
  },
];

/** True when a generated MESH document is open. In that mode the live document is a
 * triangle mesh, not a B-rep CadDocument, so B-rep feature operations and the parametric
 * STEP/IGES/glTF export are no-ops — SPEC-6 FR-18 requires the UI to reflect that rather
 * than offer them. (Mesh documents get their own GLB export in the GenerationPanel.) */
export const meshMode = (): boolean => useProjectsStore.getState().activeMeshDoc != null;

/** True when a voxel sculpt is open (ADR-0010). Like mesh mode, the live document is
 * not a B-rep CadDocument, so B-rep ops are disabled-not-hidden (FR-18); the
 * voxel-legal set (sculpt tools, surface-mesh export, Convert-to-CAD) stays live. */
export const voxelMode = (): boolean => useVoxelStore.getState().doc != null;

/** True when a dense point-cloud document is open (SPEC-13). The live document is neither a B-rep nor
 * a mesh, so B-rep/mesh ops are disabled-not-hidden (FR-18); only the editor-state set (and, once
 * added, the cloud→mesh / completion hand-offs) stays live. */
export const pointCloudMode = (): boolean =>
  useProjectsStore.getState().activePointCloudDoc != null;

/** Actions that remain meaningful while a mesh document is open: editor-state (undo/redo,
 * selection mode) AND the mesh→CAD conversions that CONSUME the open mesh (reconstruct to
 * B-rep, fit NURBS surfaces) — those are enabled precisely in mesh mode, so gateForDocMode
 * must not force-disable them there (their own `enabled` already gates on an open MeshDoc).
 * Everything else is a B-rep feature op. An ALLOWLIST (not a blocklist) so any action added
 * later is disabled in mesh mode by default — exactly the FR-18 "no silent no-op" guarantee. */
const MESH_SAFE_IDS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "selmode-face",
  "selmode-edge",
  "selmode-vertex",
  "selmode-body",
  "ml-reconstruct-brep",
  "ml-fit-nurbs",
]);

/** Actions that remain meaningful while a voxel sculpt is open: the mesh-safe
 * editor-state set plus the voxel tool set itself. Same allowlist discipline. */
const VOXEL_SAFE_IDS: ReadonlySet<string> = new Set([
  ...MESH_SAFE_IDS,
  "voxel-new",
  "voxel-add",
  "voxel-erase",
  "voxel-brush-draw",
  "voxel-brush-clay",
  "voxel-brush-smooth",
  "voxel-brush-flatten",
  "voxel-brush-inflate",
  "voxel-brush-pinch",
  "voxel-brush-grab",
  "voxel-convert-cad",
  "voxel-export-glb",
]);

/** Actions that remain meaningful while a dense point cloud is open (SPEC-13): editor-state (undo/redo,
 * selection mode) AND the cloud→mesh / completion hand-offs that CONSUME the open cloud (their own
 * `enabled` gates on an open PointCloudDoc, so gateForDocMode must not force-disable them here).
 * Deliberately NOT the mesh→CAD conversions — those need an open MESH, not a cloud. Same allowlist
 * discipline: anything not listed is disabled in cloud mode (FR-18, no silent no-op). */
const POINTCLOUD_SAFE_IDS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "selmode-face",
  "selmode-edge",
  "selmode-vertex",
  "selmode-body",
  "cloud-to-mesh",
  "cloud-complete",
]);

/** Augment an action so it is disabled while a document mode it doesn't apply to is
 * open: B-rep/parametric ops grey out on a mesh document, a voxel sculpt, AND a point
 * cloud; the voxel tools grey out on a mesh/cloud document (their own `enabled` already
 * scopes them). Each mode is an independent allowlist conjunct. */
function gateForDocMode(a: ActionDef): ActionDef {
  const meshSafe = MESH_SAFE_IDS.has(a.id);
  const voxelSafe = VOXEL_SAFE_IDS.has(a.id);
  const cloudSafe = POINTCLOUD_SAFE_IDS.has(a.id);
  if (meshSafe && voxelSafe && cloudSafe) return a;
  const base = a.enabled;
  return {
    ...a,
    enabled: (ctx) =>
      (meshSafe || !meshMode()) &&
      (voxelSafe || !voxelMode()) &&
      (cloudSafe || !pointCloudMode()) &&
      base(ctx),
  };
}

/** Every action by id — context-menu actions + ribbon-only ops + the voxel tool set,
 * each gated so operations that don't apply to the open document KIND are unavailable
 * (disabled, never hidden or silently no-oping — FR-18). */
export const ACTIONS: Record<string, ActionDef> = Object.fromEntries(
  [...Object.values(CONTEXT_DEFS), ...RIBBON_ONLY, ...VOXEL_ACTIONS].map((a) => {
    const gated = gateForDocMode(a);
    return [gated.id, gated];
  }),
);

/** Run an action by id against a resolved target, honouring `enabled`. */
export function runAction(id: string, ctx: ContextTarget): void {
  const a = ACTIONS[id];
  if (a && a.enabled(ctx)) a.run(ctx);
}
