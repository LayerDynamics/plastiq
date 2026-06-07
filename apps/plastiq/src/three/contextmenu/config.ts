// The action catalog: every option the canvas context menu can ever show, each
// wired to the REAL existing store action / dress-up builder (never reimplemented).
// `visible`/`enabled`/`label` are pure over the ContextTarget so contextOptions.ts
// can filter deterministically; `run` performs the side effect via getState().

import { useCadStore, type NewFeature } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { editSketchFeature, finishSketchFeature } from "../../sketch/editFeature.js";
import { emptySketch, type SketchModel, type SketchPoint } from "../../sketch/model.js";
import { canApply, type ConstraintKind } from "../../sketch/hit.js";
import { canDimension, type DimensionKind } from "../../sketch/dim.js";
import { extractProfile } from "../../sketch/profile.js";
import {
  chamferFeature,
  draftFeature,
  extrudeAlongEdgeFeature,
  extrudeToFaceFeature,
  extrudeTwoSidedFeature,
  filletFeature,
  shellFeature,
} from "../../viewport/dressup.js";
import type { EditorFeature } from "../../store/types.js";
import type { FaceRef } from "@plastiq/cad";
import type { ContextTarget } from "./contextSelection.js";

/** Visual grouping (drives divider order in contextOptions.ts). */
export type ActionGroup =
  | "create"
  | "modify"
  | "sketch"
  | "assembly"
  | "mate"
  | "sim"
  | "view"
  | "selection"
  | "feature"
  | "danger";

export interface ContextAction {
  id: string;
  group: ActionGroup;
  /** Human label; dynamic so toggles read their current state ("Suppress"/"Unsuppress"). */
  label: (ctx: ContextTarget) => string;
  /** Red styling + bottom-of-menu placement for destructive actions. */
  danger?: boolean;
  /** Whether this action belongs in the menu for this target at all. */
  visible: (ctx: ContextTarget) => boolean;
  /** Whether it can be invoked now (else shown greyed/disabled). */
  enabled: (ctx: ContextTarget) => boolean;
  /** Optional toggle-active predicate (e.g. gizmo mode) — surfaced by the ribbon. */
  active?: (ctx: ContextTarget) => boolean;
  /** Perform the action (calls the real store/dressup fn). */
  run: (ctx: ContextTarget) => void;
}

// --- live store accessors (config is allowed to touch stores; predicates stay
// pure by reading only ctx) ---
const cad = (): ReturnType<typeof useCadStore.getState> => useCadStore.getState();
const sketch = (): ReturnType<typeof useSketchStore.getState> => useSketchStore.getState();

// Default dress-up sizes (SI metres / radians) — identical to Toolbar.tsx.
const FILLET_R = 0.003;
const CHAMFER_D = 0.003;
const SHELL_T = 0.002;
const DRAFT_A = (5 * Math.PI) / 180;
const EXTRUDE_H = 0.02;
const CUT_D = 0.05;
const ALONG_EDGE_H = 0.02;
const PAD_H = 0.02;

/** Add the built feature, or surface why the selection couldn't (mirrors Toolbar's `apply`). */
function addOrStatus(f: NewFeature | null, what: string): void {
  if (f) cad().addFeature(f);
  else cad().setStatus(`${what}: select the edges/faces it needs first`);
}

const faceCount = (ctx: ContextTarget): number => ctx.picks.filter((p) => p.kind === "face").length;
const edgeCount = (ctx: ContextTarget): number => ctx.picks.filter((p) => p.kind === "edge").length;

/** The first picked face's persistent ref, if exactly one face is selected. */
function singleFaceRef(ctx: ContextTarget): FaceRef | undefined {
  const fp = ctx.picks.find((p) => p.kind === "face");
  return faceCount(ctx) === 1 && fp ? ctx.refs.faces[fp.id] : undefined;
}

const selectedFeature = (ctx: ContextTarget): EditorFeature | undefined =>
  ctx.features.find((f) => f.id === ctx.selectedFeatureId);
const selectedIndex = (ctx: ContextTarget): number =>
  ctx.features.findIndex((f) => f.id === ctx.selectedFeatureId);

/** The single selected sketch point (for the fix/unfix action), if exactly one. */
function selectedSketchPoint(ctx: ContextTarget): SketchPoint | undefined {
  if (!ctx.sketchModel || ctx.sketchSelection.length !== 1) return undefined;
  return ctx.sketchModel.points.find((p) => p.id === ctx.sketchSelection[0]);
}

