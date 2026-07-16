// Canvas drag-and-drop routing (SPEC-13, Task #13). Classify files dropped on the 3D canvas by type
// and route them to the right pipeline, all landing on the SAME canvas as a project:
//   • a folder of photos (≥3)      → photogrammetry solve → dense PointCloudDoc (shown in the cloud
//                                     viewer; then cloud→mesh→CAD via the #12/#8 context actions)
//   • a .ply / .xyz / .json cloud  → parsed straight into a PointCloudDoc
// The classify + route logic is PURE and dependency-injected (typed over a minimal DroppedFile, so it
// unit-tests in Node with no DOM); the live DOM wiring is CanvasDropZone.tsx.

import type { PointCloudDoc } from "../store/types.js";

/** The minimal file shape the router classifies by (the browser's File satisfies it). */
export interface DroppedFile {
  name: string;
  type: string;
}

/** Point-cloud file extensions we parse directly (the @plastiq/capture parsers). */
export const CLOUD_EXTS = /\.(ply|xyz|json)$/i;
/** Image extensions (a fallback when a File carries no MIME type, e.g. some folder drops). */
export const IMAGE_EXTS = /\.(jpe?g|png|webp|tiff?|bmp)$/i;
/** Photogrammetry needs at least this many views to solve (SfM triangulation). */
export const MIN_DROP_PHOTOS = 3;

export type DropRoute = "cloud" | "photos" | "unsupported";

const isCloudFile = (f: DroppedFile): boolean => CLOUD_EXTS.test(f.name);
const isImageFile = (f: DroppedFile): boolean => f.type.startsWith("image/") || IMAGE_EXTS.test(f.name);

/** Classify a set of dropped files. A point-cloud file wins (a single file, parsed immediately);
 * otherwise enough images route to photogrammetry; anything else is unsupported. */
export function classifyDrop(files: DroppedFile[]): DropRoute {
  if (files.some(isCloudFile)) return "cloud";
  if (files.filter(isImageFile).length >= MIN_DROP_PHOTOS) return "photos";
  return "unsupported";
}

export interface DropRouteDeps<F extends DroppedFile = DroppedFile> {
  /** Read a cloud file as UTF-8 text. */
  readText: (f: F) => Promise<string>;
  /** Read an image as base64 (photogrammetry input). */
  readBase64: (f: F) => Promise<string>;
  /** Parse a cloud file (name + text) → a PointCloudDoc. */
  parseCloudFile: (fileName: string, text: string) => PointCloudDoc;
  /** Solve a set of photos → a dense PointCloudDoc (health-check + solve + parse). */
  solvePhotos: (images: { name: string; data: string }[]) => Promise<PointCloudDoc>;
  /** Persist a cloud as a new project, returning its id. */
  persistCloud: (doc: PointCloudDoc) => Promise<string>;
  /** Open the new project (shows it on the canvas). */
  open: (id: string) => Promise<void>;
  setStatus: (s: string) => void;
}

/** Route dropped files to the right pipeline and open the result as a project. Any failure (parse
 * error, service down, solve failure) is surfaced on the status line — never thrown to the DOM. */
export async function routeDroppedFiles<F extends DroppedFile>(files: F[], deps: DropRouteDeps<F>): Promise<void> {
  const route = classifyDrop(files);
  if (route === "unsupported") {
    deps.setStatus("Drop a folder of photos (≥3), or a .ply / .xyz / .json point cloud.");
    return;
  }
  try {
    let doc: PointCloudDoc;
    if (route === "cloud") {
      const file = files.find(isCloudFile)!;
      deps.setStatus(`loading ${file.name}…`);
      doc = deps.parseCloudFile(file.name, await deps.readText(file));
    } else {
      const images = files.filter(isImageFile);
      deps.setStatus(`solving ${images.length} photos (SfM + MVS — minutes)…`);
      const payload = await Promise.all(images.map(async (f) => ({ name: f.name, data: await deps.readBase64(f) })));
      doc = await deps.solvePhotos(payload);
    }
    const id = await deps.persistCloud(doc);
    await deps.open(id);
    deps.setStatus(`opened point cloud '${doc.name ?? "cloud"}' (${Math.floor(doc.points.length / 3)} points)`);
  } catch (e) {
    deps.setStatus(`import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
