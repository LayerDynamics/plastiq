// Assembly tree (SPEC-5 FR-33): the component instances of this part alongside
// the feature tree. Each row toggles the instance's fixed/ground state, shows a
// mate count, and can be removed. Insert adds an occurrence; mates (M4.2) and
// joints (M4.3) attach between instances.

import { useState } from "react";
import { useCadStore } from "../store/store.js";
import type { AssemblyMate } from "../assembly/model.js";
import type { JointKind } from "@plastiq/cad";

// Mates applied straight from two picks (no scalar).
const VALUELESS_MATES: AssemblyMate["kind"][] = [
  "coincident",
  "concentric",
  "parallel",
  "perpendicular",
];
// distance/angle mates also take a scalar, entered in mm / degrees in the UI and
// stored in SI (metres / radians) to match the kernel mate solver.
const MM_PER_M = 1000;
const DEG_PER_RAD = 180 / Math.PI;

/** Inline editor for a distance/angle mate's scalar. Shows the value in display
 * units (mm / °) and commits the SI value on blur/Enter, re-solving the assembly.
 * Keyed by the stored value upstream so undo/redo resets the field. */
function MateValueInput({
  mate,
  onCommit,
}: {
  mate: Extract<AssemblyMate, { value: number }>;
  onCommit: (si: number) => void;
}): React.JSX.Element {
  const factor = mate.kind === "distance" ? MM_PER_M : DEG_PER_RAD;
  const [text, setText] = useState((mate.value * factor).toFixed(1));
  const commit = (): void => {
    // Treat empty/whitespace-only input as "revert" instead of 0
    if (text.trim() === "") {
      setText((mate.value * factor).toFixed(1));
      return;
    }

    const n = Number(text);
    if (Number.isFinite(n)) onCommit(n / factor);
    else setText((mate.value * factor).toFixed(1)); // reject non-numeric input
  };
  return (
    <input
      type="number"
      data-testid="mate-value"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      title={mate.kind === "distance" ? "Distance (mm)" : "Angle (degrees)"}
      className="w-14 rounded border border-[#2a3444] bg-[#0e131b] px-1 text-right text-[11px] text-[#cfe]"
    />
  );
}

/** Mate authoring (FR-34): toggle pick mode, pick two instance faces, apply a
 * mate; the kernel solver re-poses and the verdict/DOF surface here. */
