// Interactive feature-value gizmo (FR-11 extension): while a feature is being set
// (store.activeFeatureEdit), edit its primary numeric param live (extrude height,
// cut depth, revolve angle, fillet radius, …). Every editable op gets an inline
// value box (correct unit — mm or degrees) you can type into OR drag-scrub; the
// axis-aligned LINEAR ops (extrude/cut) additionally get a draggable arrow along the
// sketch normal. Any change calls updateParams → the document rebuilds → the real
// solid previews as you go. ✓/Enter commits (clears the edit); ✕/Esc cancels (removes
// the just-created feature). The arrow uses drei TransformControls (orbit disables
// mid-drag for free), anchored on the sketch plane so it stays put as the solid grows.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Html, Line, TransformControls } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import {
  FEATURE_EDIT_SPECS,
  MIN_SI,
  featureDragValue,
  fromDisplayUnit,
  scrubToSI,
  toDisplayUnit,
} from "../../viewport/featureGizmo.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";
import type { DatumPlaneId } from "../../sketch/model.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

/** The extrude/cut axis (unit) + a STABLE base anchor: the part's in-plane centre
 * pinned onto the sketch plane along the axis, so it doesn't drift as the solid
 * grows during the live preview (datum normals are axis-aligned). */
function axisAndAnchor(
  part: BuiltPart,
  upstreamPlane: { base: DatumPlaneId; offset: number } | null,
): { axis: THREE.Vector3; anchor: THREE.Vector3; worldAxis: "x" | "y" | "z" } {
  const dp = resolveDatumPlane(upstreamPlane?.base ?? "XY", upstreamPlane?.offset ?? 0);
  const axis = new THREE.Vector3(dp.normal[0], dp.normal[1], dp.normal[2]).normalize();
  const origin = new THREE.Vector3(dp.origin[0], dp.origin[1], dp.origin[2]);
  const center = new THREE.Box3().setFromObject(part.group).getCenter(new THREE.Vector3());
  // Project the part centre onto the sketch plane: keep its in-plane position (stable
  // under extrude) but pin the along-axis coordinate to the plane (stable, period).
  const along = center.clone().sub(origin).dot(axis);
  const anchor = center.clone().addScaledVector(axis, -along);
  const worldAxis = Math.abs(axis.x) > 0.5 ? "x" : Math.abs(axis.y) > 0.5 ? "y" : "z";
  return { axis, anchor, worldAxis };
}

