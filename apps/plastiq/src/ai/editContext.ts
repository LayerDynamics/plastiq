// SPEC-6 R2.2 — edit-mode context (FR-6a, decision 13).
//
// When a part is already open, the agent runner injects the current document — as a
// mm/deg AUTHORING document — into the model's context, so it edits from the real
// current state and re-emits the WHOLE updated document via build_part (there is no
// diff/patch protocol; the model owns the merge with the current doc in hand).

import { toAuthoringDoc } from "./tools/schema.js";
import type { CadDocument } from "../store/types.js";

/**
 * The edit-context block for the system prompt, or null when there is nothing to
 * edit (no open part / empty document → the model creates fresh).
 */
export function editContext(currentDoc: CadDocument | null | undefined): string | null {
  if (!currentDoc || currentDoc.features.length === 0) return null;
  const authoring = toAuthoringDoc(currentDoc);
  return [
    "The user has a part open. Its current feature document is below (units: mm / degrees).",
    "To EDIT it, modify this document and call build_part with the WHOLE updated document",
    "(add, change, remove, or reorder features). To start over, ignore it and build fresh.",
    "```json",
    JSON.stringify(authoring, null, 2),
    "```",
  ].join("\n");
}
