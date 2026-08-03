// SPEC-6 R2.2 — edit-mode context (FR-6a, decision 13).
//
// When a part is already open, the agent runner injects the current document — as a
// mm/deg AUTHORING document — into the model's context, so it edits from the real
// current state and re-emits the WHOLE updated document via build_part (there is no
// diff/patch protocol; the model owns the merge with the current doc in hand).
//
// R11 (§5.3): the context also carries the live viewport SELECTION (picked faces/edges
// with their persistent-ref identity) and the document's STANDING featureErrors/
// featureWarnings, so the agent can honor "fillet the face I picked" and is never shown
// a broken document as if it were healthy. Both are read from the live store by default.

import { toMm, type EdgeRef, type FaceRef, type SurfaceSignature } from "@plastiq/cad";
import { toAuthoringDoc, type AuthoringDocument } from "./tools/schema.js";
import { useCadStore, type SelectionRefs } from "../store/store.js";
import type { CadDocument, Pick } from "../store/types.js";

/** Hard ceiling (chars) on the embedded edit-context JSON. A backstop for a doc with
 * many features; the importStep digest below already removes the usual blow-up. */
const MAX_CONTEXT_CHARS = 16_000;

/** Cap on how many picks / error entries we spell out, so a pathological selection
 * (e.g. "select all 400 edges") or a cascade of failures can't blow the prompt. */
const MAX_SELECTION_ENTRIES = 24;
/** Cap on a single feature-error message so a raw multi-line OCCT dump stays terse. */
const MAX_ERROR_CHARS = 240;

/**
 * The slice of the store the agent needs beyond the document itself (§5.3, R11):
 * the current viewport SELECTION (so "fillet the face I picked" can be honored) and
 * the STANDING rebuild errors/warnings (so a broken document isn't presented as
 * healthy). Passed explicitly by tests; defaults to the live store in production.
 */
export interface EditSelectionContext {
  readonly picks: readonly Pick[];
  readonly selectionRefs: SelectionRefs;
  readonly selectedFeatureId: string | null;
  readonly featureErrors: Readonly<Record<string, string>>;
  readonly featureWarnings: Readonly<Record<string, string>>;
}

/** Read the selection/error slice from the live store (the same authority
 * `agentTurn` reads `currentDoc` from: `useCadStore.getState().toDocument()`). */
function selectionFromStore(): EditSelectionContext {
  const s = useCadStore.getState();
  return {
    picks: s.picks,
    selectionRefs: s.selectionRefs,
    selectedFeatureId: s.selectedFeatureId,
    featureErrors: s.featureErrors,
    featureWarnings: s.featureWarnings,
  };
}

/** Round a dimensionless quantity (a unit-vector component) to 3 places. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
/** SI metres → mm, rounded to 2 places, to match the document's mm/deg units. */
const mmOf = (metres: number): number => Math.round(toMm(metres) * 100) / 100;
/** A unit vector, e.g. `[0, 0, 1]`. */
const vec = (v: readonly number[]): string => `[${v.map(r3).join(", ")}]`;
/** A point converted to mm, e.g. `[30, 20, 10]`. */
const pointMm = (v: readonly number[]): string => `[${v.map(mmOf).join(", ")}]`;

/** The bare adjective for a surface kind ("planar", "cylindrical", …). */
function surfaceKind(sig: SurfaceSignature): string {
  switch (sig.kind) {
    case "plane":
      return "planar";
    case "cylinder":
      return "cylindrical";
    case "cone":
      return "conical";
    case "sphere":
      return "spherical";
    case "torus":
      return "toroidal";
    default:
      return "freeform";
  }
}

