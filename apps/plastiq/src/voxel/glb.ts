// Voxel surface mesh → a minimal, spec-valid binary glTF 2.0 (GLB), base64-encoded —
// the exact `MeshDoc.glb` shape the app already persists/renders/reconstructs
// (store/types.ts, mesh/importGltf.ts, ai reconstruct). This is the ADR-0010 handoff
// encoder: a VoxelDoc's exposed-face mesh becomes a MeshDoc so the EXISTING
// Convert-to-CAD (mesh→B-rep) panel and the GLB export path work unmodified.
//
// Pure and deterministic: one mesh, one primitive, POSITION + indices, no materials.

import type { VoxelMesh } from "./grid.js";

/** 4-byte-align `n` upward. */
const align4 = (n: number): number => (n + 3) & ~3;

/** Base64 of raw bytes without blowing the callstack (chunked fromCharCode). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Component-wise min/max of flat [x,y,z,…] vertices (required on POSITION accessors). */
function bounds(vertices: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = vertices[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * Encode a voxel surface mesh as a binary GLB. Layout: indices (uint32) then
 * positions (float32) in one buffer; JSON + BIN chunks 4-byte padded per spec.
 * Throws on an empty mesh — an empty sculpt has no surface to hand off.
 */
export function voxelMeshToGlb(mesh: VoxelMesh): Uint8Array {
  if (mesh.vertices.length === 0 || mesh.indices.length === 0) {
    throw new Error("voxel mesh is empty — sculpt at least one voxel before exporting");
  }
  const indices = new Uint32Array(mesh.indices);
  const positions = new Float32Array(mesh.vertices);
  const idxBytes = new Uint8Array(indices.buffer);
  const posBytes = new Uint8Array(positions.buffer);
  const idxLen = idxBytes.byteLength; // uint32 → already 4-byte aligned
  const binLen = idxLen + posBytes.byteLength;

  const { min, max } = bounds(mesh.vertices);
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "plastiq-voxel" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "voxel-sculpt" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: idxLen, target: 34963 },
      { buffer: 0, byteOffset: idxLen, byteLength: posBytes.byteLength, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5125, count: indices.length, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
    ],
  });

  const jsonBytes = new TextEncoder().encode(json);
  const jsonLen = align4(jsonBytes.byteLength); // pad JSON chunk with spaces (0x20)
  const binPadded = align4(binLen); // pad BIN chunk with zeros
  const total = 12 + 8 + jsonLen + 8 + binPadded;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // magic "glTF"
  dv.setUint32(4, 2, true); // version
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLen); // space padding
  const binHeader = 20 + jsonLen;
  dv.setUint32(binHeader, binPadded, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true); // "BIN\0"
  out.set(idxBytes, binHeader + 8);
  out.set(posBytes, binHeader + 8 + idxLen);
  return out;
}

/** The base64 form of {@link voxelMeshToGlb} — the `MeshDoc.glb` field shape. */
export function voxelMeshToGlbBase64(mesh: VoxelMesh): string {
  return bytesToBase64(voxelMeshToGlb(mesh));
}
