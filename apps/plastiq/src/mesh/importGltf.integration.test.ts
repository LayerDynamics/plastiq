// @vitest-environment jsdom
// SPEC-6 R4.1 (T4.1): GLB/glTF import via three.js GLTFLoader. Runs under jsdom (the
// loader needs DOM globals; OCCT is NOT used here, so there's no node-env conflict).
// The fixture is a real, spec-valid glTF 2.0 triangle with an embedded base64 buffer,
// built at runtime — a genuine parse, not a mock.

import { describe, it, expect } from "vitest";
import { importGltf } from "./importGltf.js";
import { meshBodyTriangleCount, meshBodyBounds } from "./meshBody.js";

/** A minimal valid glTF 2.0 document: one triangle (40×20 mm), embedded buffer. */
function triangleGltf(): string {
  const positions = new Float32Array([0, 0, 0, 0.04, 0, 0, 0, 0.02, 0]); // SI metres
  const indices = new Uint16Array([0, 1, 2]);
  const posBytes = new Uint8Array(positions.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const buf = new Uint8Array(posBytes.length + idxBytes.length);
  buf.set(posBytes, 0);
  buf.set(idxBytes, posBytes.length);
  const b64 = Buffer.from(buf).toString("base64");
  return JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: buf.length, uri: `data:application/octet-stream;base64,${b64}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0.04, 0.02, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  });
}

describe("R4.1 importGltf", () => {
  it("parses a glTF triangle into a MeshBody", async () => {
    const bodies = await importGltf(triangleGltf());
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.positions.length).toBe(9);
    expect(Array.from(body.indices)).toEqual([0, 1, 2]);
    expect(meshBodyTriangleCount(body)).toBe(1);

    const bounds = meshBodyBounds(body)!;
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(0.04, 6);
    expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(0.02, 6);
  });

  it("rejects glTF with no mesh geometry", async () => {
    await expect(importGltf('{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[]}]}')).rejects.toThrow(/no mesh/i);
  });
});
