// Section analysis control (FR-14 / Fusion-style): toggle, axis, offset slider,
// flip kept half-space, and "from face" when a face is selected.

import { useCadStore } from "../../store/store.js";
import { isAxisSection, type SectionAnalysis } from "../../viewport/section.js";

export function SectionControl(): React.JSX.Element {
  const section = useCadStore((s) => s.section);
  const setSection = useCadStore((s) => s.setSection);
  const picks = useCadStore((s) => s.picks);
  const refs = useCadStore((s) => s.selectionRefs);
  const on = section != null;
  const axis = isAxisSection(section) ? section.axis : "x";
  const t = isAxisSection(section) ? section.t : 0.5;
  const flip = section?.flip === true;
  const facePick = picks.find((p) => p.kind === "face");
  const faceRef = facePick ? refs.faces[facePick.id] : undefined;

  const setAxisSection = (next: { axis: "x" | "y" | "z"; t: number; flip?: boolean }): void => {
    setSection({ kind: "axis", ...next });
  };

  return (
    <div data-testid="section-control" className="flex items-center gap-1">
      <button
        type="button"
        data-testid="section-toggle"
        aria-pressed={on}
        onClick={() => setSection(on ? null : { kind: "axis", axis: "x", t: 0.5, flip: false })}
        className={`rounded border px-2 py-1 text-xs ${
          on
            ? "border-[#4ea1ff] bg-[#13243a] text-[#bfe0ff]"
            : "border-[#2a3444] text-[#9ab] hover:bg-[#1b2230]"
        }`}
        title="Section analysis: cut the model with a plane to see inside (Fusion-style)"
      >
        ⌗ Section
      </button>
      {on && (
        <>
          {isAxisSection(section) && (
            <>
              <select
                data-testid="section-axis"
                value={axis}
                onChange={(e) =>
                  setAxisSection({
                    axis: e.currentTarget.value as "x" | "y" | "z",
                    t,
                    flip,
                  })
                }
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
                onChange={(e) =>
                  setAxisSection({ axis, t: Number(e.currentTarget.value), flip })
                }
                className="w-20"
                title="Cut position"
              />
            </>
          )}
          {section?.kind === "plane" && (
            <span className="text-[10px] text-[#9ab]" data-testid="section-plane-label">
              Face plane
            </span>
          )}
          <button
            type="button"
            data-testid="section-flip"
            aria-pressed={flip}
            onClick={() => {
              if (!section) return;
              setSection({ ...section, flip: !flip } as SectionAnalysis);
            }}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              flip
                ? "border-[#4ea1ff] bg-[#13243a] text-[#bfe0ff]"
                : "border-[#2a3444] text-[#9ab] hover:bg-[#1b2230]"
            }`}
            title="Flip which side of the cut is kept (Fusion)"
          >
            ⇄ Flip
          </button>
          <button
            type="button"
            data-testid="section-from-face"
            disabled={!faceRef}
            onClick={() => {
              if (!faceRef) return;
              // Face centroid is optional on FaceRef; fall back to origin if absent.
              const origin = (faceRef as { centroid?: [number, number, number] }).centroid ?? [
                0, 0, 0,
              ];
              setSection({
                kind: "plane",
                origin,
                normal: faceRef.normal as [number, number, number],
                offset: 0,
                flip: false,
              });
            }}
            className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] text-[#9ab] enabled:hover:bg-[#1b2230] disabled:opacity-40"
            title={
              faceRef
                ? "Cut on the selected face (Fusion: pick a plane/face)"
                : "Select a face first"
            }
          >
            From face
          </button>
        </>
      )}
    </div>
  );
}
