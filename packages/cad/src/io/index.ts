// Interchange I/O — STEP / IGES via OCCT writers/readers (B-rep exact), and a
// minimal glTF 2.0 emitter built from the tagged tessellation (mesh export).
//
// OCCT writes to its in-memory Emscripten FS; we read the result back out.
//
// UNITS (I1) — why every STEP/IGES boundary scales
// ------------------------------------------------
// The kernel works in SI METRES. OCCT's STEP writer does NOT convert: it writes
// each coordinate's raw number and separately DECLARES the file's unit, which
// defaults to millimetre. Measured on a 40×30×20 mm box (0.04 × 0.03 × 0.02 in
// kernel units), the emitted file contained:
//
//     #346 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
//     #25  = CARTESIAN_POINT('',(0.,0.,2.E-02));
//
// i.e. it told every other CAD system the part is 0.02 mm tall when it is 20 mm
// — exactly 1000× too small. The mirror-image defect on import: OCCT's reader
// converts a file into its target unit, which is also millimetre, so a
// real-world mm STEP hands back 40 for 40 mm and the kernel reads it as 40
// METRES — 1000× too large.
//
// This was invisible because the round trip is consistently wrong in both
// directions: io.test.ts re-imported our own export and got the right volume
// back. Only a file crossing the boundary — in either direction — is affected,
// which is precisely the case a self-round-trip cannot see.
//
// The fix scales the shape at the boundary rather than configuring OCCT.
// Interface_Static ("write.step.unit" / "xstep.cascade.unit") is the normal
// mechanism and it is NOT available: the class binds, but embind exposes no
// statics on it, so SetCVal does not exist at runtime (pinned by
// oc/bindings.test.ts). Scaling needs no kernel config and is directly testable.

import type { STEPControl_StepModelType } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { IDENTITY_PLACEMENT, type Placement } from "../lower/component.js";
import { scale } from "../action/transform.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { TessellateOptions } from "../mesh/tagged.js";

/**
 * Kernel metres → interchange millimetres.
 *
 * OCCT's STEP/IGES writers declare MILLIMETRE and its readers convert INTO
 * millimetre, so this is the factor on both sides of every boundary.
 */
const M_TO_MM = 1000;

function assertDone(oc: Occt, status: unknown, what: string): void {
  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error(`${what} failed (OCCT return status not RetDone)`);
  }
}

/**
 * Export one or more solids to a single STEP (AP214) text, in MILLIMETRES (the
 * unit OCCT declares).
 *
 * Multi-body is native: `STEPControl_Writer.Transfer` accumulates into the
 * writer's model, so N calls followed by one `Write` emit N bodies in one file
 * — each keeping its own identity. (A hand-built `TopoDS_Compound` is also
 * available — `BRep_Builder`/`TopoDS_Builder` ARE bound, as `makeCompound`
 * in solid/solid.ts uses them, and a compound holds its members separately
 * WITHOUT welding — but transferring the solids one at a time keeps this writer
 * path simple and each body independently addressable in the STEP model.)
 *
 * Each solid is scaled m → mm first so the numbers written match the declared
 * unit; the callers' solids are untouched (scale returns independent copies).
 * Solids must already carry their world pose — a uniform scale about the origin
 * scales the pose translation with the geometry, so the unit contract holds.
 */
export function exportStepAssembly(oc: Occt, solids: readonly Solid[]): string {
  if (solids.length === 0) throw new Error("exportStep: nothing to export (no solids)");
  const writer = new oc.STEPControl_Writer_1();
  const progress = new oc.Message_ProgressRange_1();
  const path = "/plastiq-export.step";
  // Every scaled copy is freed even if a mid-loop transfer throws (long-lived worker).
  const mmSolids: Solid[] = [];
  try {
    for (const solid of solids) {
      const mm = scale(oc, solid, M_TO_MM);
      mmSolids.push(mm);
      const status = writer.Transfer(
        mm.shape,
        oc.STEPControl_StepModelType.STEPControl_AsIs as unknown as STEPControl_StepModelType,
        true,
        progress,
      );
      assertDone(oc, status, "STEP transfer");
    }
    assertDone(oc, writer.Write(path), "STEP write");
    return oc.FS.readFile(path, { encoding: "utf8" });
  } finally {
    for (const s of mmSolids) s.delete();
    progress.delete();
    writer.delete();
  }
}

/** Export a single solid to STEP text — `exportStepAssembly` with one body. */
export function exportStep(oc: Occt, solid: Solid): string {
  return exportStepAssembly(oc, [solid]);
}

/**
 * Import a STEP text as a single base body, converting mm → kernel metres.
 *
 * OCCT's reader normalises whatever unit the file declares into millimetres, so
 * the inverse scale here is unconditional — it is correct for a file declaring
 * inches or metres just as much as one declaring mm.
 */
export function importStep(oc: Occt, text: string): Solid {
  const path = "/plastiq-import.step";
  oc.FS.writeFile(path, text);
  const reader = new oc.STEPControl_Reader_1();
  const progress = new oc.Message_ProgressRange_1();
  try {
    assertDone(oc, reader.ReadFile(path), "STEP read");
    reader.TransferRoots(progress);
    const shape = reader.OneShape();
    // `OneShape()` is an owned embind handle even when null — free it before the
    // failure throw (the boolean.ts `finish()` convention) or it leaks in the
    // long-lived worker. On success the Solid takes ownership instead.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("STEP import produced an empty shape");
    }
    const mmSolid = new Solid(oc, shape);
    try {
      return scale(oc, mmSolid, 1 / M_TO_MM);
    } finally {
      mmSolid.delete();
    }
  } finally {
    progress.delete();
    reader.delete();
  }
}

