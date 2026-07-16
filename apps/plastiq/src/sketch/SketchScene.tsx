// In-place 3D sketch geometry (ADR-0014): plane grid, axes, points, and curves
// rendered as R3F scene objects on the active DatumPlane. Drawing input is
// owned by SketchPlanePick (ray ∩ plane → UV); this component is display + pick
// surface only.

import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { DatumPlane } from "@plastiq/cad";
import { useSketchStore } from "./sketchStore.js";
import {
  arcWorld,
  circleWorld,
  uvToWorld,
  worldToUv,
  type UV,
  type Vec3,
} from "./worldMap.js";

type P3 = [number, number, number];

const GRID_EXTENT = 0.12; // ± metres
const GRID_STEP = 0.01;

function asP3(v: Vec3): P3 {
  return [v[0], v[1], v[2]];
}

/** Invisible plane mesh that captures left-clicks for sketch tools (ray → UV). */
function SketchPlanePick({ plane }: { plane: DatumPlane }): React.JSX.Element {
  const { camera, gl } = useThree();
  const tool = useSketchStore((s) => s.tool);
  const model = useSketchStore((s) => s.model);
  const clickAt = useSketchStore((s) => s.clickAt);
  const movePoint = useSketchStore((s) => s.movePoint);
  const setSelection = useSketchStore((s) => s.setSelection);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const selection = useSketchStore((s) => s.selection);

  const geom = useMemo(() => {
    // Large plane so free-orbit still has a pick surface.
    const g = new THREE.PlaneGeometry(4, 4);
    return g;
  }, []);

  const quat = useMemo(() => {
    // PlaneGeometry lies in local XY with normal +Z; rotate to plane.normal
    // with local X along plane.xAxis.
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const y = new THREE.Vector3().crossVectors(
      new THREE.Vector3(...plane.normal),
      new THREE.Vector3(...plane.xAxis),
    );
    // If normal×xAxis is degenerate, fall back.
    if (y.lengthSq() < 1e-12) y.set(0, 1, 0);
    else y.normalize();
    m.makeBasis(
      new THREE.Vector3(...plane.xAxis),
      y,
      new THREE.Vector3(...plane.normal),
    );
    q.setFromRotationMatrix(m);
    return q;
  }, [plane]);

  const hitUv = (e: THREE.Event & { point?: THREE.Vector3 }): UV | null => {
    const p = (e as { point?: THREE.Vector3 }).point;
    if (!p) return null;
    return worldToUv(plane, [p.x, p.y, p.z]);
  };

  return (
    <mesh
      geometry={geom}
      position={plane.origin as unknown as P3}
      quaternion={quat}
      onPointerDown={(e) => {
        // Left button only; middle/right leave for orbit / context menu.
        if (e.button !== 0) return;
        e.stopPropagation();
        const uv = hitUv(e);
        if (!uv) return;
        const [u, v] = uv;
        if (tool === "select") {
          // Nearest point within 2 mm.
          let best: { id: string; d: number } | null = null;
          for (const pt of model.points) {
            const d = Math.hypot(pt.u - u, pt.v - v);
            if (d < 0.002 && (!best || d < best.d)) best = { id: pt.id, d };
          }
          if (best) {
            if (e.shiftKey) toggleSelect(best.id);
            else setSelection([best.id]);
          } else if (!e.shiftKey) {
            setSelection([]);
          }
          return;
        }
        // Drawing tools: snap to nearby points / origin, then clickAt.
        let su = u;
        let sv = v;
        let reusePointId: string | undefined;
        let bestD = 0.002;
        if (Math.hypot(u, v) < bestD) {
          su = 0;
          sv = 0;
          bestD = Math.hypot(u, v);
        }
        for (const pt of model.points) {
          const d = Math.hypot(pt.u - u, pt.v - v);
          if (d < bestD) {
            bestD = d;
            su = pt.u;
            sv = pt.v;
            reusePointId = pt.id;
          }
        }
        // H/V inference from the last pending point (if any).
        const pending = useSketchStore.getState().pending;
        let constraint: { kind: "horizontal" | "vertical" } | undefined;
        if (pending.length > 0) {
          const last = model.points.find((p) => p.id === pending[pending.length - 1]);
          if (last) {
            const du = Math.abs(su - last.u);
            const dv = Math.abs(sv - last.v);
            if (du < 0.001 && dv > du) {
              su = last.u;
              constraint = { kind: "vertical" };
            } else if (dv < 0.001 && du > dv) {
              sv = last.v;
              constraint = { kind: "horizontal" };
            }
          }
        }
        clickAt(su, sv, { reusePointId, constraint });
      }}
      onPointerMove={(e) => {
        if (tool !== "select") return;
        // Drag selected free points (first selected).
        if (e.buttons !== 1 || selection.length === 0) return;
        const id = selection[0]!;
        const pt = model.points.find((p) => p.id === id);
        if (!pt || pt.fixed) return;
        e.stopPropagation();
        const uv = hitUv(e);
        if (!uv) return;
        movePoint(id, uv[0], uv[1]);
      }}
      // Keep camera reference used so the mesh participates in the frame.
      userData={{ sketchPick: true, cameraId: camera.uuid, canvas: gl.domElement }}
    >
      <meshBasicMaterial
        visible={false}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

function PlaneGrid({ plane }: { plane: DatumPlane }): React.JSX.Element {
  const lines = useMemo(() => {
    const out: P3[][] = [];
    for (let u = -GRID_EXTENT; u <= GRID_EXTENT + 1e-9; u += GRID_STEP) {
      out.push([
        asP3(uvToWorld(plane, u, -GRID_EXTENT)),
        asP3(uvToWorld(plane, u, GRID_EXTENT)),
      ]);
    }
    for (let v = -GRID_EXTENT; v <= GRID_EXTENT + 1e-9; v += GRID_STEP) {
      out.push([
        asP3(uvToWorld(plane, -GRID_EXTENT, v)),
        asP3(uvToWorld(plane, GRID_EXTENT, v)),
      ]);
    }
    return out;
  }, [plane]);

  const xAxis: P3[] = [
    asP3(uvToWorld(plane, -GRID_EXTENT, 0)),
    asP3(uvToWorld(plane, GRID_EXTENT, 0)),
  ];
  const yAxis: P3[] = [
    asP3(uvToWorld(plane, 0, -GRID_EXTENT)),
    asP3(uvToWorld(plane, 0, GRID_EXTENT)),
  ];
  const origin = asP3(uvToWorld(plane, 0, 0));

  return (
    <group>
      {lines.map((pts, i) => (
        <Line key={i} points={pts} color="#1b2230" lineWidth={0.5} />
      ))}
      <Line points={xAxis} color="#7a2b2b" lineWidth={1.5} />
      <Line points={yAxis} color="#2b6b3a" lineWidth={1.5} />
      <mesh position={origin}>
        <sphereGeometry args={[0.0015, 12, 12]} />
        <meshBasicMaterial color="#ffd34a" />
      </mesh>
    </group>
  );
}

function SketchEntities({ plane }: { plane: DatumPlane }): React.JSX.Element {
  const model = useSketchStore((s) => s.model);
  const selection = useSketchStore((s) => s.selection);

  const pt = (id: string): UV | null => {
    const p = model.points.find((x) => x.id === id);
    return p ? [p.u, p.v] : null;
  };

  const curves = useMemo(() => {
    const out: { id: string; pts: P3[]; construction?: boolean; selected: boolean }[] = [];
    for (const e of model.entities) {
      const selected = selection.includes(e.id);
      if (e.kind === "line") {
        const a = pt(e.a);
        const b = pt(e.b);
        if (a && b)
          out.push({
            id: e.id,
            pts: [asP3(uvToWorld(plane, a[0], a[1])), asP3(uvToWorld(plane, b[0], b[1]))],
            construction: e.construction,
            selected,
          });
      } else if (e.kind === "circle") {
        const c = pt(e.center);
        if (c)
          out.push({
            id: e.id,
            pts: circleWorld(plane, c, e.radius).map(asP3),
            construction: e.construction,
            selected,
          });
      } else if (e.kind === "arc") {
        const a = pt(e.a);
        const th = pt(e.through);
        const b = pt(e.b);
        if (a && th && b)
          out.push({
            id: e.id,
            pts: arcWorld(plane, a, th, b).map(asP3),
            construction: e.construction,
            selected,
          });
      } else if (e.kind === "spline") {
        const uvs = e.points.map(pt).filter(Boolean) as UV[];
        if (uvs.length >= 2) {
          // Linear polyline through control points (display; rebuild uses B-spline).
          out.push({
            id: e.id,
            pts: uvs.map(([u, v]) => asP3(uvToWorld(plane, u, v))),
            construction: e.construction,
            selected,
          });
        }
      }
    }
    return out;
    // model + selection drive recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plane, model, selection]);

  return (
    <group>
      {curves.map((c) => (
        <Line
          key={c.id}
          points={c.pts}
          color={c.selected ? "#ffa23a" : c.construction ? "#4ea1ff" : "#cfe"}
          lineWidth={c.selected ? 2 : 1.5}
          dashed={!!c.construction}
          dashSize={0.003}
          gapSize={0.002}
        />
      ))}
      {model.points.map((p) => {
        const selected = selection.includes(p.id);
        const pos = asP3(uvToWorld(plane, p.u, p.v));
        return (
          <mesh key={p.id} position={pos}>
            <sphereGeometry args={[selected ? 0.0018 : 0.0012, 10, 10]} />
            <meshBasicMaterial color={p.fixed ? "#e66" : selected ? "#ffa23a" : "#9ab"} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Full in-place sketch scene content for the active session. */
export function SketchScene({ frame }: { frame: DatumPlane | null }): React.JSX.Element | null {
  const active = useSketchStore((s) => s.active);
  if (!active || !frame) return null;
  return (
    <group name="sketch-scene">
      <SketchPlanePick plane={frame} />
      <PlaneGrid plane={frame} />
      <SketchEntities plane={frame} />
    </group>
  );
}
