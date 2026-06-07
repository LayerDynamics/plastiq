// Section-view control for the ribbon's Inspect panel (FR-14): toggle a clip plane,
// pick the axis, and slide the cut position. Lifted from the old Toolbar with the
// same store calls + data-testids (section-toggle, section-axis, section-offset).

import { useCadStore } from "../../store/store.js";

export function SectionControl(): React.JSX.Element {
  const section = useCadStore((s) => s.section);
  const setSection = useCadStore((s) => s.setSection);
  const on = section != null;
  const axis = section?.axis ?? "x";
  const t = section?.t ?? 0.5;
  return (
    <div data-testid="section-control" className="flex items-center gap-1">
      <button
        type="button"
        data-testid="section-toggle"
        aria-pressed={on}
        onClick={() => setSection(on ? null : { axis: "x", t: 0.5 })}
        className={`rounded border px-2 py-1 text-xs ${
          on
            ? "border-[#4ea1ff] bg-[#13243a] text-[#bfe0ff]"
            : "border-[#2a3444] text-[#9ab] hover:bg-[#1b2230]"
        }`}
        title="Section view: clip the model with a plane to see inside"
      >
        ⌗ Section
      </button>
      {on && (
        <>
          <select
            data-testid="section-axis"
            value={axis}
            onChange={(e) => setSection({ axis: e.currentTarget.value as "x" | "y" | "z", t })}
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[11px] text-[#cfe]"
            title="Cut axis"
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
          <input
            type="range"
            data-testid="section-offset"
            min={0}
            max={1}
            step={0.01}
            value={t}
            onChange={(e) => setSection({ axis, t: Number(e.currentTarget.value) })}
            className="w-20"
            title="Cut position"
          />
        </>
      )}
    </div>
  );
}
