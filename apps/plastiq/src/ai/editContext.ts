// SPEC-6 R2.2 — edit-mode context (FR-6a, decision 13).
//
// When a part is already open, the agent runner injects the current document — as a
// mm/deg AUTHORING document — into the model's context, so it edits from the real
// current state and re-emits the WHOLE updated document via build_part (there is no
// diff/patch protocol; the model owns the merge with the current doc in hand).

import { toAuthoringDoc, type AuthoringDocument } from "./tools/schema.js";
import type { CadDocument } from "../store/types.js";

/** Hard ceiling (chars) on the embedded edit-context JSON. A backstop for a doc with
 * many features; the importStep digest below already removes the usual blow-up. */
const MAX_CONTEXT_CHARS = 16_000;

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
 */
export function editContext(currentDoc: CadDocument | null | undefined): string | null {
  if (!currentDoc || currentDoc.features.length === 0) return null;
  const authoring = digestImportSteps(toAuthoringDoc(currentDoc));
  let json = JSON.stringify(authoring, null, 2);
  let note = "";
  if (json.length > MAX_CONTEXT_CHARS) {
    json = json.slice(0, MAX_CONTEXT_CHARS);
    note = "\n(document truncated to keep the prompt small — edit the features you can see)";
  }
  return [
    "The user has a part open. Its current feature document is below (units: mm / degrees).",
    "An imported body shows a digest, not its STEP; edit it by adding features on top.",
    "To EDIT, modify this document and call build_part with the WHOLE updated document",
    "(add, change, remove, or reorder features). To start over, ignore it and build fresh.",
    "```json",
    json,
    "```" + note,
  ].join("\n");
}
