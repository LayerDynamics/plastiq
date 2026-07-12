// Elapsed sim-time + run/paused readout for the Simulate workspace's ribbon (FR-41).
// A self-contained widget that subscribes to simTicks so only it re-renders each
// frame — the ribbon itself deliberately does NOT subscribe to simTicks.

import { useCadStore } from "../../store/store.js";
import { EXPERIMENT_LABELS } from "../../sim/experiments.js";
import { SIM_TICK_RATE_HZ } from "../../sim/simulator.js";

export function SimReadout(): React.JSX.Element {
  const simTicks = useCadStore((s) => s.simTicks);
  const paused = useCadStore((s) => s.simPaused);
  const kind = useCadStore((s) => s.simExperiment.kind);
  const settled = useCadStore((s) => s.simTelemetry?.settled ?? false);
  return (
    <div data-testid="sim-readout" className="flex items-center gap-2 px-1">
      <span data-testid="sim-time" className="tabular-nums text-xs text-[#cfe]">
        {(simTicks / SIM_TICK_RATE_HZ).toFixed(2)}s
      </span>
      <span
        data-testid="sim-experiment-label"
        className="max-w-[10rem] truncate text-[10px] text-[#8aa]"
        title={EXPERIMENT_LABELS[kind]}
      >
        {EXPERIMENT_LABELS[kind]}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-[#678]">
        {paused ? "paused" : settled ? "settled" : "running"}
      </span>
    </div>
  );
}
