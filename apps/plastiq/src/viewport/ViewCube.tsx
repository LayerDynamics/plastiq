// Clickable view cube (SPEC-5 FR-12) — the production orientation control, a DOM
// overlay pinned to the viewport's top-right corner. An isometric SVG cube whose
// three visible faces snap to the ortho views, whose three visible edges snap to
// edge views, and whose near corner snaps to the iso view. Opposite orientations
// stay reachable from the named view buttons (ViewControl). Direction maths lives
// in cubeView.ts; <ViewCube> is thin presentation that calls `onPick(axes)`, and
// <ViewCubeOverlay> is the production glue that drives the camera through the
// viewport's published setView seam — the same call the named-view buttons make.

import { useState } from "react";
import { cubeDirection, type CubeAxes } from "./cubeView.js";

const R = 24;
const CX = 36;
const CY = 36;
const HX = R * 0.866; // cos30
const HY = R * 0.5; // sin30

// Hover accent — SELECT_ORANGE (three/colors.ts), the same hue the retired drei
// cube used for its hoverColor, so the swap keeps the viewport's hover language.
const HOVER = "#ffa23a";
const FACE_FILL = "#1b2230"; // GRID_CELL
const SPOT_FILL = "#2a3850";

// Visible cube vertices in 2D (iso projection, near corner at the centre).
const topBack = [CX, CY - R] as const;
const topRight = [CX + HX, CY - HY] as const;
const topFront = [CX, CY] as const;
const topLeft = [CX - HX, CY - HY] as const;
const botFront = [CX, CY + R] as const;
const botRight = [CX + HX, CY + HY] as const;
const botLeft = [CX - HX, CY + HY] as const;

const poly = (...pts: (readonly [number, number])[]): string =>
  pts.map((p) => p.join(",")).join(" ");
const mid = (a: readonly [number, number], b: readonly [number, number]): [number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];

interface Face {
  axes: CubeAxes;
  points: string;
  label: string;
  at: readonly [number, number];
}
const FACES: Face[] = [
  {
    axes: [0, 0, 1],
    points: poly(topBack, topRight, topFront, topLeft),
    label: "T",
    at: [CX, CY - HY - 4],
  },
  {
    axes: [0, -1, 0],
    points: poly(topLeft, topFront, botFront, botLeft),
    label: "F",
    at: [CX - HX / 2, CY + HY],
  },
  {
    axes: [1, 0, 0],
    points: poly(topRight, topFront, botFront, botRight),
    label: "R",
    at: [CX + HX / 2, CY + HY],
  },
];

interface Spot {
  axes: CubeAxes;
  at: readonly [number, number];
  r: number;
}
const SPOTS: Spot[] = [
  { axes: [0, -1, 1], at: mid(topLeft, topFront), r: 4 }, // T–F edge
  { axes: [1, 0, 1], at: mid(topRight, topFront), r: 4 }, // T–R edge
  { axes: [1, -1, 0], at: mid(topFront, botFront), r: 4 }, // F–R edge
  { axes: [1, -1, 1], at: topFront, r: 5 }, // near corner → iso
];

export function ViewCube({ onPick }: { onPick: (axes: CubeAxes) => void }): React.JSX.Element {
  // Hover highlight (parity with the retired drei cube's hoverColor): the face or
  // spot under the pointer fills orange. Keyed by testid-ish identity.
  const [hot, setHot] = useState<string | null>(null);
  return (
    <svg
      data-testid="view-cube"
      width={56}
      height={56}
      viewBox="0 0 72 72"
      className="cursor-pointer"
      role="group"
      aria-label="View cube"
      // The svg box is pointer-transparent; only the painted shapes below re-enable
      // hits — so orbit/pan gestures beside the cube still reach the canvas.
      style={{ pointerEvents: "none" }}
    >
      {FACES.map((f) => (
        <g key={f.label}>
          <polygon
            data-testid={`cube-face-${f.label}`}
            points={f.points}
            fill={hot === f.label ? HOVER : FACE_FILL}
            stroke="#3a4860"
            strokeWidth={1}
            onClick={() => onPick(f.axes)}
            onMouseOver={() => setHot(f.label)}
            onMouseOut={() => setHot(null)}
            style={{ cursor: "pointer", pointerEvents: "auto" }}
          >
            <title>{`${f.label} view`}</title>
          </polygon>
          <text
            x={f.at[0]}
            y={f.at[1]}
            fill={hot === f.label ? "#0b0d12" : "#9ab"}
            fontSize={11}
            fontFamily="monospace"
            textAnchor="middle"
            dominantBaseline="middle"
            pointerEvents="none"
          >
            {f.label}
          </text>
        </g>
      ))}
      {SPOTS.map((s) => {
        const id = s.axes.join(",");
        return (
          <circle
            key={id}
            data-testid={`cube-spot-${s.axes.join("")}`}
            cx={s.at[0]}
            cy={s.at[1]}
            r={s.r}
            fill={hot === id ? HOVER : SPOT_FILL}
            stroke="#4ea1ff"
            strokeWidth={1}
            onClick={() => onPick(s.axes)}
            onMouseOver={() => setHot(id)}
            onMouseOut={() => setHot(null)}
            style={{ cursor: "pointer", pointerEvents: "auto" }}
          />
        );
      })}
    </svg>
  );
}

/** Minimal shape of the viewport global the overlay drives (see Scene.tsx). */
interface SetViewGlobal {
  __plastiqViewport?: { setView?: (dir: readonly [number, number, number]) => void };
}

/** The production view-cube overlay: <ViewCube> pinned over the canvas's
 * top-right corner (right/top 36px + the 56px cube ⇒ cube centre ≈64px from the
 * corner — the exact spot the retired drei gizmo occupied with margin [64,64]).
 * Picks orient the camera through the published `setView` seam, instantly and
 * deterministically — the same call the named-view buttons make. */
export function ViewCubeOverlay(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute right-9 top-9">
      <ViewCube
        onPick={(axes) => {
          const d = cubeDirection(axes);
          (globalThis as SetViewGlobal).__plastiqViewport?.setView?.([d.x, d.y, d.z]);
        }}
      />
    </div>
  );
}
