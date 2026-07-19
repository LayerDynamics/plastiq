// The sketch launcher widget for the ribbon's Create panel: choose a datum plane +
// offset and open the sketcher, or sketch on the selected face. Lifted from the old
// Toolbar FeatureMenu with identical store calls + data-testids (sketch-plane,
// sketch-offset, enter-sketch, sketch-on-face) so the E2E suite keeps targeting it.

import { useState } from "react";
import { useCadStore } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { emptySketch, type DatumPlaneId, type SketchModel } from "../../sketch/model.js";
import { startingSketchModel } from "../../sketch/defaultPlane.js";

export function SketchLauncher(): React.JSX.Element {
  const enterSketch = useSketchStore((s) => s.enterSketch);
  const solverReady = useSketchStore((s) => s.solverReady);
  const [plane, setPlane] = useState<DatumPlaneId>("XY");
  const [offsetMm, setOffsetMm] = useState("0");
  const picks = useCadStore((s) => s.picks);
  const selectionRefs = useCadStore((s) => s.selectionRefs);
  const faceRef =
    picks.length === 1 && picks[0]?.kind === "face" ? selectionRefs.faces[picks[0].id] : undefined;

  const sketchOnFace = (): void => {
    if (!faceRef) return;
    const offset = (Number(offsetMm) || 0) / 1000;
    const model: SketchModel = { ...emptySketch("XY", offset), face: faceRef };
    enterSketch("XY", offset, undefined, model);
  };

  const btn = "rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#1b2230]";
  const btnDisabled = "rounded px-1.5 py-0.5 text-xs text-[#445] cursor-not-allowed";
  return (
    <div className="flex items-center gap-0.5">
      <select
        data-testid="sketch-plane"
        value={plane}
        onChange={(e) => setPlane(e.currentTarget.value as DatumPlaneId)}
        title="Plane the new sketch is drawn on"
        className="rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[11px] text-[#cfe]"
      >
        <option value="XY">XY</option>
        <option value="XZ">XZ</option>
        <option value="YZ">YZ</option>
      </select>
      <input
        type="number"
        step="any"
        data-testid="sketch-offset"
        value={offsetMm}
        onChange={(e) => setOffsetMm(e.currentTarget.value)}
        title="Offset along the plane normal (mm)"
        className="w-12 rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-right text-[11px] text-[#cfe]"
      />
      <button
        type="button"
        data-testid="enter-sketch"
        disabled={!solverReady}
        className={solverReady ? btn : btnDisabled}
        title={solverReady ? `Open the 2D sketch editor on the ${plane} plane` : "Loading sketch solver…"}
        onClick={() => {
          // Offset 0 = "wherever makes sense on this orientation": land on the
          // model's outer face along the datum normal rather than a plane that
          // may be buried inside the body (§13.8 P0). A TYPED offset is an exact
          // instruction and is honoured against the bare datum.
          const offset = (Number(offsetMm) || 0) / 1000;
          enterSketch(plane, offset, undefined, startingSketchModel(plane, selectionRefs.faces, offset));
        }}
      >
        New Sketch
      </button>
      <button
        type="button"
        data-testid="sketch-on-face"
        disabled={!solverReady || !faceRef}
        className={solverReady && faceRef ? btn : btnDisabled}
        title={
          !solverReady
            ? "Loading sketch solver…"
            : faceRef
              ? "Sketch on the selected face (offset along its normal)"
              : "Select a single face first"
        }
        onClick={sketchOnFace}
      >
        On Face
      </button>
    </div>
  );
}