/** Standard, non-modal editing context (not sketching, not simulating). */
const editing = (ctx: ContextTarget): boolean => !ctx.inSketch && !ctx.simulating;

/** Fire the viewport's published fit-to-view seam (set by Scene.tsx). */
function fitToView(): void {
  (globalThis as { __plastiqViewport?: { fitToView?: () => void } }).__plastiqViewport?.fitToView?.();
}

const always = (): boolean => true;

// --- CREATE: sketches + profile-consuming solids ---
const CREATE: ContextAction[] = [
  ...(["XY", "XZ", "YZ"] as const).map(
    (plane): ContextAction => ({
      id: `new-sketch-${plane.toLowerCase()}`,
      group: "create",
      label: () => `New sketch (${plane})`,
      visible: (ctx) => editing(ctx) && ctx.kind === "empty",
      enabled: (ctx) => ctx.solverReady,
      run: () => sketch().enterSketch(plane, 0),
    }),
  ),
  {
    id: "sketch-on-face",
    group: "create",
    label: () => "Sketch on face",
    visible: (ctx) => editing(ctx) && ctx.kind === "face",
    enabled: (ctx) => ctx.solverReady && singleFaceRef(ctx) != null,
    run: (ctx) => {
      const face = singleFaceRef(ctx);
      if (!face) return;
      const model: SketchModel = { ...emptySketch("XY", 0), face };
      sketch().enterSketch("XY", 0, undefined, model);
    },
  },
  {
    id: "extrude",
    group: "create",
    label: () => "Extrude profile",
    visible: (ctx) => editing(ctx) && ctx.hasProfile && (ctx.kind === "empty" || ctx.kind === "body"),
    enabled: (ctx) => ctx.hasProfile,
    run: () => {
      const id = cad().addFeature({ type: "extrude", params: { height: EXTRUDE_H } });
      cad().setActiveFeatureEdit({ id, param: "height", start: EXTRUDE_H });
    },
  },
  {
    id: "cut",
    group: "create",
    label: () => "Cut with profile",
    visible: (ctx) => editing(ctx) && ctx.hasProfile && (ctx.kind === "empty" || ctx.kind === "body"),
    enabled: (ctx) => ctx.hasProfile,
    run: () => cad().addFeature({ type: "cut", params: { depth: CUT_D } }),
  },
  {
    id: "revolve",
    group: "create",
    label: () => "Revolve profile",
    visible: (ctx) => editing(ctx) && ctx.hasProfile && (ctx.kind === "empty" || ctx.kind === "body"),
    enabled: (ctx) => ctx.hasProfile,
    run: () => cad().addFeature({ type: "revolve", params: { angle: Math.PI * 2, ay: 1 } }),
  },
];

// --- MODIFY: dress-up on the current edge/face selection + body transforms ---
const MODIFY: ContextAction[] = [
  {
    id: "fillet",
    group: "modify",
    label: () => "Fillet edges",
    visible: (ctx) => editing(ctx) && ctx.kind === "edge",
    enabled: (ctx) => edgeCount(ctx) > 0,
    run: (ctx) => addOrStatus(filletFeature(ctx.picks, ctx.refs, FILLET_R), "Fillet"),
  },
  {
    id: "chamfer",
    group: "modify",
    label: () => "Chamfer edges",
    visible: (ctx) => editing(ctx) && ctx.kind === "edge",
    enabled: (ctx) => edgeCount(ctx) > 0,
    run: (ctx) => addOrStatus(chamferFeature(ctx.picks, ctx.refs, CHAMFER_D), "Chamfer"),
  },
  {
    id: "extrude-along-edge",
    group: "modify",
    label: () => "Extrude along edge",
    visible: (ctx) => editing(ctx) && ctx.kind === "edge",
    enabled: (ctx) => edgeCount(ctx) > 0 && ctx.hasProfile,
    run: (ctx) =>
      addOrStatus(extrudeAlongEdgeFeature(ctx.picks, ctx.refs, ALONG_EDGE_H), "Extrude along edge"),
  },
  {
    id: "shell",
    group: "modify",
    label: () => "Shell faces",
    visible: (ctx) => editing(ctx) && ctx.kind === "face",
    enabled: (ctx) => faceCount(ctx) > 0,
    run: (ctx) => addOrStatus(shellFeature(ctx.picks, ctx.refs, SHELL_T), "Shell"),
  },
  {
    id: "draft",
    group: "modify",
    label: () => "Draft face",
    visible: (ctx) => editing(ctx) && ctx.kind === "face",
    enabled: (ctx) => faceCount(ctx) > 0,
    run: (ctx) => addOrStatus(draftFeature(ctx.picks, ctx.refs, DRAFT_A), "Draft"),
  },
  {
    id: "extrude-to-face",
    group: "modify",
    label: () => "Extrude to face",
    visible: (ctx) => editing(ctx) && ctx.kind === "face",
    enabled: (ctx) => faceCount(ctx) > 0 && ctx.hasProfile,
    run: (ctx) => addOrStatus(extrudeToFaceFeature(ctx.picks, ctx.refs), "Extrude to face"),
  },
  {
    id: "pad",
    group: "modify",
    label: () => "Pad (two-sided)",
    visible: (ctx) => editing(ctx) && ctx.hasProfile && (ctx.kind === "empty" || ctx.kind === "body"),
    enabled: (ctx) => ctx.hasProfile,
    run: () => addOrStatus(extrudeTwoSidedFeature(PAD_H, PAD_H), "Pad"),
  },
  {
    id: "gizmo-translate",
    group: "modify",
    label: () => "Move (gizmo)",
    visible: (ctx) => editing(ctx) && ctx.kind === "body",
    enabled: always,
    active: (ctx) => ctx.gizmoMode === "translate",
    run: () => cad().setGizmoMode("translate"),
  },
  {
    id: "gizmo-rotate",
    group: "modify",
    label: () => "Rotate (gizmo)",
    visible: (ctx) => editing(ctx) && ctx.kind === "body",
    enabled: always,
    active: (ctx) => ctx.gizmoMode === "rotate",
    run: () => cad().setGizmoMode("rotate"),
  },
];

