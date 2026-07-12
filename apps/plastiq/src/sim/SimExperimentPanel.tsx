// Physics Experiments panel — run meaningful simulations on the current CAD
// geometry: drop tests, free fall, rest on ground, zero-g, with live telemetry.

import { useCadStore } from "../store/store.js";
import {
  EXPERIMENT_HELP,
  EXPERIMENT_LABELS,
  experimentWantsGround,
  type SimBackendChoice,
  type SimExperimentKind,
} from "./experiments.js";

const KINDS: SimExperimentKind[] = ["drop-test", "free-fall", "rest", "zero-g"];
const BACKENDS: { id: SimBackendChoice; label: string }[] = [
  { id: "default", label: "Default (MuJoCo)" },
  { id: "mujoco", label: "MuJoCo" },
  { id: "rapier", label: "Rapier" },
  { id: "ammo", label: "Ammo (Bullet)" },
  { id: "cannon", label: "Cannon" },
];

export function SimExperimentPanel(): React.JSX.Element {
  const workspace = useCadStore((s) => s.workspace);
  const simulating = useCadStore((s) => s.simulating);
  const exp = useCadStore((s) => s.simExperiment);
  const telemetry = useCadStore((s) => s.simTelemetry);
  const setExp = useCadStore((s) => s.setSimExperiment);
  const setWorkspace = useCadStore((s) => s.setWorkspace);
  const requestRestart = useCadStore((s) => s.requestSimRestart);
  const setPaused = useCadStore((s) => s.setSimPaused);
  const paused = useCadStore((s) => s.simPaused);
  const requestRewind = useCadStore((s) => s.requestSimRewind);

  if (workspace !== "simulate" && !simulating) {
    return (
      <div data-testid="sim-experiment-panel" className="space-y-2 text-xs text-[#9ab]">
        <h2 className="text-xs font-bold tracking-wide text-[#8aa]">PHYSICS EXPERIMENTS</h2>
        <p className="leading-relaxed text-[#678]">
          Run drop tests, free-fall, and ground-rest simulations directly on your
          part or assembly geometry.
        </p>
        <button
          type="button"
          data-testid="sim-open-workspace"
          onClick={() => setWorkspace("simulate")}
          className="w-full rounded border border-[#4ea1ff] bg-[#13243a] px-2 py-1.5 text-[#bfe0ff] hover:bg-[#1a3050]"
        >
          Open Simulate workspace
        </button>
      </div>
    );
  }

  const dynamicBodies = telemetry?.bodies.filter((b) => !b.fixed) ?? [];
  const groundForced = exp.kind === "drop-test" || exp.kind === "rest";
  const groundDisabled = exp.kind === "free-fall" || exp.kind === "zero-g" || groundForced;
  const groundChecked = experimentWantsGround(exp);

  return (
    <div data-testid="sim-experiment-panel" className="space-y-3 text-xs text-[#cfe]">
      <h2 className="text-xs font-bold tracking-wide text-[#8aa]">PHYSICS EXPERIMENTS</h2>
      <p className="leading-relaxed text-[#678]">{EXPERIMENT_HELP[exp.kind]}</p>

      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-[#678]">Experiment</span>
        <select
          data-testid="sim-experiment-kind"
          value={exp.kind}
          onChange={(e) => setExp({ kind: e.currentTarget.value as SimExperimentKind })}
          className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-2 py-1 text-[#cfe]"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {EXPERIMENT_LABELS[k]}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-[#678]">
          Drop height ({(exp.dropHeight * 1000).toFixed(0)} mm)
        </span>
        <input
          type="range"
          data-testid="sim-drop-height"
          min={0}
          max={0.5}
          step={0.01}
          value={exp.dropHeight}
          disabled={exp.kind === "zero-g"}
          onChange={(e) => setExp({ dropHeight: Number(e.currentTarget.value) })}
          className="w-full"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-[#678]">
          Gravity ×{exp.gravityScale.toFixed(2)}
          {exp.kind === "zero-g" ? " (forced 0)" : ""}
        </span>
        <input
          type="range"
          data-testid="sim-gravity-scale"
          min={0}
          max={2}
          step={0.02}
          value={exp.gravityScale}
          disabled={exp.kind === "zero-g"}
          onChange={(e) => setExp({ gravityScale: Number(e.currentTarget.value) })}
          className="w-full"
        />
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["Earth", 1],
              ["Moon", 0.16],
              ["Mars", 0.38],
              ["2g", 2],
            ] as const
          ).map(([label, g]) => (
            <button
              key={label}
              type="button"
              data-testid={`sim-g-${label.toLowerCase()}`}
              onClick={() =>
                setExp({
                  gravityScale: g,
                  kind: exp.kind === "zero-g" ? "drop-test" : exp.kind,
                })
              }
              className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[10px] text-[#9ab] hover:bg-[#1b2230]"
            >
              {label}
            </button>
          ))}
        </div>
      </label>

      <label className="flex items-center gap-2 text-[#9ab]">
        <input
          type="checkbox"
          data-testid="sim-ground"
          checked={groundChecked}
          disabled={groundDisabled}
          onChange={(e) => setExp({ ground: e.currentTarget.checked })}
        />
        Ground plane
        {groundForced && <span className="text-[10px] text-[#567]">(required)</span>}
        {(exp.kind === "free-fall" || exp.kind === "zero-g") && (
          <span className="text-[10px] text-[#567]">(off for this experiment)</span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-[#678]">Engine</span>
        <select
          data-testid="sim-backend"
          value={exp.backend}
          onChange={(e) => setExp({ backend: e.currentTarget.value as SimBackendChoice })}
          className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-2 py-1 text-[#cfe]"
        >
          {BACKENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-1">
        {!simulating ? (
          <button
            type="button"
            data-testid="sim-run-experiment"
            onClick={() => setWorkspace("simulate")}
            className="flex-1 rounded border border-[#4ea1ff] bg-[#13243a] px-2 py-1.5 text-[#bfe0ff] hover:bg-[#1a3050]"
          >
            Run experiment
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="sim-restart-experiment"
              onClick={() => requestRestart()}
              className="flex-1 rounded border border-[#4ea1ff] bg-[#13243a] px-2 py-1.5 text-[#bfe0ff] hover:bg-[#1a3050]"
            >
              Restart
            </button>
            <button
              type="button"
              data-testid="sim-pause-experiment"
              onClick={() => setPaused(!paused)}
              className="rounded border border-[#2a3444] px-2 py-1.5 text-[#9ab] hover:bg-[#1b2230]"
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              data-testid="sim-rewind-experiment"
              onClick={() => requestRewind()}
              className="rounded border border-[#2a3444] px-2 py-1.5 text-[#9ab] hover:bg-[#1b2230]"
            >
              Rewind
            </button>
          </>
        )}
      </div>

      {telemetry && (
        <div
          data-testid="sim-telemetry"
          className="space-y-1 rounded border border-[#2a3444] bg-black/40 p-2"
        >
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-[#678]">
            <span>Telemetry</span>
            <span className="flex items-center gap-2">
              {telemetry.settled && (
                <span
                  data-testid="sim-telemetry-settled"
                  className="rounded bg-[#1a3a28] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[#8fd9a8]"
                >
                  Settled
                </span>
              )}
              <span data-testid="sim-telemetry-time">{telemetry.time.toFixed(2)}s</span>
            </span>
          </div>
          <div className="text-[#9ab]">
            max speed{" "}
            <span data-testid="sim-telemetry-maxspeed" className="tabular-nums text-[#cfe]">
              {telemetry.maxSpeed.toFixed(2)} m/s
            </span>
          </div>
          {telemetry.minDynamicZ != null && (
            <div className="text-[#9ab]">
              lowest Z{" "}
              <span data-testid="sim-telemetry-minz" className="tabular-nums text-[#cfe]">
                {(telemetry.minDynamicZ * 1000).toFixed(1)} mm
              </span>
            </div>
          )}
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
            {dynamicBodies.map((b) => (
              <li
                key={b.id}
                data-testid={`sim-body-${b.id}`}
                className="flex justify-between gap-2 tabular-nums text-[11px]"
              >
                <span className="truncate text-[#9ab]">{b.id}</span>
                <span className="text-[#cfe]">
                  z={(b.z * 1000).toFixed(0)}mm · {b.speed.toFixed(2)} m/s
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