/** A fuller one-line description of a surface, incl. its analytic parameters. */
function describeSurface(sig: SurfaceSignature): string {
  switch (sig.kind) {
    case "plane":
      return `planar, normal ${vec(sig.normal)}`;
    case "cylinder":
      return `cylindrical r=${mmOf(sig.radius)}mm, axis ${vec(sig.axis)}`;
    case "cone":
      return `conical r=${mmOf(sig.radius)}mm, axis ${vec(sig.axis)}`;
    case "sphere":
      return `spherical r=${mmOf(sig.radius)}mm`;
    case "torus":
      return `toroidal R=${mmOf(sig.majorRadius)}mm r=${mmOf(sig.minorRadius)}mm`;
    default:
      return "freeform";
  }
}

/** Describe a picked face from its persistent ref (surface identity + position). */
function describeFace(ref: FaceRef): string {
  const parts: string[] = [ref.surface ? describeSurface(ref.surface) : `normal ${vec(ref.normal)}`];
  if (ref.centroid) parts.push(`at ${pointMm(ref.centroid)} mm`);
  return parts.join(", ");
}

/** Describe a picked edge from its persistent ref (adjacent surfaces + midpoint). */
function describeEdge(ref: EdgeRef): string {
  const parts: string[] = [];
  if (ref.faceSurfaces) {
    parts.push(`between ${surfaceKind(ref.faceSurfaces[0])} and ${surfaceKind(ref.faceSurfaces[1])} faces`);
  }
  if (ref.midpoint) parts.push(`at ${pointMm(ref.midpoint)} mm`);
  return parts.join(", ");
}

/**
 * A concise, human-readable digest of the user's current viewport selection, or "" when
 * nothing is picked. Faces/edges carry their persistent-ref identity (surface kind,
 * normal/axis, position in mm) so the model can target them via a dress-up selector
 * (e.g. `tangentFaces` seeded from a face's normal) or by index after inspect_geometry.
 */
function selectionDigest(sel: EditSelectionContext): string {
  const shown = sel.picks.slice(0, MAX_SELECTION_ENTRIES);
  const lines = shown.map((p) => {
    if (p.kind === "face") {
      const ref = sel.selectionRefs.faces[p.id];
      return `- face #${p.id}${ref ? ` (${describeFace(ref)})` : ""}`;
    }
    if (p.kind === "edge") {
      const ref = sel.selectionRefs.edges[p.id];
      return `- edge #${p.id}${ref ? ` (${describeEdge(ref)})` : ""}`;
    }
    if (p.kind === "vertex") return `- vertex #${p.id}`;
    return `- body #${p.id} (whole solid)`;
  });
  if (sel.picks.length > MAX_SELECTION_ENTRIES) {
    lines.push(`- …and ${sel.picks.length - MAX_SELECTION_ENTRIES} more`);
  }
  const featureLine =
    sel.selectedFeatureId != null
      ? [`The feature tree selection is on feature "${sel.selectedFeatureId}".`]
      : [];
  if (lines.length === 0 && featureLine.length === 0) return "";
  return [
    "CURRENT SELECTION — the entities the user has picked in the viewport. When the",
    'request says "the face/edge I picked", "this hole", "that edge", etc., act on these:',
    "target them with a dress-up data.selector (e.g. a tangentFaces seed matching a picked",
    "face's normal), or reference them by index after calling inspect_geometry.",
    ...lines,
    ...featureLine,
  ].join("\n");
}

