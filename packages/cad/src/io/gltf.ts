// glTF 2.0 tessellation export (SPEC-4 FR-33): turn a solid's render mesh into a
// self-contained glTF (geometry + an embedded base64 buffer) for viewers and
// downstream renderers. Positions are FLOAT VEC3, indices UNSIGNED_INT SCALAR —
// a single mesh primitive (TRIANGLES). Deterministic (NFR-2): fixed key order,
// no RNG.

import { tessellate, type TessellateOptions } from "../mesh/tessellate.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
const MODE_TRIANGLES = 4;

/** Base64-encode a byte buffer (portable across Node + browser, chunked). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // avoid String.fromCharCode arg-count overflow
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Export `solid`'s tessellation as a glTF 2.0 document (JSON string with an
 * embedded data-URI buffer). Throws if the mesh is empty (degenerate geometry).
 */
export function exportGltf(oc: Occt, solid: Solid, opts: TessellateOptions): string {
  const mesh = tessellate(oc, solid, opts);
  if (mesh.indices.length === 0 || mesh.vertices.length === 0) {
    throw new Error("glTF export: tessellation produced an empty mesh");
  }

  const positions = Float32Array.from(mesh.vertices);
  const indices = Uint32Array.from(mesh.indices);

  // Pack positions then indices into one buffer (both 4-byte aligned).
  const posBytes = new Uint8Array(positions.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const buffer = new Uint8Array(posBytes.length + idxBytes.length);
  buffer.set(posBytes, 0);
  buffer.set(idxBytes, posBytes.length);

  // POSITION accessor requires min/max bounds.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.vertices[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }

  const gltf = {
    asset: { version: "2.0", generator: "@plastiq/cad" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: MODE_TRIANGLES }],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: COMPONENT_FLOAT,
        count: positions.length / 3,
        type: "VEC3",
        min,
        max,
      },
      {
        bufferView: 1,
        componentType: COMPONENT_UINT,
        count: indices.length,
        type: "SCALAR",
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: TARGET_ARRAY_BUFFER },
      {
        buffer: 0,
        byteOffset: posBytes.length,
        byteLength: idxBytes.length,
        target: TARGET_ELEMENT_ARRAY_BUFFER,
      },
    ],
    buffers: [
      {
        byteLength: buffer.length,
        uri: `data:application/octet-stream;base64,${toBase64(buffer)}`,
      },
    ],
  };

  return JSON.stringify(gltf);
}
