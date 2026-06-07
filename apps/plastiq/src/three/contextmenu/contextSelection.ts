// Resolve "what did the user right-click" into a normalized ContextTarget that the
// action catalog (config.ts) filters against. Pure over store snapshots + the pick
// result, so it unit-tests in Node with no WebGL/DOM — the heart of the
// context-filtered menu ("show the actions applicable to the selected item").

import type { EditorFeature, FeatureId, Pick, SelectionMode } from "../../store/types.js";
import type { SelectionRefs } from "../../store/store.js";
import type { SketchModel } from "../../sketch/model.js";

/** The kind of thing the menu is acting on (precedence-resolved, see below). */
export type ContextKind =
  | "empty"
  | "face"
  | "edge"
  | "vertex"
  | "body"
  | "feature"
  | "sketchEntity"
  | "assemblyInstance";

/** Normalized descriptor every catalog predicate + run() reads. */
export interface ContextTarget {
  kind: ContextKind;
  /** The effective 3D selection the menu acts on (post select-then-menu). */
  picks: Pick[];
  selMode: SelectionMode;
  /** Persistent ref lookup for dress-up builders (FR-16). */
  refs: SelectionRefs;
  features: EditorFeature[];
  selectedFeatureId: FeatureId | null;
  /** Orthogonal mode flags (sketch / mate / simulate are modal overlays). */
  inSketch: boolean;
  sketchSelection: string[];
  /** The live sketch model (for constraint/dimension applicability), null outside sketch. */
  sketchModel: SketchModel | null;
  mateMode: boolean;
  matePickCount: number;
  simulating: boolean;
  simPaused: boolean;
  /** Gate for Extrude/Cut/Revolve — true when an upstream sketch profile exists. */
  hasProfile: boolean;
  /** planegcs loaded — gates entering a sketch. */
  solverReady: boolean;
  /** Section clip on/off (drives the toggle label + run). */
  section: { axis: "x" | "y" | "z"; t: number } | null;
  /** Measure tool active (drives the toggle label). */
  measuring: boolean;
  /** Exploded-view factor (0 = assembled) — drives the explode toggle. */
  explodeFactor: number;
  /** Current transform-gizmo mode (shown active in the body context). */
  gizmoMode: "translate" | "rotate";
  /** Set when an assembly instance (not the base part) was right-clicked. */
  instanceId: string | null;
  /** drei <Html> anchor: the 3D point under the cursor. */
  worldPoint: [number, number, number];
}

/** The store fields contextSelection needs (a snapshot, kept pure/testable). */
export interface CadSnapshot {
  picks: Pick[];
  selMode: SelectionMode;
  selectionRefs: SelectionRefs;
  features: EditorFeature[];
  selectedFeatureId: FeatureId | null;
  mateMode: boolean;
  matePicks: readonly unknown[];
  simulating: boolean;
  simPaused: boolean;
  section: { axis: "x" | "y" | "z"; t: number } | null;
  measuring: boolean;
  explodeFactor: number;
  gizmoMode: "translate" | "rotate";
}

export interface SketchSnapshot {
  active: boolean;
  selection: string[];
  solverReady: boolean;
  model: SketchModel | null;
}

/** What the right-click resolved under the cursor (null = empty space). */
export interface RightClickHit {
  kind: SelectionMode;
  id: number;
  /** Present when the hit is an assembly instance rather than the base part. */
  instanceId?: string | null;
}

/**
 * True when an upstream, unsuppressed sketch carries a profile/model (FR-30 gate).
 * Mirrors the exact predicate the toolbar uses for Extrude/Cut/Revolve
 * (`Toolbar.tsx` FeatureMenu) so the menu gates identically.
 */
export function hasSketchProfile(features: readonly EditorFeature[]): boolean {
  return features.some(
    (f) =>
      f.type === "sketch" &&
      !f.suppressed &&
      (f.data?.["profile"] != null || f.data?.["model"] != null),
  );
}

/**
 * Resolve the context target. Kind precedence (most-specific modal first):
 *   sketcher open → "sketchEntity"
 *   else hit on an assembly instance → "assemblyInstance"
 *   else a 3D entity hit/selection → face | edge | vertex | body (by hit/selMode)
 *   else a feature is selected (tree) with no 3D picks → "feature"
 *   else → "empty"
 * `simulating` / `mateMode` stay as flags the catalog also keys off.
 */
export function resolveContextTarget(input: {
  cad: CadSnapshot;
  sketch: SketchSnapshot;
  hit: RightClickHit | null;
  worldPoint: [number, number, number];
}): ContextTarget {
  const { cad, sketch, hit, worldPoint } = input;
  const base = {
    picks: cad.picks,
    selMode: cad.selMode,
    refs: cad.selectionRefs,
    features: cad.features,
    selectedFeatureId: cad.selectedFeatureId,
    inSketch: sketch.active,
    sketchSelection: sketch.selection,
    sketchModel: sketch.model,
    mateMode: cad.mateMode,
    matePickCount: cad.matePicks.length,
    simulating: cad.simulating,
    simPaused: cad.simPaused,
    hasProfile: hasSketchProfile(cad.features),
    solverReady: sketch.solverReady,
    section: cad.section,
    measuring: cad.measuring,
    explodeFactor: cad.explodeFactor,
    gizmoMode: cad.gizmoMode,
    instanceId: hit?.instanceId ?? null,
    worldPoint,
  };

  let kind: ContextKind;
  if (sketch.active) kind = "sketchEntity";
  else if (hit?.instanceId) kind = "assemblyInstance";
  else if (hit) kind = hit.kind;
  else if (cad.picks.length > 0) kind = cad.picks[0]!.kind;
  else if (cad.selectedFeatureId != null) kind = "feature";
  else kind = "empty";

  return { kind, ...base };
}
