// STEP interchange (SPEC-4 FR-33): export a solid to STEP (AP203/214) text and
// import it back, via OCCT STEPControl_{Writer,Reader}. STEP is the canonical
// neutral B-rep format, so topology + geometry survive the round-trip (verified
// to preserve volume within tolerance). A malformed/empty import yields a typed
// error rather than a null/invalid shape (NFR-3).
//
// ocjs has no real disk; OCCT reads/writes paths in the Emscripten in-memory FS,
// so we round-trip through a unique virtual path and return/accept the bytes.

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

// Deterministic unique virtual paths (no Math.random — NFR-2).
let seq = 0;
function tempPath(ext: string): string {
  seq += 1;
  return `/cad_io_${seq}.${ext}`;
}

function isDone(oc: Occt, status: unknown): boolean {
  return status === oc.IFSelect_ReturnStatus.IFSelect_RetDone;
}

/** Serialize `solid` to STEP text. Throws if OCCT cannot transfer/write it. */
export function exportStep(oc: Occt, solid: Solid): string {
  const path = tempPath("step");
  const writer = new oc.STEPControl_Writer_1();
  const range = new oc.Message_ProgressRange_1();
  try {
    const transfer = writer.Transfer(
      solid.shape,
      oc.STEPControl_StepModelType.STEPControl_AsIs as never,
      true,
      range,
    );
    if (!isDone(oc, transfer)) throw new Error("STEP export: shape transfer failed");
    const written = writer.Write(path);
    if (!isDone(oc, written)) throw new Error("STEP export: write failed");
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
 * Parse STEP `text` into a `Solid`. Throws a typed error (NFR-3) on malformed
 * input, a file with no transferable roots, or a null/invalid resulting shape.
 * The returned solid is owned by the caller (`.delete()` it).
 */
export function importStep(oc: Occt, text: string): Solid {
  const path = tempPath("step");
  fs(oc).writeFile(path, text);
  const reader = new oc.STEPControl_Reader_1();
  const range = new oc.Message_ProgressRange_1();
  try {
    if (!isDone(oc, reader.ReadFile(path))) {
      throw new Error("STEP import: malformed file (read failed)");
    }
    if (reader.NbRootsForTransfer() < 1) {
      throw new Error("STEP import: no transferable roots");
    }
    reader.TransferRoots(range);
    const shape = reader.OneShape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("STEP import: produced a null shape");
    }
    const solid = new Solid(oc, shape);
    if (!solid.isValid()) {
      solid.delete();
      throw new Error("STEP import: produced an invalid solid");
    }
    return solid;
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