export function FeatureEditGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const edit = useCadStore((s) => s.activeFeatureEdit);
  const features = useCadStore((s) => s.features);
  const handle = useRef<THREE.Mesh>(null);
  const input = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const scrub = useRef<{ x: number; start: number } | null>(null);

  const feature = edit ? features.find((f) => f.id === edit.id) : undefined;
  const spec = feature ? FEATURE_EDIT_SPECS[feature.type] : undefined;
  const value = (spec ? feature?.params?.[spec.param] : undefined) ?? 0;
  const active = !!(edit && feature && spec && part);
  useGizmoPresence("featureEdit", active);

  // World geometry (arrow + anchor) only for the axis-aligned linear ops; the others
  // float their value box at the part centre.
  const geom = useMemo(() => {
    if (!active || !part || !spec || !edit) return null;
    if (spec.world) {
      const { axis, anchor, worldAxis } = axisAndAnchor(part, upstreamPlaneOf(features, edit.id));
      return { world: true as const, axis, anchor, worldAxis, anchorAxisCoord: anchor.dot(axis) };
    }
    const center = new THREE.Box3().setFromObject(part.group).getCenter(new THREE.Vector3());
    return { world: false as const, center };
  }, [active, part, spec, features, edit]);

  const tip =
    geom?.world && spec ? geom.anchor.clone().addScaledVector(geom.axis, value) : null;
  const boxPos = geom ? (geom.world ? tip : geom.center) : null;

  // E2E seam: the world arrow's unit axis — the direction the linear op extends/cuts
  // (null for the value-box-only ops). Lets a test PROVE the arrow points along the
  // feature's actual sweep: a cut on the XY plane removes material in +Z, so the
  // arrow must read [0,0,1], not the opposite.
  useEffect(() => {
    const g = globalThis as {
      __plastiqViewport?: { featureGizmoAxis?: [number, number, number] | null };
    };
    if (!g.__plastiqViewport) return;
    g.__plastiqViewport.featureGizmoAxis =
      geom?.world === true ? (geom.axis.toArray() as [number, number, number]) : null;
    return () => {
      if (g.__plastiqViewport) g.__plastiqViewport.featureGizmoAxis = null;
    };
  }, [geom]);

  // Keep the drag handle at the tip when the value changes from elsewhere (typing,
  // scrub, undo), but never while the user is actively dragging it.
  useEffect(() => {
    if (handle.current && tip && !dragging.current) handle.current.position.copy(tip);
  }, [tip]);

  // Auto-focus the value box when an edit opens, so Enter/Esc and typing work
  // immediately (App.tsx ignores keys while an INPUT is focused → no double-handling).
  useEffect(() => {
    if (active) {
      input.current?.focus();
      input.current?.select();
    }
  }, [active, edit?.id]);

  if (!active || !part || !edit || !spec || !geom || !boxPos) return null;
  const commit = (): void => useCadStore.getState().setActiveFeatureEdit(null);
  const cancel = (): void => useCadStore.getState().removeFeature(edit.id);
  const setSI = (si: number): void => useCadStore.getState().updateParams(edit.id, { [spec.param]: si });
  const display = Number(toDisplayUnit(value, spec.unit).toFixed(3));
  const unitLabel = spec.unit === "deg" ? "°" : "mm";

  // Arrow drag (world ops) → handle slides along the axis → new value (floored).
  const onObjectChange = (): void => {
    if (!handle.current || !geom.world) return;
    setSI(featureDragValue(geom.anchorAxisCoord, handle.current.position.dot(geom.axis), MIN_SI));
  };

  return (
    <group>
      {geom.world && tip && (
        <>
          {/* The extent line from the sketch plane to the current tip. */}
          <Line points={[geom.anchor.toArray(), tip.toArray()]} color={hex(SELECT_ORANGE)} lineWidth={2} />
          {/* Draggable single-axis handle; drei disables OrbitControls while dragging. */}
          <TransformControls
            mode="translate"
            showX={geom.worldAxis === "x"}
            showY={geom.worldAxis === "y"}
            showZ={geom.worldAxis === "z"}
            onMouseDown={() => {
              dragging.current = true;
            }}
            onMouseUp={() => {
              dragging.current = false;
              input.current?.focus();
            }}
            onObjectChange={onObjectChange}
          >
            <mesh ref={handle} position={tip.toArray()} renderOrder={2}>
              <sphereGeometry args={[0.005, 16, 16]} />
              <meshBasicMaterial color={hex(SELECT_ORANGE)} />
            </mesh>
          </TransformControls>
        </>
      )}
      {/* Inline value box: type a value, drag the grip to scrub, ✓/✕ to commit/cancel. */}
      <Html position={boxPos.toArray()} zIndexRange={[900, 0]} pointerEvents="auto" wrapperClass="feat-edit">
        <div
          data-testid="feature-edit-box"
          className="flex translate-x-3 items-center gap-1 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span
            data-testid="feature-edit-scrub"
            title="Drag to adjust"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              scrub.current = { x: e.clientX, start: toDisplayUnit(value, spec.unit) };
            }}
            onPointerMove={(e) => {
              if (scrub.current) setSI(scrubToSI(scrub.current.start, e.clientX - scrub.current.x, spec.unit));
            }}
            onPointerUp={(e) => {
              scrub.current = null;
              // Guard like the canvas does (PR #25): releasePointerCapture throws
              // NotFoundError if no capture is live for this id.
              const el = e.target as Element;
              if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
            }}
            className="cursor-ew-resize select-none px-0.5 text-xs text-[#789] hover:text-[#cfe]"
          >
            ⇆
          </span>
          <input
            ref={input}
            type="number"
            step="any"
            data-testid="feature-edit-value"
            value={display}
            onChange={(e) => {
              const d = Number(e.currentTarget.value);
              if (Number.isFinite(d)) setSI(Math.max(fromDisplayUnit(d, spec.unit), MIN_SI));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                commit();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                cancel();
              }
            }}
            className="w-16 rounded border border-[#2a3444] bg-black/40 px-1 py-0.5 text-right text-[11px] text-[#cfe] outline-none focus:border-[#ffa23a]"
          />
          <span className="text-[10px] text-[#789]">{unitLabel}</span>
          <button
            type="button"
            data-testid="feature-edit-commit"
            onClick={commit}
            title="Confirm (Enter)"
            className="rounded px-1 text-xs text-[#6be675] hover:bg-[#1b2230]"
          >
            ✓
          </button>
          <button
            type="button"
            data-testid="feature-edit-cancel"
            onClick={cancel}
            title="Cancel (Esc)"
            className="rounded px-1 text-xs text-[#ff8a8a] hover:bg-[#2a1717]"
          >
            ✕
          </button>
        </div>
      </Html>
    </group>
  );
}

/** The base-datum plane spec of the most recent unsuppressed sketch upstream of
 * `id` (null when none / a face-derived sketch → caller defaults to XY). */
function upstreamPlaneOf(
  features: ReturnType<typeof useCadStore.getState>["features"],
  id: string,
): { base: DatumPlaneId; offset: number } | null {
  const idx = features.findIndex((f) => f.id === id);
  for (let i = idx - 1; i >= 0; i--) {
    const f = features[i]!;
    if (f.type !== "sketch" || f.suppressed) continue;
    const p = f.data?.["plane"] as { base?: DatumPlaneId; offset?: number } | undefined;
    if (p && typeof p.base === "string") return { base: p.base, offset: p.offset ?? 0 };
    return null; // a sketch with no base datum (e.g. on-face) → default
  }
  return null;
}