/** Collapse a raw feature-error message to a single terse line for the prompt. */
function clipError(msg: string): string {
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS)}…` : oneLine;
}

/**
 * A digest of the document's STANDING rebuild errors/warnings, or "" when the last
 * rebuild was clean. Without this the model is shown a broken document as if healthy
 * (§5.3) and only ever learns of failures it causes itself via the build probe.
 */
function errorsDigest(sel: EditSelectionContext): string {
  const errs = Object.entries(sel.featureErrors);
  const warns = Object.entries(sel.featureWarnings);
  if (errs.length === 0 && warns.length === 0) return "";
  const lines: string[] = [];
  if (errs.length > 0) {
    lines.push(
      "The document currently has BUILD ERRORS — these features FAILED the last rebuild and",
      "are MISSING from the part. Fix their params or remove them when you edit:",
    );
    for (const [id, msg] of errs.slice(0, MAX_SELECTION_ENTRIES)) {
      lines.push(`- ${id}: ${clipError(msg)}`);
    }
  }
  if (warns.length > 0) {
    lines.push("BUILD WARNINGS — these features built but changed nothing visible:");
    for (const [id, msg] of warns.slice(0, MAX_SELECTION_ENTRIES)) {
      lines.push(`- ${id}: ${clipError(msg)}`);
    }
  }
  return lines.join("\n");
}

/** Cheap, kernel-free digest of an imported STEP body: byte size + counts of the
 * STEP entities that signal "a real solid is here" (face / solid records). */
function stepDigest(step: string): { bytes: number; faces: number; solids: number } {
  const count = (re: RegExp): number => (step.match(re) ?? []).length;
  return {
    bytes: step.length,
    faces: count(/ADVANCED_FACE/g),
    solids: count(/MANIFOLD_SOLID_BREP|CLOSED_SHELL/g),
  };
}

/**
 * Replace each `importStep` feature's raw STEP text with a compact digest.
 *
 * An imported STEP body can be hundreds of KB; embedding it verbatim (as
 * `toAuthoringDoc` carries it in `data.step`) balloons the system prompt — a single
 * editing fixture measured ~644K tokens. The model can't usefully read raw STEP
 * anyway: it edits an imported solid by adding features (cut / extrude / fillet) on
 * top. So it only needs to know a solid is present and its rough size. Non-import
 * features pass through unchanged, so a normal feature doc round-trips exactly.
 *
 * The dropped `step` bytes are restored when the model re-emits the document, by
 * `reconcileImportSteps` in `tools/toolDefs.ts` (matched by feature id), so an edit
 * of an imported solid still validates and builds.
 */
function digestImportSteps(doc: AuthoringDocument): AuthoringDocument {
  let changed = false;
  const features = doc.features.map((f) => {
    if (f.type !== "importStep") return f;
    const step = f.data?.["step"];
    if (typeof step !== "string") return f;
    changed = true;
    return {
      ...f,
      data: {
        importedSolid: {
          ...stepDigest(step),
          note: "STEP omitted to keep the prompt small; edit by adding features on top of this body.",
        },
      },
    };
  });
  return changed ? { ...doc, features } : doc;
}

/**
 * The edit-context block for the system prompt, or null when there is nothing to
 * edit (no open part / empty document → the model creates fresh).
 *
 * `selection` (R11 / §5.3) carries the live viewport selection and standing rebuild
 * errors so the agent can honor "fillet the face I picked" and knows which features are
 * currently failing. It defaults to the live store (`useCadStore.getState()`) — the same
 * authority `agentTurn` reads `currentDoc` from — and is passed explicitly by tests.
 */
export function editContext(
  currentDoc: CadDocument | null | undefined,
  selection: EditSelectionContext = selectionFromStore(),
): string | null {
  if (!currentDoc || currentDoc.features.length === 0) return null;
  const authoring = digestImportSteps(toAuthoringDoc(currentDoc));
  let json = JSON.stringify(authoring, null, 2);
  let note = "";
  if (json.length > MAX_CONTEXT_CHARS) {
    json = json.slice(0, MAX_CONTEXT_CHARS);
    note = "\n(document truncated to keep the prompt small — edit the features you can see)";
  }
  const blocks: string[] = [
    "The user has a part open. Its current feature document is below (units: mm / degrees).",
    "An imported body shows a digest, not its STEP; edit it by adding features on top.",
    "To EDIT, modify this document and call build_part with the WHOLE updated document",
    "(add, change, remove, or reorder features). To start over, ignore it and build fresh.",
    "```json",
    json,
    "```" + note,
  ];
  const sel = selectionDigest(selection);
  if (sel) blocks.push("", sel);
  const errs = errorsDigest(selection);
  if (errs) blocks.push("", errs);
  return blocks.join("\n");
}
