// SPEC-6 FR-18a — the paid-job confirm dialog, shared by the GenerationPanel and the
// command palette. Bridged from the create_mesh handler's async `confirm` gate: the
// handler awaits a promise whose resolve the modal's buttons call. Not a blocking
// window.confirm (testable; the browser-automation harness forbids modal dialogs).

import type { PaidJobInfo } from "./tools/createMesh.js";

/** A pending paid-job confirmation: the create_mesh handler's `confirm` returns this
 * promise's resolve, the modal buttons settle it. */
export interface PendingConfirm {
  info: PaidJobInfo;
  resolve: (approved: boolean) => void;
}

export function PaidJobConfirmModal({
  info,
  onResolve,
}: {
  info: PaidJobInfo;
  onResolve: (approved: boolean) => void;
}): React.JSX.Element {
  const { mode, providerId, billableCalls } = info;
  return (
    <div data-testid="paid-confirm" className="rounded border border-[#7a5a2a] bg-[#1c1608] p-2 text-[11px] text-[#ecd]">
      <p className="mb-1 font-semibold text-[#fda]">Confirm paid generation</p>
      <p className="mb-2 text-[#cba]">
        This runs a billable cloud job: <span className="text-[#fec]">{mode}</span> via{" "}
        <span className="text-[#fec]">{providerId}</span> ({billableCalls} billable call
        {billableCalls === 1 ? "" : "s"}). Your provider account is charged.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="paid-confirm-yes"
          onClick={() => onResolve(true)}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48]"
        >
          Confirm &amp; run
        </button>
        <button
          type="button"
          data-testid="paid-confirm-no"
          onClick={() => onResolve(false)}
          className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