// --- FEATURE: history ops on a tree-selected feature ---
const FEATURE: ContextAction[] = [
  {
    id: "edit-sketch",
    group: "feature",
    label: () => "Edit sketch",
    visible: (ctx) => {
      const f = selectedFeature(ctx);
      return ctx.kind === "feature" && f?.type === "sketch" && f.data?.["model"] != null;
    },
    enabled: (ctx) => ctx.solverReady,
    run: (ctx) => {
      const f = selectedFeature(ctx);
      if (f) editSketchFeature(f); // shared with the feature-tree FR-27 menu
    },
  },
  {
    id: "suppress",
    group: "feature",
    label: (ctx) => (selectedFeature(ctx)?.suppressed ? "Unsuppress" : "Suppress"),
    visible: (ctx) => ctx.kind === "feature" && selectedFeature(ctx) != null,
    enabled: always,
    run: (ctx) => {
      if (ctx.selectedFeatureId) cad().toggleSuppress(ctx.selectedFeatureId);
    },
  },
  {
    id: "rollback",
    group: "feature",
    label: () => "Roll back to here",
    visible: (ctx) => ctx.kind === "feature" && selectedFeature(ctx) != null,
    enabled: (ctx) => selectedIndex(ctx) >= 0,
    run: (ctx) => {
      const i = selectedIndex(ctx);
      if (i >= 0) cad().setRollback(i);
    },
  },
  {
    id: "delete-feature",
    group: "danger",
    label: () => "Delete feature",
    danger: true,
    visible: (ctx) => ctx.kind === "feature" && selectedFeature(ctx) != null,
    enabled: always,
    run: (ctx) => {
      if (ctx.selectedFeatureId) cad().removeFeature(ctx.selectedFeatureId);
    },
  },
];

// --- ASSEMBLY: ops on a right-clicked component instance ---
const ASSEMBLY: ContextAction[] = [
  {
    id: "instance-fixed",
    group: "assembly",
    label: () => "Toggle fixed (ground)",
    visible: (ctx) => ctx.kind === "assemblyInstance" && ctx.instanceId != null,
    enabled: always,
    run: (ctx) => {
      if (ctx.instanceId) cad().toggleInstanceFixed(ctx.instanceId);
    },
  },
  {
    id: "explode",
    group: "assembly",
    label: (ctx) => (ctx.explodeFactor > 0 ? "Collapse view" : "Explode view"),
    visible: (ctx) => ctx.kind === "assemblyInstance",
    enabled: always,
    run: (ctx) => cad().setExplodeFactor(ctx.explodeFactor > 0 ? 0 : 0.5),
  },
  {
    id: "interference",
    group: "assembly",
    label: () => "Check interference",
    visible: (ctx) => ctx.kind === "assemblyInstance",
    enabled: always,
    run: () => cad().checkInterference(),
  },
  {
    id: "remove-instance",
    group: "danger",
    label: () => "Remove instance",
    danger: true,
    visible: (ctx) => ctx.kind === "assemblyInstance" && ctx.instanceId != null,
    enabled: always,
    run: (ctx) => {
      if (ctx.instanceId) cad().removeInstance(ctx.instanceId);
    },
  },
];

