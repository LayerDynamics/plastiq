// Interactive feature-value gizmo (FR-11 extension): while a feature is being set
// (store.activeFeatureEdit), show a draggable arrow in the viewport bound to its
// primary numeric param (extrude → height) PLUS an inline value box. Dragging the
// arrow or typing updates the param live (the document rebuilds), so the model
// previews as you go. ✓/Enter commits (clears the edit); ✕/Esc cancels (removes the
// just-created feature). The arrow runs along the upstream sketch plane's normal.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";
import type { DatumPlaneId } from "../../sketch/model.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
const MIN_VALUE = 5e-4; // 0.5 mm floor so the arrow never collapses to a point

/** The extrude axis (unit) + a stable base anchor on the part, from the upstream
 * sketch's datum plane (defaults to XY / +Z when the plane isn't a base datum). */
function axisAndAnchor(
  part: BuiltPart,
  upstreamPlane: { base: DatumPlaneId; offset: number } | null,
): { axis: THREE.Vector3; anchor: THREE.Vector3 } {
  const dp = resolveDatumPlane(upstreamPlane?.base ?? "XY", upstreamPlane?.offset ?? 0);
  const axis = new THREE.Vector3(dp.normal[0], dp.normal[1], dp.normal[2]).normalize();
  const box = new THREE.Box3().setFromObject(part.group);
  const center = box.getCenter(new THREE.Vector3());
  // Start the arrow at the part's base face on the side the extrude grows FROM, so
  // it points out along the axis (datum normals are axis-aligned).
  const anchor = center.clone();
  if (Math.abs(axis.x) > 0.5) anchor.x = axis.x > 0 ? box.min.x : box.max.x;
  else if (Math.abs(axis.y) > 0.5) anchor.y = axis.y > 0 ? box.min.y : box.max.y;
  else anchor.z = axis.z > 0 ? box.min.z : box.max.z;
  return { axis, anchor };
}

export function FeatureEditGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const edit = useCadStore((s) => s.activeFeatureEdit);
  const features = useCadStore((s) => s.features);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const dragging = useRef(false);

  const feature = edit ? features.find((f) => f.id === edit.id) : undefined;
  const value = feature?.params?.[edit?.param ?? ""] ?? 0;
  const active = !!(edit && feature && part);
  useGizmoPresence("featureEdit", active);

  // Pointer-drag along the axis (cone handle) → set the param. Bound on the canvas
  // while dragging; the closest point of the cursor ray to the axis gives the value.
  useEffect(() => {
    if (!active) return;
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const onMove = (e: PointerEvent): void => {
      if (!dragging.current || !part) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -(((e.clientY - r.top) / r.height) * 2 - 1),
      );
      ray.setFromCamera(ndc, camera);
      const upstream = upstreamPlaneOf(features, edit!.id);
      const { axis, anchor } = axisAndAnchor(part, upstream);
      // Closest parameter t along the axis line (anchor + t·axis) to the cursor ray.
      const w0 = anchor.clone().sub(ray.ray.origin);
      const b = axis.dot(ray.ray.direction);
      const denom = 1 - b * b;
      if (Math.abs(denom) < 1e-6) return; // ray ~parallel to the axis
      const t = (b * ray.ray.direction.dot(w0) - axis.dot(w0)) / denom;
      useCadStore.getState().updateParams(edit!.id, { [edit!.param]: Math.max(t, MIN_VALUE) });
      invalidate();
    };
    const onUp = (): void => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active, gl, camera, invalidate, features, edit, part]);

  // Esc cancels (remove the just-created feature); Enter commits.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") useCadStore.getState().removeFeature(edit!.id);
      else if (e.key === "Enter") useCadStore.getState().setActiveFeatureEdit(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, edit]);

  if (!active || !part || !edit) return null;
  const { axis, anchor } = axisAndAnchor(part, upstreamPlaneOf(features, edit.id));
  const tip = anchor.clone().addScaledVector(axis, value);
  const commit = (): void => useCadStore.getState().setActiveFeatureEdit(null);
  const cancel = (): void => useCadStore.getState().removeFeature(edit.id);

  return (
    <group>
      <Line points={[anchor.toArray(), tip.toArray()]} color={hex(SELECT_ORANGE)} lineWidth={2} />
      {/* Draggable arrow head at the tip. */}
      <mesh
        position={tip.toArray()}
        quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragging.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
      >
        <coneGeometry args={[0.004, 0.01, 16]} />
        <meshBasicMaterial color={hex(SELECT_ORANGE)} />
      </mesh>
      {/* Inline value box at the tip. */}
      <Html position={tip.toArray()} zIndexRange={[900, 0]} pointerEvents="auto" wrapperClass="feat-edit">
        <div
          data-testid="feature-edit-box"
          className="flex translate-x-3 items-center gap-1 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
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
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
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
