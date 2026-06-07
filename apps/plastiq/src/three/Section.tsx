// Section clipping (B-4 parity, in r3f). Drives the renderer's global clipping
// plane from the store section + the part's world bbox, reusing the pure sectionPlane
// math. Global gl.clippingPlanes clips every rendered object (part + instances),
// exactly like the legacy SceneController.applySection.

import { useEffect } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import { sectionPlane } from "../viewport/section.js";
import type { BuiltPart } from "../viewport/buildMesh.js";

export function Section({ part }: { part: BuiltPart | null }): null {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const apply = (): void => {
      const section = useCadStore.getState().section;
      if (!section || !part) {
        gl.clippingPlanes = [];
        return;
      }
      const box = new THREE.Box3().setFromObject(part.group);
      const { axis, t } = section;
      const min = axis === "x" ? box.min.x : axis === "y" ? box.min.y : box.min.z;
      const max = axis === "x" ? box.max.x : axis === "y" ? box.max.y : box.max.z;
      const { normal, constant } = sectionPlane(min, max, axis, t);
      gl.clippingPlanes = [
        new THREE.Plane(new THREE.Vector3(normal[0], normal[1], normal[2]), constant),
      ];
    };
    apply();
    const unsub = useCadStore.subscribe((s, prev) => {
      if (s.section !== prev.section) apply();
    });
    return () => {
      unsub();
      gl.clippingPlanes = [];
    };
  }, [gl, part]);
  return null;
}
