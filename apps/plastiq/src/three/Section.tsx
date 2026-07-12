// Section analysis (Fusion-style, FR-14). Applies a world-space clip plane and a
// solid filled cut face so the interior reads as a solid slice — not a hollow
// shell. Cap technique: same mesh drawn BackSide with a flat fill colour under
// the same clipping plane (standard three.js section fill).

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import {
  isAxisSection,
  resolveSectionPlane,
  sectionHandlePosition,
  type SectionAnalysis,
} from "../viewport/section.js";
import type { BuiltPart } from "../viewport/buildMesh.js";

/** Interior fill colour on the cut (Fusion-like solid section). */
const SECTION_FILL = 0x6a7a8c;

function bboxFromPart(part: BuiltPart): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const box = new THREE.Box3().setFromObject(part.group);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/** Walk every material on the part (faces + edges + vertices) and set clipping. */
function applyClipToObject(root: THREE.Object3D, planes: THREE.Plane[] | null): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.LineSegments).isLineSegments && !(obj as THREE.Points).isPoints)
      return;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      const mat = m as THREE.Material & { clippingPlanes?: THREE.Plane[] | null; clipShadows?: boolean };
      mat.clippingPlanes = planes;
      mat.clipShadows = true;
      mat.needsUpdate = true;
    }
  });
}

export function Section({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const gl = useThree((s) => s.gl);
  const section = useCadStore((s) => s.section);
  const capRef = useRef<THREE.Mesh | null>(null);

  // Enable local clipping once (required for material + global planes).
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);

  const plane = useMemo(() => {
    if (!section || !part) return null;
    const bbox = bboxFromPart(part);
    const sp = resolveSectionPlane(section, bbox);
    return new THREE.Plane(
      new THREE.Vector3(sp.normal[0], sp.normal[1], sp.normal[2]),
      sp.constant,
    );
  }, [section, part]);

  // Apply clip to renderer + materials; build/destroy the solid fill cap.
  useEffect(() => {
    if (!part) {
      gl.clippingPlanes = [];
      return;
    }
    if (!plane || !section) {
      gl.clippingPlanes = [];
      applyClipToObject(part.group, null);
      if (capRef.current) {
        part.group.remove(capRef.current);
        capRef.current.geometry.dispose();
        (capRef.current.material as THREE.Material).dispose();
        capRef.current = null;
      }
      return;
    }

    const planes = [plane];
    gl.clippingPlanes = planes;
    applyClipToObject(part.group, planes);

    // Solid section fill: BackSide of the same solid geometry under the clip.
    const solid = part.mesh;
    if (solid.geometry) {
      if (capRef.current) {
        part.group.remove(capRef.current);
        (capRef.current.material as THREE.Material).dispose();
        // geometry is shared with the solid — do NOT dispose.
        capRef.current = null;
      }
      const capMat = new THREE.MeshBasicMaterial({
        color: SECTION_FILL,
        side: THREE.BackSide,
        clippingPlanes: planes,
        clipShadows: true,
        // Avoid z-fighting with the exterior faces on the cut.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const cap = new THREE.Mesh(solid.geometry, capMat);
      cap.name = "section-fill";
      cap.renderOrder = 0;
      // Match the solid's local transform (identity under part.group).
      cap.position.copy(solid.position);
      cap.quaternion.copy(solid.quaternion);
      cap.scale.copy(solid.scale);
      part.group.add(cap);
      capRef.current = cap;
    }

    return () => {
      gl.clippingPlanes = [];
      applyClipToObject(part.group, null);
      if (capRef.current) {
        part.group.remove(capRef.current);
        (capRef.current.material as THREE.Material).dispose();
        capRef.current = null;
      }
    };
  }, [gl, part, plane, section]);

  return null;
}

/** Helpers used by the gizmo / controls (re-exported convenience). */
export function sectionBBox(part: BuiltPart): {
  min: [number, number, number];
  max: [number, number, number];
} {
  return bboxFromPart(part);
}

export function axisSectionFromState(section: SectionAnalysis | null): {
  axis: "x" | "y" | "z";
  t: number;
  flip: boolean;
} | null {
  if (!section || !isAxisSection(section)) return null;
  return { axis: section.axis, t: section.t, flip: section.flip === true };
}

export { sectionHandlePosition };
