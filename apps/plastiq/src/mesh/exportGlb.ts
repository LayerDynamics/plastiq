// SPEC-6 FR-18 — export a mesh document's inline base64 GLB to disk (.glb download).
//
// A generated mesh document stores its model as an inline base64 GLB (store/types.ts
// `MeshDoc.glb`). The parametric export seam (`__plastiqExport`) only handles a B-rep
// `CadDocument` through the OCCT worker, so a mesh document needs its own binary download
// path — this is it. The DOM hooks are injectable so the decode + filename + download
// wiring is unit-testable without a real browser (jsdom does not implement
// `URL.createObjectURL`).

/** Decode a base64 string to raw bytes (browser-safe). Backed by a plain `ArrayBuffer` so
 * the result is a valid `BlobPart` under strict lib types. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A minimal anchor surface (so tests need not depend on a real DOM element). */
export interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
}

export interface ExportGlbDeps {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  createAnchor?: () => DownloadAnchor;
  /** Defer revoke; tests pass a synchronous runner. Defaults to setTimeout(…, 0). */
  schedule?: (fn: () => void) => void;
}

/** Normalise a document name into a `*.glb` filename. */
export function glbFileName(name: string | undefined): string {
  const base = (name ?? "mesh").trim() || "mesh";
  return /\.glb$/i.test(base) ? base : `${base}.glb`;
}

/** Download a mesh document's base64 GLB as a binary `.glb` file. Returns the filename
 * used (handy for tests + status messages). */
export function exportMeshGlb(glbBase64: string, name?: string, deps: ExportGlbDeps = {}): string {
  const bytes = base64ToBytes(glbBase64);
  const blob = new Blob([bytes], { type: "model/gltf-binary" });
  const createUrl = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  const makeAnchor = deps.createAnchor ?? (() => document.createElement("a") as DownloadAnchor);
  const schedule = deps.schedule ?? ((fn: () => void) => setTimeout(fn, 0));

  const url = createUrl(blob);
  const anchor = makeAnchor();
  anchor.href = url;
  anchor.download = glbFileName(name);
  anchor.click();
  schedule(() => revokeUrl(url));
  return anchor.download;
}
