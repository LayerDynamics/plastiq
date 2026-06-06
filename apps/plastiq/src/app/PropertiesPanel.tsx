// Right-hand properties panel (SPEC-5 FR-4/FR-23). Shows the selected feature's
// editable numeric parameters and the body-placement pose (FR-11). Editing a
// value commits it to the store (one undo step, one rebuild) on blur/Enter — not
// per keystroke — and downstream features rebuild deterministically.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE } from "../store/types.js";
import { findPlacement, placementFromFeature } from "../viewport/placement.js";

const M_PER_MM = 0.001;
const DEG_PER_RAD = 180 / Math.PI;

/** A numeric input that holds a local draft and commits on blur / Enter. */
function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  // Re-sync when the store value changes from elsewhere (gizmo, undo).
  useEffect(() => setDraft(formatNum(value)), [value]);

  const commit = (): void => {
    const v = Number(draft);
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(formatNum(value));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
      <span className="w-6 text-[#789]">{label}</span>
      <input
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(formatNum(value));
        }}
        className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right text-[#cfe] outline-none focus:border-[#4ea1ff]"
      />
    </label>
  );
}

function formatNum(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(6))) : "0";
}

function PlacementEditor(): React.JSX.Element {
  const features = useCadStore((s) => s.features);
  const upsertPlacement = useCadStore((s) => s.upsertPlacement);
  const p = placementFromFeature(findPlacement(features));

  const setT = (axis: "tx" | "ty" | "tz", mm: number): void =>
    upsertPlacement({ [axis]: mm * M_PER_MM });
  const setR = (axis: "rx" | "ry" | "rz", deg: number): void =>
    upsertPlacement({ [axis]: deg / DEG_PER_RAD });

  return (
    <section data-testid="placement-editor">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">PLACEMENT</h3>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[#567]">Translate (mm)</div>
      <div className="space-y-1">
        <NumberField label="X" value={p.tx / M_PER_MM} onCommit={(v) => setT("tx", v)} />
        <NumberField label="Y" value={p.ty / M_PER_MM} onCommit={(v) => setT("ty", v)} />
        <NumberField label="Z" value={p.tz / M_PER_MM} onCommit={(v) => setT("tz", v)} />
      </div>
      <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-[#567]">Rotate (°)</div>
      <div className="space-y-1">
        <NumberField label="X" value={p.rx * DEG_PER_RAD} onCommit={(v) => setR("rx", v)} />
        <NumberField label="Y" value={p.ry * DEG_PER_RAD} onCommit={(v) => setR("ry", v)} />
        <NumberField label="Z" value={p.rz * DEG_PER_RAD} onCommit={(v) => setR("rz", v)} />
      </div>
    </section>
  );
}

function FeatureEditor(): React.JSX.Element | null {
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const features = useCadStore((s) => s.features);
  const updateParams = useCadStore((s) => s.updateParams);

  const feature = features.find((f) => f.id === selectedFeatureId);
  if (!feature || feature.type === PLACEMENT_TYPE) return null;
  const entries = Object.entries(feature.params ?? {});

  return (
    <section data-testid="feature-editor">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">
        {(feature.name ?? feature.id).toUpperCase()}
        <span className="ml-1 font-normal text-[#567]">({feature.type})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="text-[11px] opacity-60">No editable parameters.</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, val]) => (
            <NumberField
              key={key}
              label={key}
              value={val}
              onCommit={(v) => updateParams(feature.id, { [key]: v })}
            />
          ))}
          <p className="pt-1 text-[10px] text-[#567]">values in SI (metres / radians)</p>
        </div>
      )}
    </section>
  );
}

export function PropertiesPanel(): React.JSX.Element {
  return (
    <div data-testid="properties" className="space-y-4 text-sm text-[#9ab]">
      <FeatureEditor />
      <PlacementEditor />
    </div>
  );
}
