// Construction-geometry gizmo: the active sketch's construction entities (lines &
// circles flagged `construction`) drawn as dashed 3D reference geometry ON the
// sketch plane, so they read in the 3D scene too — not just the 2D overlay.
// Datum sketches for now; face-plane sketches are a follow-up (their frame is
// resolved in the worker). Arc/spline construction = follow-up.

import { useMemo } from "react";
import { Line } from "@react-three/drei";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import { ACCENT_BLUE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";

type P3 = [number, number, number];

export function ConstructionGeometryGizmo(): React.JSX.Element | null {
  const active = useSketchStore((s) => s.active);
  const onFace = useSketchStore((s) => s.model.face != null);
  const plane = useSketchStore((s) => s.model.plane);
  const offset = useSketchStore((s) => s.model.offset ?? 0);
  const model = useSketchStore((s) => s.model);

  const polylines = useMemo<P3[][]>(() => {
    if (!active || onFace) return [];
    const dp = resolveDatumPlane(plane, offset);
    const [ox, oy, oz] = dp.origin;
    const [xx, xy, xz] = dp.xAxis;
    const [nx, ny, nz] = dp.normal;
    // in-plane Y = normal × xAxis
    const yx = ny * xz - nz * xy;
    const yy = nz * xx - nx * xz;
    const yz = nx * xy - ny * xx;
    const to3 = (u: number, v: number): P3 => [
      ox + xx * u + yx * v,
      oy + xy * u + yy * v,
      oz + xz * u + yz * v,
    ];
    const pt = (id: string): { u: number; v: number } | undefined =>
      model.points.find((p) => p.id === id);
    const out: P3[][] = [];
    for (const e of model.entities) {
      if (!e.construction) continue;
      if (e.kind === "line") {
        const a = pt(e.a);
        const b = pt(e.b);
        if (a && b) out.push([to3(a.u, a.v), to3(b.u, b.v)]);
      } else if (e.kind === "circle") {
        const c = pt(e.center);
        if (c) {
          const ring: P3[] = [];
          const N = 48;
          for (let i = 0; i <= N; i++) {
            const t = (i / N) * Math.PI * 2;
            ring.push(to3(c.u + e.radius * Math.cos(t), c.v + e.radius * Math.sin(t)));
          }
          out.push(ring);
        }
      }
    }
    return out;
  }, [active, onFace, plane, offset, model]);

  useGizmoPresence("constructionGeometry", polylines.length > 0);
  if (polylines.length === 0) return null;
  return (
    <>
      {polylines.map((points, i) => (
        <Line
          key={i}
          points={points}
          color={ACCENT_BLUE}
          lineWidth={1}
          dashed
          dashSize={0.003}
          gapSize={0.002}
          transparent
          opacity={0.7}
        />
      ))}
    </>
  );
}
