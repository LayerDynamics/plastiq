// Trailing-edge coalescer for an async task. While a run is in flight, further
// schedule() calls don't start new runs — they request exactly ONE trailing run
// that fires when the current run finishes (and observes the latest state). This
// is what collapses a burst of store changes (e.g. a gizmo drag emitting a tick
// per frame) into one in-flight rebuild plus a single catch-up rebuild, instead
// of saturating the geometry worker. Extracted from the Viewport rebuild loop so
// this load-bearing logic is unit-testable in isolation.

export interface Coalescer {
  /**
   * Run the task now if idle; if a run is already in flight, request exactly one
   * trailing re-run for when it completes (repeated calls during a run collapse to
   * that single re-run).
   */
  schedule(): void;
}

/**
 * @param task        the async work to coalesce.
 * @param isCancelled checked at completion; when it returns true the trailing
 *                    re-run is suppressed (the owner is tearing down). Defaults to
 *                    never-cancelled.
 */
export function createCoalescer(
  task: () => Promise<void>,
  isCancelled: () => boolean = () => false,
): Coalescer {
  let building = false;
  let pending = false;

  const run = (): void => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    void (async (): Promise<void> => {
      try {
        await task();
      } finally {
        building = false;
        if (pending && !isCancelled()) {
          pending = false;
          run();
        }
      }
    })();
  };

  return { schedule: run };
}