/**
 * Export a solid to IGES text, in MILLIMETRES.
 *
 * Same unit contract as STEP: IGESControl_Writer's default unit is millimetre
 * and it writes raw coordinates, so the shape is scaled m → mm first.
 */
export function exportIgesAssembly(oc: Occt, solids: readonly Solid[]): string {
  if (solids.length === 0) throw new Error("exportIges: nothing to export (no solids)");
  const writer = new oc.IGESControl_Writer_1();
  const progress = new oc.Message_ProgressRange_1();
  const path = "/plastiq-export.igs";
  const mmSolids: Solid[] = [];
  try {
    // AddShape accumulates, like STEP's Transfer — N bodies, one file.
    for (const solid of solids) {
      const mm = scale(oc, solid, M_TO_MM);
      mmSolids.push(mm);
      if (!writer.AddShape(mm.shape, progress)) throw new Error("IGES AddShape failed");
    }
    writer.ComputeModel();
    // Write_2(file, fnes) writes to a path in the OCCT virtual FS.
    if (!writer.Write_2(path, false)) throw new Error("IGES write failed");
    return oc.FS.readFile(path, { encoding: "utf8" });
  } finally {
    for (const s of mmSolids) s.delete();
    progress.delete();
    writer.delete();
  }
}

/** Export a single solid to IGES text — `exportIgesAssembly` with one body. */
export function exportIges(oc: Occt, solid: Solid): string {
  return exportIgesAssembly(oc, [solid]);
}

/**
 * Import an IGES text as a single base body, converting the reader's
 * millimetres into kernel metres. This mirrors `importStep`: OCCT transfers all
 * roots into one shape, which may itself contain multiple independent bodies.
 */
export function importIges(oc: Occt, text: string): Solid {
  const path = "/plastiq-import.igs";
  oc.FS.writeFile(path, text);
  const reader = new oc.IGESControl_Reader_1();
  const progress = new oc.Message_ProgressRange_1();
  try {
    assertDone(oc, reader.ReadFile(path), "IGES read");
    reader.TransferRoots(progress);
    const shape = reader.OneShape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("IGES import produced an empty shape");
    }
    const mmSolid = new Solid(oc, shape);
    try {
      return scale(oc, mmSolid, 1 / M_TO_MM);
    } finally {
      mmSolid.delete();
    }
  } finally {
    progress.delete();
    reader.delete();
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
 * Export a solid to a self-contained glTF 2.0 document as N posed INSTANCES:
 * one mesh (a single tessellation of the shared part) referenced by one node
 * per placement, each carrying its own TRS. glTF's node transform is exactly
 * the right representation here — the geometry is transmitted once regardless
 * of instance count, and a viewer sees a real assembly rather than a single
 * body (§2.11.2). Placements are the instances' WORLD poses, in kernel metres
 * (glTF is unitless-metres by convention, so no scaling — unlike STEP/IGES).
 *
 * `exportGltf` is this with one identity placement.
 */
export function exportGltfAssembly(
  oc: Occt,
  solid: Solid,
  placements: readonly Placement[],
  opts?: TessellateOptions,
): string {
  if (placements.length === 0) throw new Error("exportGltf: nothing to export (no placements)");
  return buildGltf(oc, solid, placements, opts);
}

/**
 * Export a solid to a self-contained glTF 2.0 document (positions + indices,
 * one mesh, embedded base64 buffer). Triangles come from the tagged
 * tessellation; this is a mesh export, not a B-rep one (use STEP for B-rep).
 */
export function exportGltf(oc: Occt, solid: Solid, opts?: TessellateOptions): string {
  return buildGltf(oc, solid, [IDENTITY_PLACEMENT], opts);
}

function buildGltf(
  oc: Occt,
  solid: Solid,
  placements: readonly Placement[],
  opts?: TessellateOptions,
): string {
  const mesh = tessellateTagged(oc, solid, opts);
  // A face that failed to triangulate is omitted from the mesh; exporting the
  // shorter mesh would ship a glTF with a hole as if it were the full part. Refuse
  // rather than deliver a silently-incomplete artifact (the caller surfaces this).
  if (mesh.droppedFaces > 0) {
    throw new Error(
      `exportGltf: ${mesh.droppedFaces} face(s) failed to triangulate — the glTF would be incomplete (a hole in the surface)`,
    );
  }
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

  // One node per placement, all referencing the single shared mesh. A node omits
  // an identity component so a plain single-body export stays byte-identical to
  // the pre-assembly emitter.
  const nodes = placements.map((p) => {
    const node: { mesh: number; translation?: number[]; rotation?: number[] } = { mesh: 0 };
    const [px, py, pz] = p.position;
    if (px !== 0 || py !== 0 || pz !== 0) node.translation = [px, py, pz];
    const [qx, qy, qz, qw] = p.orientation;
    if (qx !== 0 || qy !== 0 || qz !== 0 || qw !== 1) node.rotation = [qx, qy, qz, qw];
    return node;
  });

  const gltf = {
    asset: { version: "2.0", generator: "@plastiq/cad" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
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
