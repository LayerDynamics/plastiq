// In-place 3D sketch geometry (ADR-0014): plane grid, axes, points, and curves
// rendered as R3F scene objects on the active DatumPlane. Drawing input is
// owned by SketchPlanePick (ray ∩ plane → UV); this component is display + pick
// surface only.

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { DatumPlane } from "@plastiq/cad";
import { useSketchStore } from "./sketchStore.js";
import { hitTest } from "./hit.js";
import { projectPlanePoint, useCameraOrientation } from "../viewport/cameraOrientation.js";
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

/** Tools whose shape is defined by two points, so a press-drag-release can draw
 * them end to end (the press is click 1, the release click 2). Chained/multi-click
 * tools (arc, spline, polygon, slot…) keep their own click sequences. */
const DRAG_TOOLS: ReadonlySet<string> = new Set(["line", "rectangle", "circle"]);

/** How far the pointer must travel (SI metres in the sketch plane) before a press
 * counts as a drag rather than a click. Below this a click-by-click gesture would
 * otherwise close a zero-size shape on release. */
const DRAG_MIN = 0.001;

/** Invisible plane mesh that captures left-clicks for sketch tools (ray → UV). */
function SketchPlanePick({ plane }: { plane: DatumPlane }): React.JSX.Element {
  const { camera, gl } = useThree();
  const tool = useSketchStore((s) => s.tool);
  const model = useSketchStore((s) => s.model);
  const clickAt = useSketchStore((s) => s.clickAt);
  const movePoint = useSketchStore((s) => s.movePoint);
  const setSelection = useSketchStore((s) => s.setSelection);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const setDragDraw = useSketchStore((s) => s.setDragDraw);
  const setCursor = useSketchStore((s) => s.setCursor);
  const solve = useSketchStore((s) => s.solve);
  const pushHistory = useSketchStore((s) => s.pushHistory);
  /**
   * The point being dragged with the Select tool, plus the rAF handle coalescing
   * its re-solves (§2.6.2). Dragging used to write coordinates and NOTHING else:
   * the sketch never re-solved, so constraints were visibly violated while you
   * dragged, and the move was not undoable.
   *
   * The solve is coalesced to one per animation frame because planegcs runs the
   * WHOLE sketch — at a 120 Hz pointer that is 120 solves a second — and flushed
   * on release so the committed state is the one the last position implies.
   */
  const pointDrag = useRef<{ id: string; frame: number | null; latest: UV | null }>({
    id: "",
    frame: null,
    latest: null,
  });
  const resolvedFrame = useSketchStore((s) => s.resolvedFrame);
  const viewProjection = useCameraOrientation((s) => s.viewProjection);
  const canvasSize = useCameraOrientation((s) => s.canvas);
  /**
   * Where a drag-draw started, and whether it has travelled far enough to BE a
   * drag (§2.6). A ref, not state: it is read inside pointer handlers on the
   * same gesture and must never lag a re-render.
   */
  const press = useRef<{ uv: UV; moved: boolean } | null>(null);

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
          // Full ENTITY hit test, not points-only (§2.6). Selecting points alone
          // is why every constraint that needs a line or a circle — parallel,
          // perpendicular, equal, concentric, tangent, midpoint, pointOnObject,
          // symmetric, horizontal/vertical — could never enable: `canApply`
          // counts lines/circles in the selection and always saw zero.
          //
          // `hitTest` ranks points above curves, so point picking behaves as
          // before. Both the cursor and the entities are projected through the
          // SAME 2D view, so its px tolerance is a uniform radius in model space
          // (~1.75 mm at the default scale — near the 2 mm this replaces).
          // Pick through the LIVE camera, so the 7 px tolerance is 7 real
          // pixels at the current zoom rather than a fixed 2D view's guess.
          const project = (p: readonly [number, number]): { x: number; y: number } | null =>
            resolvedFrame ? projectPlanePoint(resolvedFrame, viewProjection, canvasSize, p) : null;
          const here = project([u, v]);
          const hit = here ? hitTest(model, project, here) : null;
          if (hit) {
            if (e.shiftKey) toggleSelect(hit.id);
            else setSelection([hit.id]);
            // Dragging a POINT re-solves live, so snapshot ONCE here — per-move
            // snapshots would make one drag an undo stack of its own.
            if (hit.kind === "point") {
              const p = model.points.find((q) => q.id === hit.id);
              if (p && !p.fixed) {
                pushHistory();
                pointDrag.current = { id: hit.id, frame: null, latest: null };
              }
            }
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
        // Press is the FIRST click of a 2-click primitive; if the pointer now
        // travels, release supplies the second (ADR-0014 drag-draw). Snapped
        // coordinates are recorded so the rubber-band starts where the geometry
        // actually did.
        if (DRAG_TOOLS.has(tool)) press.current = { uv: [su, sv], moved: false };
      }}
      onPointerUp={(e) => {
        // Flush a pending point-drag frame: the final solve is authoritative, so
        // releasing must not leave the last movement unapplied.
        const drag = pointDrag.current;
        if (drag.id) {
          if (drag.frame != null) {
            cancelAnimationFrame(drag.frame);
            drag.frame = null;
          }
          if (drag.latest) {
            movePoint(drag.id, drag.latest[0], drag.latest[1]);
            solve();
          }
          pointDrag.current = { id: "", frame: null, latest: null };
        }
        const start = press.current;
        press.current = null;
        setDragDraw(null);
        if (e.button !== 0 || !start) return;
        // A press that never travelled is a plain CLICK — the press already
        // registered it, and click-by-click drawing still completes on the next
        // click. Only a real drag closes the shape here.
        if (!start.moved) return;
        const uv = hitUv(e);
        if (!uv) return;
        e.stopPropagation();
        clickAt(uv[0], uv[1]);
        // A drag draws ONE segment: the polyline chain would otherwise leave the
        // release point pending, so the next drag would continue this line
        // instead of starting its own. Rectangle/circle clear `pending`
        // themselves on completion.
        if (useSketchStore.getState().tool === "line") useSketchStore.setState({ pending: [] });
      }}
      onPointerMove={(e) => {
        // The 2D overlay cannot see the pointer (it is pointer-events-none), so
        // publish it: the precise-input box and snap inference both need it.
        const here = hitUv(e);
        setCursor(here ? [here[0], here[1]] : null);
        // Drag-draw in flight: publish the rubber-band for the 2D overlay.
        const start = press.current;
        if (start && e.buttons === 1) {
          const uv = hitUv(e);
          if (uv) {
            if (!start.moved && Math.hypot(uv[0] - start.uv[0], uv[1] - start.uv[1]) >= DRAG_MIN) {
              start.moved = true;
            }
            if (start.moved) {
              e.stopPropagation();
              setDragDraw({ from: [start.uv[0], start.uv[1]], to: [uv[0], uv[1]] });
            }
          }
          return;
        }
        if (tool !== "select") return;
        // Drag the point picked on press (§2.6.2): move it AND re-solve, so the
        // constraints stay satisfied under the cursor instead of being visibly
        // violated until some later action happened to solve.
        const drag = pointDrag.current;
        if (e.buttons !== 1 || !drag.id) return;
        const pt = model.points.find((p) => p.id === drag.id);
        if (!pt || pt.fixed) return;
        e.stopPropagation();
        const uv = hitUv(e);
        if (!uv) return;
        drag.latest = [uv[0], uv[1]];
        if (drag.frame != null) return;
        drag.frame = requestAnimationFrame(() => {
          drag.frame = null;
          const at = drag.latest;
          drag.latest = null;
          if (!at || !drag.id) return;
          movePoint(drag.id, at[0], at[1]);
          solve();
        });
      }}
      onPointerLeave={() => {
        // Off the plane: drop the cursor so the overlay stops tracking a stale
        // position, and abandon any drag that never released over it.
        setCursor(null);
        setDragDraw(null);
        press.current = null;
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
