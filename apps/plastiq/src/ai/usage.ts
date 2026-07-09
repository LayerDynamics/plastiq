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

/** Session-cumulative usage across ALL generation runs (panel + palette), 6-L2. The per-run
 * `UsageMeter` resets each run; this survives so the readout can show the whole session's spend,
 * plus the number of runs (`turns`) folded in. */
export interface SessionUsage {
  /** Number of generation runs folded into the session (a completed "turn"). */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  paidJobs: number;
}

export const EMPTY_SESSION_USAGE: SessionUsage = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  paidJobs: 0,
};

/** Fold a completed run's snapshot into the session totals (immutably): one more turn, with its
 * tokens and paid jobs accumulated. The single place the session meter grows (aiStore.recordRunUsage). */
export function foldRunIntoSession(session: SessionUsage, run: UsageSnapshot): SessionUsage {
  return {
    turns: session.turns + 1,
    inputTokens: session.inputTokens + run.inputTokens,
    outputTokens: session.outputTokens + run.outputTokens,
    totalTokens: session.totalTokens + run.totalTokens,
    paidJobs: session.paidJobs + run.paidJobs,
  };
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
