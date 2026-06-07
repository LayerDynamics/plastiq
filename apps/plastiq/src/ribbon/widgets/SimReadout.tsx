// Elapsed sim-time + run/paused readout for the Simulate workspace's ribbon (FR-41).
// A self-contained widget that subscribes to simTicks so only it re-renders each
// frame — the ribbon itself deliberately does NOT subscribe to simTicks.

import { useCadStore } from "../../store/store.js";
import { SIM_TICK_RATE_HZ } from "../../sim/simulator.js";

export function SimReadout(): React.JSX.Element {
  const simTicks = useCadStore((s) => s.simTicks);
  const paused = useCadStore((s) => s.simPaused);
  return (
    <div data-testid="sim-readout" className="flex items-center gap-2 px-1">
      <span data-testid="sim-time" className="tabular-nums text-xs text-[#cfe]">
        {(simTicks / SIM_TICK_RATE_HZ).toFixed(2)}s
      </span>
      <span className="text-[10px] uppercase tracking-wide text-[#678]">
        {paused ? "paused" : "running"}
      </span>
    </div>
  );
}
