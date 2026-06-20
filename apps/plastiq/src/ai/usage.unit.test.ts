// SPEC-6 R1.1 (T1.1): usage accounting — token totals + paid-job counter that the
// generation panel shows and the paid-job confirm gate (FR-18a) reads.

import { describe, it, expect } from "vitest";
import { UsageMeter } from "./usage.js";

describe("R1.1 UsageMeter", () => {
  it("accumulates input/output tokens across turns and totals them", () => {
    const m = new UsageMeter();
    m.addTokens({ inputTokens: 100, outputTokens: 20 });
    m.addTokens({ inputTokens: 50, outputTokens: 10 });
    const s = m.snapshot();
    expect(s.inputTokens).toBe(150);
    expect(s.outputTokens).toBe(30);
    expect(s.totalTokens).toBe(180);
  });

  it("counts paid jobs (default 1, explicit n)", () => {
    const m = new UsageMeter();
    m.addPaidJob();
    m.addPaidJob(2);
    expect(m.snapshot().paidJobs).toBe(3);
  });

  it("resets all counters", () => {
    const m = new UsageMeter();
    m.addTokens({ inputTokens: 5, outputTokens: 5 });
    m.addPaidJob();
    m.reset();
    expect(m.snapshot()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, paidJobs: 0 });
  });

  it("snapshot is an independent copy (not live state)", () => {
    const m = new UsageMeter();
    const s = m.snapshot();
    m.addTokens({ inputTokens: 10, outputTokens: 0 });
    expect(s.inputTokens).toBe(0); // earlier snapshot unaffected
  });
});
