// Clickable view cube (SPEC-5 FR-12). An isometric SVG cube whose three visible
// faces snap to the ortho views, whose three visible edges snap to edge views,
// and whose near corner snaps to the iso view. Opposite orientations stay
// reachable from the named view buttons. Direction maths lives in cubeView.ts;
// this is thin presentation that calls `onPick(axes)`.

import type { CubeAxes } from "./cubeView.js";

const R = 24;
const CX = 36;
const CY = 36;
const HX = R * 0.866; // cos30
const HY = R * 0.5; // sin30

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
  return (
    <svg
      data-testid="view-cube"
      width={56}
      height={56}
      viewBox="0 0 72 72"
      className="cursor-pointer"
      role="group"
      aria-label="View cube"
    >
      {FACES.map((f) => (
        <g key={f.label}>
          <polygon
            data-testid={`cube-face-${f.label}`}
            points={f.points}
            fill="#1b2230"
            stroke="#3a4860"
            strokeWidth={1}
            onClick={() => onPick(f.axes)}
            style={{ cursor: "pointer" }}
          >
            <title>{`${f.label} view`}</title>
          </polygon>
          <text
            x={f.at[0]}
            y={f.at[1]}
            fill="#9ab"
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
      {SPOTS.map((s) => (
        <circle
          key={s.axes.join(",")}
          data-testid={`cube-spot-${s.axes.join("")}`}
          cx={s.at[0]}
          cy={s.at[1]}
          r={s.r}
          fill="#2a3850"
          stroke="#4ea1ff"
          strokeWidth={1}
          onClick={() => onPick(s.axes)}
          style={{ cursor: "pointer" }}
        />
      ))}
    </svg>
  );
}
