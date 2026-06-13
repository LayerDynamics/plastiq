// The rebuild coalescer (extracted from Viewport's building/pending/cancelled
// loop). These pin the load-bearing behavior every gizmo drag now drives: an
// in-flight run absorbs a burst into exactly ONE trailing run, and a cancelled
// owner suppresses that trailing run.

import { describe, expect, it } from "vitest";
import { createCoalescer } from "./coalesce.js";

/** A task whose each invocation returns a promise we resolve on demand. */
function deferredTask() {
  let runs = 0;
  const resolvers: Array<() => void> = [];
  return {
    task: (): Promise<void> => {
      runs++;
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    get runs() {
      return runs;
    },
    finishOne(): void {
      const r = resolvers.shift();
      if (!r) throw new Error("no in-flight run to finish");
      r();
    },
  };
}

// Drain enough microtask ticks for: the awaited task to settle → the finally →
// the synchronous trailing run() → its task() call.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("createCoalescer", () => {
  it("runs the task immediately on an idle schedule()", async () => {
    const d = deferredTask();
    const c = createCoalescer(d.task);
    c.schedule();
    expect(d.runs).toBe(1);
    d.finishOne();
    await flush();
    expect(d.runs).toBe(1); // nothing pending → no re-run
  });

  it("collapses a burst during an in-flight run into exactly ONE trailing run", async () => {
    const d = deferredTask();
    const c = createCoalescer(d.task);
    c.schedule(); // run 1 starts, in flight
    expect(d.runs).toBe(1);
    c.schedule(); // building → pending
    c.schedule(); // building → still just pending
    c.schedule(); // building → still just pending
    expect(d.runs).toBe(1); // no new runs start while one is in flight
    d.finishOne(); // finish run 1 → exactly ONE trailing run
    await flush();
    expect(d.runs).toBe(2); // not 3 or 4 — the burst collapsed
    d.finishOne(); // finish trailing run → nothing pending
    await flush();
    expect(d.runs).toBe(2);
  });

  it("suppresses the trailing run when cancelled before the in-flight run finishes", async () => {
    const d = deferredTask();
    let cancelled = false;
    const c = createCoalescer(d.task, () => cancelled);
    c.schedule(); // run 1 in flight
    c.schedule(); // pending
    cancelled = true; // owner tears down mid-run
    d.finishOne(); // run 1 finishes → pending, but cancelled ⇒ NO trailing run
    await flush();
    expect(d.runs).toBe(1);
  });

  it("runs each schedule() when calls do not overlap", async () => {
    const d = deferredTask();
    const c = createCoalescer(d.task);
    c.schedule();
    d.finishOne();
    await flush();
    c.schedule(); // idle again → a fresh run
    expect(d.runs).toBe(2);
    d.finishOne();
    await flush();
    expect(d.runs).toBe(2);
  });
});
