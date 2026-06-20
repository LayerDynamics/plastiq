// SPEC-6 R1.1 — usage accounting (spec §6.8, FR-18a).
//
// Accumulates token usage across an agent run and counts paid jobs (3D/image
// generation). The generation panel renders the snapshot; the paid-job confirm
// gate increments `paidJobs` only after the user approves a billable call.

import type { TokenUsage } from "./providers/types.js";

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  paidJobs: number;
}

export class UsageMeter {
  private input = 0;
  private output = 0;
  private paid = 0;

  /** Fold one provider `usage` event into the running totals. */
  addTokens(u: TokenUsage): void {
    this.input += u.inputTokens;
    this.output += u.outputTokens;
  }

  /** Record `n` paid (billable) jobs — called after the user confirms. */
  addPaidJob(n = 1): void {
    this.paid += n;
  }

  /** An independent point-in-time copy of the counters (never live state). */
  snapshot(): UsageSnapshot {
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      totalTokens: this.input + this.output,
      paidJobs: this.paid,
    };
  }

  reset(): void {
    this.input = 0;
    this.output = 0;
    this.paid = 0;
  }
}