// --- MATE: apply a mate from the two accumulated endpoint picks (FR mate authoring) ---
const SIMPLE_MATES: { kind: "coincident" | "concentric" | "parallel" | "perpendicular"; label: string }[] =
  [
    { kind: "coincident", label: "Coincident mate" },
    { kind: "concentric", label: "Concentric mate" },
    { kind: "parallel", label: "Parallel mate" },
    { kind: "perpendicular", label: "Perpendicular mate" },
  ];

const MATE: ContextAction[] = [
  ...SIMPLE_MATES.map(
    (m): ContextAction => ({
      id: `mate-${m.kind}`,
      group: "mate",
      label: () => m.label,
      visible: (ctx) => ctx.mateMode && !ctx.simulating,
      enabled: (ctx) => ctx.matePickCount === 2,
      run: () => cad().applyMate(m.kind),
    }),
  ),
  {
    id: "mate-distance",
    group: "mate",
    label: () => "Distance mate…",
    visible: (ctx) => ctx.mateMode && !ctx.simulating,
    enabled: (ctx) => ctx.matePickCount === 2,
    run: () => {
      const mm = Number(globalThis.prompt?.("Distance (mm)", "10"));
      if (Number.isFinite(mm)) cad().applyMate("distance", mm / 1000);
    },
  },
  {
    id: "mate-angle",
    group: "mate",
    label: () => "Angle mate…",
    visible: (ctx) => ctx.mateMode && !ctx.simulating,
    enabled: (ctx) => ctx.matePickCount === 2,
    run: () => {
      const deg = Number(globalThis.prompt?.("Angle (deg)", "90"));
      if (Number.isFinite(deg)) cad().applyMate("angle", (deg * Math.PI) / 180);
    },
  },
  {
    id: "mate-cancel",
    group: "mate",
    label: () => "Cancel mate mode",
    visible: (ctx) => ctx.mateMode,
    enabled: always,
    run: () => cad().setMateMode(false),
  },
];

// --- SIM: playback controls while simulating (FR-41) ---
const SIM: ContextAction[] = [
  {
    id: "sim-pause",
    group: "sim",
    label: (ctx) => (ctx.simPaused ? "Resume" : "Pause"),
    visible: (ctx) => ctx.simulating,
    enabled: always,
    run: (ctx) => cad().setSimPaused(!ctx.simPaused),
  },
  {
    id: "sim-step",
    group: "sim",
    label: () => "Step one frame",
    visible: (ctx) => ctx.simulating,
    enabled: (ctx) => ctx.simPaused,
    run: () => cad().requestSimStep(),
  },
  {
    id: "sim-rewind",
    group: "sim",
    label: () => "Rewind to start",
    visible: (ctx) => ctx.simulating,
    enabled: always,
    run: () => cad().requestSimRewind(),
  },
  {
    id: "sim-stop",
    group: "danger",
    label: () => "Stop simulation",
    danger: true,
    visible: (ctx) => ctx.simulating,
    enabled: always,
    run: () => cad().setSimulating(false),
  },
];

// --- VIEW + SELECTION: always-available framing / display / deselect ---
const VIEW: ContextAction[] = [
  {
    id: "fit-view",
    group: "view",
    label: () => "Fit to view",
    visible: (ctx) => !ctx.inSketch,
    enabled: always,
    run: () => fitToView(),
  },
  {
    id: "section",
    group: "view",
    label: (ctx) => (ctx.section ? "Exit section view" : "Section view"),
    visible: (ctx) => !ctx.inSketch && !ctx.simulating,
    enabled: always,
    run: (ctx) => cad().setSection(ctx.section ? null : { axis: "x", t: 0.5 }),
  },
  {
    id: "measure",
    group: "view",
    label: (ctx) => (ctx.measuring ? "Stop measuring" : "Measure"),
    visible: (ctx) => !ctx.inSketch && !ctx.simulating,
    enabled: always,
    run: () => cad().toggleMeasure(),
  },
];

