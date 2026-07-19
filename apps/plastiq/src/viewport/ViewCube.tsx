// Clickable view cube (SPEC-5 FR-12) — the production orientation control, a DOM
// overlay pinned to the viewport's top-right corner.
//
// It ROTATES WITH THE CAMERA: the cube's eight corners are projected through the
// live camera orientation every time it changes, the three faces pointing at the
// viewer are drawn (painter's order, nearest last), and their labels tell you
// which way you are looking. The previous cube was a fixed isometric drawing —
// it could set a view but never showed one, so it read as "iso" no matter where
// the camera actually was.
//
// Picking still snaps the camera: a face gives a one-axis direction, an edge two,
// a corner three (cubeView.ts), applied through the viewport's published setView
// seam — the same call the named-view buttons make. Because the drawing follows
// the camera, every one of the 26 canonical orientations is reachable by orbiting
// round and clicking what you can see, instead of only the three faces, three
// edges and one corner a static drawing could ever show.

import { useMemo, useState } from "react";
import {
  cubeBasis,
  projectCubePoint,
  useCameraOrientation,
  DEFAULT_VIEW_QUAT,
  type Quat,
  type Vec3,
} from "./cameraOrientation.js";
import { cubeDirection, type CubeAxes } from "./cubeView.js";

const SIZE = 72; // SVG viewBox (the element renders at 56px)
const C = SIZE / 2;
const S = 18; // half-edge in SVG units: a corner reaches ±S·√3 ≈ 31 < 36

// Hover accent — SELECT_ORANGE (three/colors.ts), the same hue the retired drei
// cube used for its hoverColor, so the swap keeps the viewport's hover language.
const HOVER = "#ffa23a";
const FACE_FILL = "#1b2230"; // GRID_CELL
const SPOT_FILL = "#2a3850";

/** The six face normals, with the label shown when that face points at you. */
const FACES: { axes: CubeAxes; label: string }[] = [
  { axes: [0, 0, 1], label: "T" },
  { axes: [0, 0, -1], label: "Bo" },
  { axes: [0, 1, 0], label: "Bk" },
  { axes: [0, -1, 0], label: "F" },
  { axes: [1, 0, 0], label: "R" },
  { axes: [-1, 0, 0], label: "L" },
];

/** The four corners of a face, in order, given its normal. */
function faceCorners(axes: CubeAxes): Vec3[] {
  const [ax, ay, az] = axes;
  // Two in-plane axes, chosen so the winding is consistent.
  const u: Vec3 = az !== 0 ? [1, 0, 0] : [0, 0, 1];
  const v: Vec3 = az !== 0 ? [0, 1, 0] : ax !== 0 ? [0, 1, 0] : [1, 0, 0];
  const n: Vec3 = [ax, ay, az];
  const add = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  return [
    add(add(n, u, -1), v, -1),
    add(add(n, u, 1), v, -1),
    add(add(n, u, 1), v, 1),
    add(add(n, u, -1), v, 1),
  ];
}

/** Every edge (2 non-zero axes) and corner (3), for the snap targets. */
const SPOTS: CubeAxes[] = (() => {
  const out: CubeAxes[] = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        const n = [x, y, z].filter((c) => c !== 0).length;
        if (n === 2 || n === 3) out.push([x, y, z]);
      }
    }
  }
  return out;
})();

/**
 * The cube as it looks from `quat`: the visible faces (far to near, so nearer
 * ones paint over their neighbours) and the visible edge/corner targets.
 *
 * A face is visible when its normal points toward the viewer. Edges and corners
 * use the same test on their (normalised) direction, with a small positive
 * threshold so the ones exactly on the silhouette — which would be a
 * zero-thickness click target — are dropped rather than drawn on top of each
 * other at the rim.
 */
export function cubeProjection(quat: Quat): {
  faces: { axes: CubeAxes; label: string; points: string; at: [number, number]; depth: number }[];
  spots: { axes: CubeAxes; at: [number, number]; r: number; depth: number }[];
} {
  const basis = cubeBasis(quat);
  const project = (p: Vec3): { x: number; y: number; depth: number } =>
    projectCubePoint(basis, p, C, S);

  const faces = FACES.map(({ axes, label }) => {
    const centre = project(axes);
    const pts = faceCorners(axes).map(project);
    return {
      axes,
      label,
      points: pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "),
      at: [centre.x, centre.y] as [number, number],
      depth: centre.depth,
    };
  })
    .filter((f) => f.depth > 0.001)
    .sort((a, b) => a.depth - b.depth);

  const spots = SPOTS.map((axes) => {
    const len = Math.hypot(axes[0], axes[1], axes[2]);
    const p = project(axes);
    const n = axes.filter((c) => c !== 0).length;
    return { axes, at: [p.x, p.y] as [number, number], r: n === 3 ? 5 : 4, depth: p.depth / len };
  })
    .filter((s) => s.depth > 0.2)
    .sort((a, b) => a.depth - b.depth);

  return { faces, spots };
}

export function ViewCube({
  onPick,
  quat,
}: {
  onPick: (axes: CubeAxes) => void;
  /** Camera orientation; omit to draw the viewport's default view (no camera yet). */
  quat?: Quat;
}): React.JSX.Element {
  const [hot, setHot] = useState<string | null>(null);
  const { faces, spots } = useMemo(() => cubeProjection(quat ?? DEFAULT_VIEW_QUAT), [quat]);
  return (
    <svg
      data-testid="view-cube"
      width={56}
      height={56}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="cursor-pointer"
      role="group"
      aria-label="View cube"
      // The svg box is pointer-transparent; only the painted shapes below re-enable
      // hits — so orbit/pan gestures beside the cube still reach the canvas.
      style={{ pointerEvents: "none" }}
    >
      {faces.map((f) => (
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
      {spots.map((s) => {
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
 * It follows the live camera, and picks orient the camera through the published
 * `setView` seam — the same call the named-view buttons make. */
export function ViewCubeOverlay(): React.JSX.Element {
  const quat = useCameraOrientation((s) => s.quat);
  return (
    <div className="pointer-events-none absolute right-9 top-9">
      <ViewCube
        quat={quat}
        onPick={(axes) => {
          const d = cubeDirection(axes);
          (globalThis as SetViewGlobal).__plastiqViewport?.setView?.([d.x, d.y, d.z]);
        }}
      />
    </div>
  );
}
