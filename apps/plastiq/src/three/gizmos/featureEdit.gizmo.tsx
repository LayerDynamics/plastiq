// Interactive feature-value gizmo (FR-11 extension): while a feature is being set
// (store.activeFeatureEdit), show a draggable arrow in the viewport bound to its
// primary numeric param (extrude → height) PLUS an inline value box. Dragging the
// arrow (a drei TransformControls handle — orbit is disabled mid-drag for free) or
// typing updates the param live, so the document rebuilds and the model previews as
// you go. ✓/Enter commits (clears the edit); ✕/Esc cancels (removes the just-created
// feature). The arrow runs along the upstream sketch plane's normal, anchored on the
// plane itself so it stays put as the solid grows.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Html, Line, TransformControls } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import { featureDragValue } from "../../viewport/featureGizmo.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";
import type { DatumPlaneId } from "../../sketch/model.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
const MIN_VALUE = 5e-4; // 0.5 mm floor so the arrow never collapses to a point

/** The extrude axis (unit) + a STABLE base anchor: the part's in-plane centre
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
  const worldAxis =
    Math.abs(axis.x) > 0.5 ? "x" : Math.abs(axis.y) > 0.5 ? "y" : "z";
  return { axis, anchor, worldAxis };
}

export function FeatureEditGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const edit = useCadStore((s) => s.activeFeatureEdit);
  const features = useCadStore((s) => s.features);
  const handle = useRef<THREE.Mesh>(null);
  const input = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);

  const feature = edit ? features.find((f) => f.id === edit.id) : undefined;
  const value = feature?.params?.[edit?.param ?? ""] ?? 0;
  const active = !!(edit && feature && part);
  useGizmoPresence("featureEdit", active);

  const geom = useMemo(() => {
    if (!active || !part || !edit) return null;
    const { axis, anchor, worldAxis } = axisAndAnchor(part, upstreamPlaneOf(features, edit.id));
    return { axis, anchor, worldAxis, anchorAxisCoord: anchor.dot(axis) };
  }, [active, part, edit, features]);

  const tip = geom ? geom.anchor.clone().addScaledVector(geom.axis, value) : null;

  // Keep the drag handle at the tip when the value changes from elsewhere (typing,
  // undo), but never while the user is actively dragging it.
  useEffect(() => {
    if (handle.current && tip && !dragging.current) handle.current.position.copy(tip);
  }, [tip]);

  // Auto-focus the value box when an edit opens, so Enter/Esc and typing work
  // immediately (and App's Esc→clear-selection defers to a focused input — App.tsx
  // ignores keys while an INPUT is focused, so there's no double-handling).
  useEffect(() => {
    if (active) {
      input.current?.focus();
      input.current?.select();
    }
  }, [active, edit?.id]);

  if (!active || !part || !edit || !geom || !tip) return null;
  const { axis, anchor, anchorAxisCoord, worldAxis } = geom;
  const commit = (): void => useCadStore.getState().setActiveFeatureEdit(null);
  const cancel = (): void => useCadStore.getState().removeFeature(edit.id);

  // Drag → handle slides along the axis → new value (floored) → store → live rebuild.
  const onObjectChange = (): void => {
    if (!handle.current) return;
    const v = featureDragValue(anchorAxisCoord, handle.current.position.dot(axis), MIN_VALUE);
    useCadStore.getState().updateParams(edit.id, { [edit.param]: v });
  };

  return (
    <group>
      {/* The extent line from the sketch plane to the current tip. */}
      <Line points={[anchor.toArray(), tip.toArray()]} color={hex(SELECT_ORANGE)} lineWidth={2} />
      {/* Draggable single-axis handle; drei disables OrbitControls while dragging. */}
      <TransformControls
        mode="translate"
        showX={worldAxis === "x"}
        showY={worldAxis === "y"}
        showZ={worldAxis === "z"}
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
      {/* Inline value box at the tip. */}
      <Html position={tip.toArray()} zIndexRange={[900, 0]} pointerEvents="auto" wrapperClass="feat-edit">
        <div
          data-testid="feature-edit-box"
          className="flex translate-x-3 items-center gap-1 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            ref={input}
            type="number"
            step="any"
            data-testid="feature-edit-value"
            value={Number((value * 1000).toFixed(3))}
            onChange={(e) => {
              const mm = Number(e.currentTarget.value);
              if (Number.isFinite(mm))
                useCadStore.getState().updateParams(edit.id, { [edit.param]: Math.max(mm / 1000, MIN_VALUE) });
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
          <span className="text-[10px] text-[#789]">mm</span>
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
