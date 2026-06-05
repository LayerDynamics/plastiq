// IGES interchange (SPEC-4 FR-33): export a solid to IGES text and import it
// back, via OCCT IGESControl_{Writer,Reader}. Like STEP it round-trips through
// the Emscripten in-memory FS; a malformed import yields a typed error (NFR-3).
//
// IGES is a surface-oriented format, so a solid imports back as its boundary
// (a shell) — topology and geometry are preserved, but the result is not
// guaranteed to be a closed solid the way STEP is. STEP is preferred for solids;
// IGES is provided for interoperability with surface-centric CAD.

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

interface EmscriptenFS {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  unlink(path: string): void;
}

function fs(oc: Occt): EmscriptenFS {
  return (oc as unknown as { FS: EmscriptenFS }).FS;
}

let seq = 0;
function tempPath(): string {
  seq += 1;
  return `/cad_iges_${seq}.iges`;
}

function isDone(oc: Occt, status: unknown): boolean {
  return status === oc.IFSelect_ReturnStatus.IFSelect_RetDone;
}

/** Serialize `solid` to IGES text. Throws if OCCT cannot add/write it. */
export function exportIges(oc: Occt, solid: Solid): string {
  const path = tempPath();
  const writer = new oc.IGESControl_Writer_1();
  const range = new oc.Message_ProgressRange_1();
  try {
    if (!writer.AddShape(solid.shape, range)) {
      throw new Error("IGES export: AddShape failed");
    }
    writer.ComputeModel();
    if (!writer.Write_2(path, false)) {
      throw new Error("IGES export: write failed");
    }
    return fs(oc).readFile(path, { encoding: "utf8" });
  } finally {
    range.delete();
    writer.delete();
    try {
      fs(oc).unlink(path);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Parse IGES `text` into a `Solid` (its boundary geometry). Throws a typed error
 * (NFR-3) on malformed input, no transferable roots, or a null shape. The
 * returned solid is owned by the caller (`.delete()` it).
 */
export function importIges(oc: Occt, text: string): Solid {
  const path = tempPath();
  fs(oc).writeFile(path, text);
  const reader = new oc.IGESControl_Reader_1();
  const range = new oc.Message_ProgressRange_1();
  try {
    if (!isDone(oc, reader.ReadFile(path))) {
      throw new Error("IGES import: malformed file (read failed)");
    }
    if (reader.NbRootsForTransfer() < 1) {
      throw new Error("IGES import: no transferable roots");
    }
    reader.TransferRoots(range);
    const shape = reader.OneShape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("IGES import: produced a null shape");
    }
    return new Solid(oc, shape);
  } finally {
    range.delete();
    reader.delete();
    try {
      fs(oc).unlink(path);
    } catch {
      // best-effort cleanup
    }
  }
}
