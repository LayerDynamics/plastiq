// GPU color-id picking codec (SPEC-5 NFR-4). Each pickable entity id is rendered
// to an offscreen buffer as a unique RGB colour; the pixel under the cursor is
// read back and decoded to the id — a robust fallback to ray/triangle picking
// for dense or thin geometry.
//
// Ids are stored as `id + 1` so that the cleared (black) buffer — RGB (0,0,0) —
// decodes to `null` (a miss), letting entity id 0 still be picked. The encoding
// is a plain 24-bit pack, so it survives any byte-exact readback (the render pass
// must avoid tone-mapping / sRGB conversion for these bytes to match — see
// SceneController's id ShaderMaterial + non-sRGB render target).

/** Encode a non-negative entity id as an RGB byte triple (id stored as id+1). */
export function encodeId(id: number): [number, number, number] {
  const v = (id + 1) & 0xffffff;
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Decode an RGB byte triple to its entity id, or null for the clear colour. */
export function decodeId(r: number, g: number, b: number): number | null {
  const v = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  return v === 0 ? null : v - 1;
}

/** Encode an id as normalised [0,1] RGB floats (a vertex `idColor` attribute). */
export function encodeIdFloat(id: number): [number, number, number] {
  const [r, g, b] = encodeId(id);
  return [r / 255, g / 255, b / 255];
}
