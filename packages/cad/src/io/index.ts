// Interchange I/O — STEP / IGES via OCCT writers/readers (B-rep exact), and a
// minimal glTF 2.0 emitter built from the tagged tessellation (mesh export).
//
// OCCT writes to its in-memory Emscripten FS; we read the result back out.

import type { STEPControl_StepModelType } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { TessellateOptions } from "../mesh/tagged.js";

function assertDone(oc: Occt, status: unknown, what: string): void {
  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error(`${what} failed (OCCT return status not RetDone)`);
  }
}

/** Export a solid to STEP (AP214) text. */
export function exportStep(oc: Occt, solid: Solid): string {
  const writer = new oc.STEPControl_Writer_1();
  const progress = new oc.Message_ProgressRange_1();
  const path = "/plastiq-export.step";
  try {
    const status = writer.Transfer(
      solid.shape,
      oc.STEPControl_StepModelType.STEPControl_AsIs as unknown as STEPControl_StepModelType,
      true,
      progress,
    );
    assertDone(oc, status, "STEP transfer");
    assertDone(oc, writer.Write(path), "STEP write");
    return oc.FS.readFile(path, { encoding: "utf8" });
  } finally {
    progress.delete();
    writer.delete();
  }
}

/** Import a STEP text as a single base body. */
export function importStep(oc: Occt, text: string): Solid {
  const path = "/plastiq-import.step";
  oc.FS.writeFile(path, text);
  const reader = new oc.STEPControl_Reader_1();
  const progress = new oc.Message_ProgressRange_1();
  try {
    assertDone(oc, reader.ReadFile(path), "STEP read");
    reader.TransferRoots(progress);
    const shape = reader.OneShape();
    if (shape.IsNull()) throw new Error("STEP import produced an empty shape");
    return new Solid(oc, shape);
  } finally {
    progress.delete();
    reader.delete();
  }
}

/** Export a solid to IGES text. */
export function exportIges(oc: Occt, solid: Solid): string {
  const writer = new oc.IGESControl_Writer_1();
  const progress = new oc.Message_ProgressRange_1();
  const path = "/plastiq-export.igs";
  try {
    if (!writer.AddShape(solid.shape, progress)) {
      throw new Error("IGES AddShape failed");
    }
    writer.ComputeModel();
    // Write_2(file, fnes) writes to a path in the OCCT virtual FS.
    if (!writer.Write_2(path, false)) throw new Error("IGES write failed");
    return oc.FS.readFile(path, { encoding: "utf8" });
  } finally {
    progress.delete();
    writer.delete();
  }
}

function toBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    btoa?: (s: string) => string;
    Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
  };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  if (!g.btoa) throw new Error("no base64 encoder available");
  return g.btoa(binary);
}

/**
 * Export a solid to a self-contained glTF 2.0 document (positions + indices,
 * one mesh, embedded base64 buffer). Triangles come from the tagged
 * tessellation; this is a mesh export, not a B-rep one (use STEP for B-rep).
 */
export function exportGltf(oc: Occt, solid: Solid, opts?: TessellateOptions): string {
  const mesh = tessellateTagged(oc, solid, opts);
  const positions = Float32Array.from(mesh.vertices);
  const indices = Uint32Array.from(mesh.indices);

  // Pad the position buffer to a 4-byte boundary before the index view.
  const posBytes = positions.byteLength;
  const idxOffset = posBytes; // both are 4-byte aligned already
  const buffer = new Uint8Array(posBytes + indices.byteLength);
  buffer.set(new Uint8Array(positions.buffer), 0);
  buffer.set(new Uint8Array(indices.buffer), idxOffset);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!);
    maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!);
    maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  const vertexCount = positions.length / 3;

  const gltf = {
    asset: { version: "2.0", generator: "@plastiq/cad" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [
      {
        byteLength: buffer.byteLength,
        uri: `data:application/octet-stream;base64,${toBase64(buffer)}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: "VEC3",
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      {
        bufferView: 1,
        componentType: 5125, // UNSIGNED_INT
        count: indices.length,
        type: "SCALAR",
      },
    ],
  };
  return JSON.stringify(gltf);
}
