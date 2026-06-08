// Named standard views for the sidebar's Inspect panel (FR-12). The in-canvas 3D
// view cube (viewCube.gizmo) is the primary click-to-orient control; these buttons
// reach every named view explicitly (incl. the back/bottom faces the cube hides),
// without floating a panel over the cube. Each drives the camera via the viewport's
// published setView seam — the same call the cube faces make.

import { standardViewDirection, type StandardView } from "../../viewport/views.js";

const VIEWS: StandardView[] = ["top", "bottom", "front", "back", "right", "left", "iso"];

export function ViewControl(): React.JSX.Element {
  return (
    <div data-testid="named-views" className="flex flex-wrap gap-1">
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => {
            const d = standardViewDirection(v);
            (
              globalThis as { __plastiqViewport?: { setView?: (dir: [number, number, number]) => void } }
            ).__plastiqViewport?.setView?.([d.x, d.y, d.z]);
          }}
          title={`${v} view`}
          className="rounded border border-[#2a3444] px-1.5 py-0.5 text-[11px] capitalize text-[#9ab] hover:bg-[#1b2230] hover:text-[#cfe]"
        >
          {v}
        </button>
      ))}
    </div>
  );
}