const SELECTION: ContextAction[] = [
  {
    id: "clear-selection",
    group: "selection",
    label: () => "Clear selection",
    visible: (ctx) => !ctx.inSketch && ctx.picks.length > 0,
    enabled: (ctx) => ctx.picks.length > 0,
    run: () => cad().clearPicks(),
  },
];

// --- SKETCH: select-then-constrain / dimension / fix / finish, inside the 2D
// sketcher (FR-16..FR-19). Only the constraints/dimensions the selection actually
// supports are shown (canApply/canDimension), so the menu stays context-filtered. ---
const SKETCH_CONSTRAINTS: { kind: ConstraintKind; label: string }[] = [
  { kind: "horizontal", label: "Horizontal" },
  { kind: "vertical", label: "Vertical" },
  { kind: "coincident", label: "Coincident" },
  { kind: "parallel", label: "Parallel" },
  { kind: "perpendicular", label: "Perpendicular" },
  { kind: "equalLength", label: "Equal length" },
  { kind: "concentric", label: "Concentric" },
  { kind: "tangent", label: "Tangent" },
  { kind: "midpoint", label: "Midpoint" },
  { kind: "pointOnObject", label: "Point on object" },
  { kind: "symmetric", label: "Symmetric" },
];

const SKETCH_DIMENSIONS: { kind: DimensionKind; label: string }[] = [
  { kind: "distance", label: "Distance" },
  { kind: "hDistance", label: "Horizontal distance" },
  { kind: "vDistance", label: "Vertical distance" },
  { kind: "radius", label: "Radius" },
  { kind: "diameter", label: "Diameter" },
  { kind: "angle", label: "Angle" },
];

const SKETCH: ContextAction[] = [
  ...SKETCH_CONSTRAINTS.map(
    (c): ContextAction => ({
      id: `sk-constraint-${c.kind}`,
      group: "sketch",
      label: () => c.label,
      visible: (ctx) =>
        ctx.inSketch &&
        ctx.sketchModel != null &&
        ctx.sketchSelection.length > 0 &&
        canApply(c.kind, ctx.sketchModel, ctx.sketchSelection),
      enabled: always,
      run: () => sketch().applyConstraint(c.kind),
    }),
  ),
  ...SKETCH_DIMENSIONS.map(
    (d): ContextAction => ({
      id: `sk-dim-${d.kind}`,
      group: "sketch",
      label: () => `Dimension: ${d.label}`,
      visible: (ctx) =>
        ctx.inSketch &&
        ctx.sketchModel != null &&
        ctx.sketchSelection.length > 0 &&
        canDimension(d.kind, ctx.sketchModel, ctx.sketchSelection),
      enabled: always,
      run: () => sketch().addDimension(d.kind),
    }),
  ),
  {
    id: "sk-fix",
    group: "sketch",
    label: (ctx) => (selectedSketchPoint(ctx)?.fixed ? "Unfix point" : "Fix point"),
    visible: (ctx) => ctx.inSketch && selectedSketchPoint(ctx) != null,
    enabled: always,
    run: (ctx) => {
      const p = selectedSketchPoint(ctx);
      if (p) sketch().toggleFix(p.id);
    },
  },
  {
    id: "sk-finish",
    group: "sketch",
    label: () => "Finish sketch",
    visible: (ctx) => ctx.inSketch,
    // Only commit when a closed profile can be derived (matches the Sketcher's
    // Finish gating); finishSketchFeature stays in the sketch otherwise.
    enabled: (ctx) => ctx.sketchModel != null && extractProfile(ctx.sketchModel) != null,
    run: () => finishSketchFeature(),
  },
  {
    id: "sk-cancel",
    group: "sketch",
    label: () => "Cancel sketch",
    visible: (ctx) => ctx.inSketch,
    enabled: always,
    run: () => sketch().exitSketch(),
  },
];

/** Every possible option, all contexts. contextOptions.ts filters + orders these. */
export const CONTEXT_ACTIONS: ContextAction[] = [
  ...CREATE,
  ...MODIFY,
  ...SKETCH,
  ...FEATURE,
  ...ASSEMBLY,
  ...MATE,
  ...SIM,
  ...VIEW,
  ...SELECTION,
];

/** Run a catalog action by id against a resolved target, honouring enabled().
 * Shared by the canvas provider + the sketcher's own right-click menu. */
export function runContextAction(id: string, target: ContextTarget): void {
  const action = CONTEXT_ACTIONS.find((a) => a.id === id);
  if (action && action.enabled(target)) action.run(target);
}