function MatesSection(): React.JSX.Element {
  const mates = useCadStore((s) => s.assembly.mates);
  const mateMode = useCadStore((s) => s.mateMode);
  const matePicks = useCadStore((s) => s.matePicks);
  const result = useCadStore((s) => s.assemblyResult);
  const setMateMode = useCadStore((s) => s.setMateMode);
  const applyMate = useCadStore((s) => s.applyMate);
  const setMateValue = useCadStore((s) => s.setMateValue);
  const removeMate = useCadStore((s) => s.removeMate);
  const ready = matePicks.length === 2;
  // Creation-time scalars for the valued mates (display units: mm / degrees).
  const [distMm, setDistMm] = useState("25");
  const [angleDeg, setAngleDeg] = useState("90");

  return (
    <div data-testid="mates-section" className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-bold tracking-wide text-[#789]">MATES</h3>
        <button
          type="button"
          data-testid="mate-mode"
          aria-pressed={mateMode}
          onClick={() => setMateMode(!mateMode)}
          className={`rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] ${mateMode ? "bg-[#4ea1ff] text-black" : "text-[#9ab] hover:bg-[#1b2230]"}`}
          title="Pick two instance faces, then choose a mate"
        >
          {mateMode ? `Picking ${matePicks.length}/2` : "Add mate"}
        </button>
      </div>
      {mateMode && (
        <div className="mb-1 space-y-1">
          <div className="flex flex-wrap gap-1">
            {VALUELESS_MATES.map((kind) => (
              <button
                key={kind}
                type="button"
                data-testid={`mate-${kind}`}
                disabled={!ready}
                onClick={() => applyMate(kind)}
                className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] capitalize enabled:hover:bg-[#1b2230] disabled:opacity-30"
              >
                {kind}
              </button>
            ))}
          </div>
          {/* distance + angle take a scalar (mm / °), converted to SI on apply. */}
          <div className="flex flex-wrap items-center gap-1">
            <input
              type="number"
              data-testid="mate-distance-value"
              value={distMm}
              onChange={(e) => setDistMm(e.target.value)}
              title="Distance (mm)"
              className="w-14 rounded border border-[#2a3444] bg-[#0e131b] px-1 text-right text-[11px] text-[#cfe]"
            />
            <button
              type="button"
              data-testid="mate-distance"
              disabled={
                !ready ||
                distMm.trim() === "" ||
                !Number.isFinite(Number(distMm))
              }
              onClick={() => applyMate("distance", Number(distMm) / MM_PER_M)}
              className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] enabled:hover:bg-[#1b2230] disabled:opacity-30"
            >
              distance
            </button>
            <input
              type="number"
              data-testid="mate-angle-value"
              value={angleDeg}
              onChange={(e) => setAngleDeg(e.target.value)}
              title="Angle (degrees)"
              className="w-14 rounded border border-[#2a3444] bg-[#0e131b] px-1 text-right text-[11px] text-[#cfe]"
            />
            <button
              type="button"
              data-testid="mate-angle"
              disabled={!ready || !Number.isFinite(Number(angleDeg))}
              onClick={() => applyMate("angle", Number(angleDeg) / DEG_PER_RAD)}
              className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] enabled:hover:bg-[#1b2230] disabled:opacity-30"
            >
              angle
            </button>
          </div>
        </div>
      )}
      {result && (
        <div data-testid="assembly-verdict" className="mb-1 text-[10px] text-[#789]">
          {result.verdict.replace("-", " ")} · DOF {result.freedom}
        </div>
      )}
      {mates.length > 0 && (
        <ul className="space-y-0.5">
          {mates.map((m) => (
            <li
              key={m.id}
              data-testid="mate-row"
              className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#151b25]"
            >
              <span className="flex-1 capitalize">{m.kind}</span>
              {(m.kind === "distance" || m.kind === "angle") && (
                <>
                  <MateValueInput
                    key={`${m.id}:${m.value}`}
                    mate={m}
                    onCommit={(si) => setMateValue(m.id, si)}
                  />
                  <span className="text-[10px] text-[#789]">
                    {m.kind === "distance" ? "mm" : "°"}
                  </span>
                </>
              )}
              <button
                type="button"
                title="Remove mate"
                onClick={() => removeMate(m.id)}
                className="invisible rounded px-1 text-[#789] hover:text-[#ff6b6b] group-hover:visible"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const JOINT_KINDS: JointKind[] = ["revolute", "prismatic", "cylindrical", "fixed"];
const DEG = 180 / Math.PI;

/** Joints (FR-35) + motion preview (FR-36). Create from two picked instance
 * faces (parent → child); a per-joint slider drives the kinematics live. */
function JointsSection(): React.JSX.Element {
  const joints = useCadStore((s) => s.assembly.joints);
  const matePicks = useCadStore((s) => s.matePicks);
  const mateMode = useCadStore((s) => s.mateMode);
  const jointDrive = useCadStore((s) => s.jointDrive);
  const applyJoint = useCadStore((s) => s.applyJoint);
  const removeJoint = useCadStore((s) => s.removeJoint);
  const setJointDrive = useCadStore((s) => s.setJointDrive);
  const [kind, setKind] = useState<JointKind>("revolute");
  const ready = mateMode && matePicks.length === 2;

  /** Slider range + units for a joint kind (angular vs linear). */
  const driveable = (k: JointKind): boolean =>
    k === "revolute" || k === "prismatic" || k === "cylindrical";

  return (
    <div data-testid="joints-section" className="mt-2">
      <div className="mb-1 flex items-center gap-1">
        <h3 className="flex-1 text-[11px] font-bold tracking-wide text-[#789]">JOINTS</h3>
        <select
          data-testid="joint-kind"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as JointKind)}
          className="rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[11px] text-[#cfe]"
        >
          {JOINT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="add-joint"
          disabled={!ready}
          onClick={() => applyJoint(kind)}
          className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] text-[#9ab] enabled:hover:bg-[#1b2230] disabled:opacity-30"
          title="Pick two instance faces (Add mate mode), then add a joint"
        >
          Add
        </button>
      </div>
      {joints.length === 0 ? (
        <p className="px-1 text-[10px] opacity-60">Pick two faces, choose a kind, Add.</p>
      ) : (
        <ul className="space-y-1">
          {joints.map((j) => {
            const angular = j.kind === "revolute" || j.kind === "cylindrical";
            const v = jointDrive[j.id] ?? 0;
            return (
              <li
                key={j.id}
                data-testid="joint-row"
                className="group rounded px-1.5 py-0.5 text-xs text-[#9ab]"
              >
                <div className="flex items-center gap-1">
                  <span className="flex-1 capitalize">{j.kind}</span>
                  <span className="text-[10px] text-[#678]">
                    {angular ? `${(v * DEG).toFixed(0)}°` : `${(v * 1000).toFixed(0)}mm`}
                  </span>
                  <button
                    type="button"
                    title="Remove joint"
                    onClick={() => removeJoint(j.id)}
                    className="invisible rounded px-1 text-[#789] hover:text-[#ff6b6b] group-hover:visible"
                  >
                    ✕
                  </button>
                </div>
                {driveable(j.kind) && (
                  <input
                    type="range"
                    data-testid="joint-drive"
                    min={angular ? -Math.PI : -0.1}
                    max={angular ? Math.PI : 0.1}
                    step={angular ? 0.01 : 0.001}
                    value={v}
                    onChange={(e) => setJointDrive(j.id, Number(e.currentTarget.value))}
                    className="w-full"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function AssemblyTree(): React.JSX.Element {
  const instances = useCadStore((s) => s.assembly.instances);
  const mates = useCadStore((s) => s.assembly.mates);
  const addInstance = useCadStore((s) => s.addInstance);
  const removeInstance = useCadStore((s) => s.removeInstance);
  const toggleInstanceFixed = useCadStore((s) => s.toggleInstanceFixed);

  const mateCountFor = (id: string): number =>
    mates.filter((m) => m.a.instance === id || m.b.instance === id).length;

  return (
    <div data-testid="assembly-tree">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-wide text-[#8aa]">ASSEMBLY</h2>
        <button
          type="button"
          data-testid="insert-instance"
          onClick={() => addInstance()}
          className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] text-[#9ab] hover:bg-[#1b2230]"
          title="Insert a component instance of this part"
        >
          + Insert
        </button>
      </div>
      {instances.length === 0 ? (
        <p className="px-1 text-[11px] opacity-60">No instances. Insert to start an assembly.</p>
      ) : (
        <ul className="space-y-0.5">
          {instances.map((inst) => (
            <li
              key={inst.id}
              data-testid="instance-row"
              data-instance-id={inst.id}
              className="group flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-[#9ab] hover:bg-[#151b25]"
            >
              <span className="w-4 text-center text-[#67809a]" aria-hidden>
                ▣
              </span>
              <span className="flex-1 truncate" title={inst.id}>
                {inst.name}
              </span>
              {mateCountFor(inst.id) > 0 && (
                <span className="text-[10px] text-[#678]">{mateCountFor(inst.id)}⛓</span>
              )}
              <button
                type="button"
                title={inst.fixed ? "Unfix (ground)" : "Fix (ground)"}
                aria-pressed={inst.fixed}
                onClick={() => toggleInstanceFixed(inst.id)}
                className={`rounded px-1 text-xs ${inst.fixed ? "text-[#ff8a3a]" : "invisible text-[#789] hover:text-[#cfe] group-hover:visible"}`}
              >
                ⚓
              </button>
              <button
                type="button"
                title="Remove instance"
                onClick={() => removeInstance(inst.id)}
                className="invisible rounded px-1 text-xs text-[#789] hover:text-[#ff6b6b] group-hover:visible"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {instances.length >= 2 && <MatesSection />}
      {instances.length >= 2 && <JointsSection />}
      {instances.length >= 1 && <ExportToSim />}
    </div>
  );
}

/** Lower the assembly to a SimManifest and download it (M4.5). Each instance
 * becomes a sim body; revolute/fixed joints become constraints. */
function ExportToSim(): React.JSX.Element {
  const setStatus = useCadStore((s) => s.setStatus);
  const onExport = async (): Promise<void> => {
    const lower = (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower;
    if (!lower) return;
    try {
      const out = (await lower()) as { manifest: unknown; skippedJoints: string[] };
      const blob = new Blob([JSON.stringify(out.manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "assembly.simmanifest.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
      setStatus(
        out.skippedJoints.length > 0
          ? `exported (skipped ${out.skippedJoints.length} non-lowerable joint(s))`
          : "exported sim manifest",
      );
    } catch (e) {
      setStatus(`export failed: ${(e as Error).message}`);
    }
  };
  return (
    <button
      type="button"
      data-testid="export-sim"
      onClick={() => void onExport()}
      className="mt-2 w-full rounded border border-[#3a6b3a] bg-[#1c2a14] px-2 py-1 text-[11px] text-[#cfe6a0] hover:bg-[#24341a]"
      title="Lower the assembly to a physics sim manifest"
    >
      ⤓ Export to Sim
    </button>
  );
}
