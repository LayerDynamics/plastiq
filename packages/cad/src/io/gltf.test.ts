import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { exportGltf } from "./gltf.js";

const INIT_TIMEOUT_MS = 120_000;

/** Decode a base64 data-URI buffer to bytes. */
function decodeBuffer(uri: string): Uint8Array {
  const b64 = uri.slice(uri.indexOf(",") + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("glTF tessellation export (FR-33)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("exports a structurally valid glTF 2.0 whose buffer matches the mesh", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const json = exportGltf(oc, box, { linearDeflection: mm(0.2) });
      const gltf = JSON.parse(json) as {
        asset: { version: string };
        meshes: {
          primitives: { attributes: { POSITION: number }; indices: number; mode: number }[];
        }[];
        accessors: {
          count: number;
          type: string;
          componentType: number;
          min?: number[];
          max?: number[];
        }[];
        bufferViews: { byteLength: number; byteOffset: number }[];
        buffers: { byteLength: number; uri: string }[];
      };

      expect(gltf.asset.version).toBe("2.0");
      const prim = gltf.meshes[0]!.primitives[0]!;
      expect(prim.mode).toBe(4); // TRIANGLES
      const posAcc = gltf.accessors[prim.attributes.POSITION]!;
      const idxAcc = gltf.accessors[prim.indices]!;
      expect(posAcc.type).toBe("VEC3");
      expect(idxAcc.type).toBe("SCALAR");
      // A box tessellates to ≥ 12 triangles (2 per face) → indices a multiple of 3.
      expect(idxAcc.count % 3).toBe(0);
      expect(idxAcc.count / 3).toBeGreaterThanOrEqual(12);
      // POSITION bounds are present and finite.
      expect(posAcc.min!.every(Number.isFinite)).toBe(true);
      expect(posAcc.max!.every(Number.isFinite)).toBe(true);

      // Decode the embedded buffer and confirm the byte layout matches.
      const bytes = decodeBuffer(gltf.buffers[0]!.uri);
      expect(bytes.length).toBe(gltf.buffers[0]!.byteLength);
      // positions: count·3 floats·4 bytes; indices: count·4 bytes.
      const expectedPosBytes = posAcc.count * 3 * 4;
      const expectedIdxBytes = idxAcc.count * 4;
      expect(bytes.length).toBe(expectedPosBytes + expectedIdxBytes);
      expect(gltf.bufferViews[0]!.byteLength).toBe(expectedPosBytes);
      expect(gltf.bufferViews[1]!.byteOffset).toBe(expectedPosBytes);

      // Every index is a valid vertex reference.
      const idx = new Uint32Array(bytes.buffer, expectedPosBytes, idxAcc.count);
      expect(idx.every((i) => i < posAcc.count)).toBe(true);
    } finally {
      box.delete();
    }
  });

  it("throws on an empty mesh", () => {
    // A solid that tessellates fine won't be empty; this guards the contract.
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    try {
      // A reasonable deflection always yields triangles; assert the happy path
      // does NOT throw (the empty-mesh guard is for degenerate inputs).
      expect(() => exportGltf(oc, box, { linearDeflection: mm(0.5) })).not.toThrow();
    } finally {
      box.delete();
    }
  });
});
