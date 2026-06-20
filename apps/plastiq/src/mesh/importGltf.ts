// SPEC-6 R4.1 — GLB/glTF import (decision 24). Parses a glTF (JSON string) or GLB
// (ArrayBuffer) into MeshBody[] using three.js GLTFLoader (already an app dep),
// baking each mesh's world transform into world-space SI positions. Main-thread —
// the creative path does not use the OCCT worker (spec §6.5).

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Vector3, type Mesh, type BufferGeometry, type BufferAttribute, type InterleavedBufferAttribute } from "three";
import type { MeshBody } from "./meshBody.js";

function toMeshBody(mesh: Mesh): MeshBody | null {
  const geom = mesh.geometry as BufferGeometry;
  const pos = geom.getAttribute("position") as BufferAttribute | InterleavedBufferAttribute | undefined;
  if (!pos) return null;

  mesh.updateWorldMatrix(true, false);
  const world = mesh.matrixWorld;
  const v = new Vector3();
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(world);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }

  const indexAttr = geom.getIndex();
  const indices = indexAttr
    ? Uint32Array.from(indexAttr.array as ArrayLike<number>)
    : Uint32Array.from({ length: pos.count }, (_, i) => i);

  const normalAttr = geom.getAttribute("normal") as BufferAttribute | InterleavedBufferAttribute | undefined;
  const normals = normalAttr ? Float32Array.from(normalAttr.array as ArrayLike<number>) : undefined;

  return { positions, indices, ...(normals ? { normals } : {}) };
}

/** Parse a glTF (JSON string) or GLB (ArrayBuffer) into one MeshBody per mesh. */
export function importGltf(data: ArrayBuffer | string): Promise<MeshBody[]> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      data,
      "",
      (gltf) => {
        const bodies: MeshBody[] = [];
        gltf.scene.updateWorldMatrix(true, true);
        gltf.scene.traverse((obj) => {
          const mesh = obj as Mesh;
          if (mesh.isMesh) {
            const body = toMeshBody(mesh);
            if (body) bodies.push(body);
          }
        });
        if (bodies.length === 0) {
          reject(new Error("glTF/GLB contained no mesh geometry"));
        } else {
          resolve(bodies);
        }
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
