// Simulate control helpers (R3 · P2).
//
// A Simulate start or rewind can REJECT: client.lower is fail-fast, so a document
// with even one errored feature — which the viewport still renders via per-feature
// isolation — rejects the lower. Previously the rejecting promise had no handler,
// so the failure was an unhandled rejection with no status while `simulating`
// stayed wedged `true` with no world. `applySimFailure` is the recovery: surface
// the reason and return to the design workspace (the store's authority over
// `simulating`, which flips it back to false). Extracted so the recovery is
// unit-testable without mounting the three.js Viewport.

import type { Workspace } from "../store/types.js";

/** The store surface `applySimFailure` needs — matched by the real CadStore. */
export interface SimFailureStore {
  setStatus: (status: string) => void;
  setWorkspace: (w: Workspace) => void;
}

/** Human-readable text for a Simulate failure. */
export function simFailureMessage(err: unknown): string {
  return `Simulate failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** Surface a Simulate failure on the status line and return to design mode,
 * resetting `simulating` via the workspace authority. */
export function applySimFailure(store: SimFailureStore, err: unknown): void {
  store.setStatus(simFailureMessage(err));
  store.setWorkspace("design");
}
