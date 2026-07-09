import type { MeshBody } from "./meshBody.js";

const align4 = (n: number): number => (n + 3) & ~3;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/** Encode edited triangle mesh bodies as a minimal binary glTF 2.0 GLB. */
export function meshBodiesToGlb(bodies: readonly MeshBody[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  let byteOffset = 0;

  bodies.forEach((body, bodyIndex) => {
    if (body.indices.length === 0 || body.positions.length === 0) return;
    const indices = new Uint32Array(body.indices);
    const positions = new Float32Array(body.positions);
    const idxBytes = new Uint8Array(indices.buffer);
    const posBytes = new Uint8Array(positions.buffer);

    const idxView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBytes.byteLength, target: 34963 });
    chunks.push(idxBytes);
    byteOffset += idxBytes.byteLength;

    const posView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: posBytes.byteLength, target: 34962 });
    chunks.push(posBytes);
    byteOffset += posBytes.byteLength;

    const idxAccessor = accessors.length;
    accessors.push({ bufferView: idxView, componentType: 5125, count: indices.length, type: "SCALAR" });
    const posAccessor = accessors.length;
    accessors.push({
      bufferView: posView,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      ...bounds(positions),
    });
    const meshIndex = meshes.length;
    meshes.push({ primitives: [{ attributes: { POSITION: posAccessor }, indices: idxAccessor }] });
    nodes.push({ mesh: meshIndex, name: `mesh-body-${bodyIndex}` });
  });

  if (meshes.length === 0) throw new Error("mesh document has no triangle geometry to encode");

  const binLen = byteOffset;
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "plastiq-mesh-edit" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, i) => i) }],
    nodes,
    meshes,
    buffers: [{ byteLength: binLen }],
    bufferViews,
    accessors,
  });

  const jsonBytes = new TextEncoder().encode(json);
  const jsonLen = align4(jsonBytes.byteLength);
  const binPadded = align4(binLen);
  const total = 12 + 8 + jsonLen + 8 + binPadded;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLen);
  const binHeader = 20 + jsonLen;
  dv.setUint32(binHeader, binPadded, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  let outOffset = binHeader + 8;
  for (const chunk of chunks) {
    out.set(chunk, outOffset);
    outOffset += chunk.byteLength;
  }
  return out;
}

export function meshBodiesToGlbBase64(bodies: readonly MeshBody[]): string {
  return bytesToBase64(meshBodiesToGlb(bodies));
}
