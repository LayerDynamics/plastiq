// @vitest-environment jsdom
// ADR-0010 handoff encoder — voxel surface mesh → binary GLB (base64). Structure is
// checked against the glTF 2.0 container spec, and the round-trip is a REAL parse
// through the app's own importGltf (three.js GLTFLoader, jsdom like its own test):
// the staged MeshDoc.glb must load exactly the way the viewport loads generated
// meshes, or the handoff is fiction.

import { describe, expect, it } from "vitest";

import { importGltf } from "../mesh/importGltf.js";
import { base64ToBytes } from "../mesh/exportGlb.js";
import { meshBodyBounds, meshBodyTriangleCount } from "../mesh/meshBody.js";
import { VoxelGrid } from "./grid.js";
import { gridToDoc, voxelDocToMesh } from "./doc.js";
import { voxelMeshToGlb, voxelMeshToGlbBase64 } from "./glb.js";

/** A single 2 mm voxel at the origin — 6 faces → 12 triangles, 24 vertices. */
function oneVoxelMesh(): ReturnType<typeof voxelDocToMesh> {
  const g = new VoxelGrid([2, 2, 2], 0.002, [0, 0, 0]);
  g.set(0, 0, 0, true);
  return voxelDocToMesh(gridToDoc(g));
}

describe("voxelMeshToGlb — container structure", () => {
  it("emits a spec-valid GLB header (magic, version 2, 4-byte-aligned chunks)", () => {
    const glb = voxelMeshToGlb(oneVoxelMesh());
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67); // "glTF"
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength); // total length header
    const jsonLen = dv.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as {
      asset: { version: string };
      accessors: { count: number; type: string; min?: number[]; max?: number[] }[];
    };
    expect(json.asset.version).toBe("2.0");
    // POSITION accessor carries the spec-required min/max.
    const pos = json.accessors.find((a) => a.type === "VEC3")!;
    expect(pos.min).toEqual([0, 0, 0]);
    expect(pos.max).toEqual([0.002, 0.002, 0.002]);
    // BIN chunk header sits right after the JSON chunk.
    expect(dv.getUint32(20 + jsonLen + 4, true)).toBe(0x004e4942); // "BIN\0"
  });

  it("rejects an empty mesh loudly (no placeholder geometry)", () => {
    expect(() => voxelMeshToGlb({ vertices: [], indices: [] })).toThrow(/empty/i);
  });
});

describe("voxelMeshToGlbBase64 — round-trip through the app's real GLB import path", () => {
  it("one voxel → GLB → importGltf yields the identical surface geometry", async () => {
    const mesh = oneVoxelMesh();
    const b64 = voxelMeshToGlbBase64(mesh);
    const bytes = base64ToBytes(b64); // the exact decode the viewport/export use
    const bodies = await importGltf(bytes.buffer);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(meshBodyTriangleCount(body)).toBe(12); // 6 faces × 2 triangles
    expect(Array.from(body.indices)).toEqual(mesh.indices);
    // Positions are float32 in a GLB — compare in float32 space (0.002 quantises).
    expect(Array.from(body.positions)).toEqual(Array.from(new Float32Array(mesh.vertices)));
    const bounds = meshBodyBounds(body)!;
    expect(bounds.min).toEqual([0, 0, 0]);
    for (const c of bounds.max) expect(c).toBeCloseTo(0.002, 6);
  });

  it("a sculpted shape round-trips with only its EXPOSED faces (surface mesh)", async () => {
    const g = new VoxelGrid([3, 3, 3], 1, [0, 0, 0]);
    g.addBox([0, 0, 0], [2, 2, 2]); // solid 3³ block
    const mesh = g.toMesh();
    const bodies = await importGltf(base64ToBytes(voxelMeshToGlbBase64(mesh)).buffer);
    // 6 sides × 9 exposed cell-faces × 2 triangles — interior faces culled.
    expect(meshBodyTriangleCount(bodies[0]!)).toBe(6 * 9 * 2);
  });
});
