import { describe, expect, it } from "vitest";
import { base64ToBytes } from "./exportGlb.js";
import { meshBodiesToGlbBase64 } from "./glb.js";
import { importGltf } from "./importGltf.js";
import type { MeshBody } from "./meshBody.js";

describe("meshBodiesToGlbBase64", () => {
  it("round-trips edited triangle positions through the app glTF importer", async () => {
    const body: MeshBody = {
      positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const decoded = await importGltf(base64ToBytes(meshBodiesToGlbBase64([body])).buffer);
    expect(decoded).toHaveLength(1);
    expect(Array.from(decoded[0]!.positions)).toEqual(Array.from(body.positions));
    expect(Array.from(decoded[0]!.indices)).toEqual([0, 1, 2]);
  });
});
