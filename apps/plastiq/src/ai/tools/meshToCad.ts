// SPEC-7 / SPEC-12 — the mesh→CAD agent tools: `reconstruct_brep` and `fit_nurbs`. These are the
// INVERSE of create_mesh: instead of generating a new mesh, they CONSUME the currently open generated
// mesh document (activeMeshDoc) and turn it into an editable parametric B-rep (STEP), landing it
// through the SAME loadDocument seam build_part uses. That makes the full agent chain possible in one
// turn: create_mesh (organic GLB) → reconstruct_brep / fit_nurbs (editable CAD).
//
// Both mirror createMesh's contract: args validated with zod, every side effect injected (so they
// unit-test in node with fakes — no service, no stores), and any failure returned as a STRUCTURED
// result the model can read and self-correct against (never a throw across the tool boundary).
//
//   • reconstruct_brep — local reconstruct service (OCCT mesh→B-rep; analytic routes → fitted/faceted
//     fallback). Best for mechanical/planar meshes. Optional `method` picks the route.
//   • fit_nurbs        — local NURBS service (fit smooth NURBS surfaces). Best for organic/freeform
//     meshes where smooth surfaces beat planar reconstruction.

import { z } from "zod";
import type { CadDocument, MeshDoc } from "../../store/types.js";
import type { reconstructMesh, stepToImportDocument } from "../reconstruct.js";
import type { fitMeshToCad } from "../nurbs.js";

/** `reconstruct_brep` args (§7.1): only an optional reconstruction route; the mesh is the open doc. */
const reconstructBrepArgsSchema = z.object({
  method: z.enum(["auto", "fitted", "faceted"]).optional(),
});

/** `fit_nurbs` args: none — it operates on the open mesh document. */
const fitNurbsArgsSchema = z.object({});

export interface MeshToCadResult {
  status: "ok" | "error";
  /** Short user-facing message (also returned to the model as the tool result). */
  message: string;
  /** Structured failure detail for the model to self-correct. */
  errors?: string;
}

/** Everything the two mesh→CAD tools need, injected so they test without services/stores. */
export interface MeshToCadDeps {
  /** The open generated mesh document to convert, or null when none is open. */
  mesh: () => MeshDoc | null;
  /** Reconstruct a mesh GLB (base64) → STEP + report via the reconstruct service (ai/reconstruct). */
  reconstruct: typeof reconstructMesh;
  /** Fit NURBS surfaces to a mesh GLB (base64); loads the STEP via the passed `load` and returns the
   * report (ai/nurbs.fitMeshToCad — it lands the doc itself, so `load` is threaded through). */
  fitNurbs: typeof fitMeshToCad;
  /** Wrap reconstruct STEP text → a CadDocument (ai/reconstruct.stepToImportDocument). */
  stepToDoc: typeof stepToImportDocument;
  /** Land the resulting CAD document (useCadStore.loadDocument). */
  load: (doc: CadDocument) => void;
  /** Called after a successful conversion so the app can leave mesh mode (clear activeMeshDoc). */
  onConverted?: (name: string) => void;
  /** Cancels the operation at the next boundary. */
  signal?: AbortSignal;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function argError(err: z.ZodError, tool: string): MeshToCadResult {
  return {
    status: "error",
    message: `The ${tool} arguments did not validate.`,
    errors: err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; "),
  };
}

/** Reconstruct the open mesh document into an editable B-rep (STEP) and load it as a parametric doc. */
export async function reconstructBrep(input: unknown, deps: MeshToCadDeps): Promise<MeshToCadResult> {
  const parsed = reconstructBrepArgsSchema.safeParse(input);
  if (!parsed.success) return argError(parsed.error, "reconstruct_brep");

  const mesh = deps.mesh();
  if (!mesh) {
    return { status: "error", message: "No mesh document is open to reconstruct — generate one with create_mesh (or open a mesh project) first." };
  }
  const name = mesh.name ?? "Reconstructed mesh";

  let result;
  try {
    result = await deps.reconstruct(mesh.glb, {
      ...(parsed.data.method ? { method: parsed.data.method } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (e) {
    return { status: "error", message: "The mesh→B-rep reconstruction failed.", errors: errMessage(e) };
  }

  try {
    deps.load(deps.stepToDoc(result.step, name));
  } catch (e) {
    return { status: "error", message: "Loading the reconstructed STEP as a CAD document failed.", errors: errMessage(e) };
  }
  deps.onConverted?.(name);

  const solid = result.report.is_solid ? "solid" : "shell";
  return {
    status: "ok",
    message: `Reconstructed '${name}' to an editable B-rep — ${result.report.faces_built} faces, ${solid}.`,
  };
}

/** Fit smooth NURBS surfaces to the open mesh document and load the result as a parametric doc. */
export async function fitNurbs(input: unknown, deps: MeshToCadDeps): Promise<MeshToCadResult> {
  const parsed = fitNurbsArgsSchema.safeParse(input);
  if (!parsed.success) return argError(parsed.error, "fit_nurbs");

  const mesh = deps.mesh();
  if (!mesh) {
    return { status: "error", message: "No mesh document is open to fit — generate one with create_mesh (or open a mesh project) first." };
  }
  const name = mesh.name ?? "Fitted mesh";

  let report;
  try {
    ({ report } = await deps.fitNurbs(mesh.glb, { load: deps.load }, { ...(deps.signal ? { signal: deps.signal } : {}) }, name));
  } catch (e) {
    return { status: "error", message: "The NURBS surface fit failed.", errors: errMessage(e) };
  }
  deps.onConverted?.(name);

  const solid = report.isSolid ? "solid" : "shell";
  return {
    status: "ok",
    message: `Fitted smooth NURBS surfaces to '${name}' → editable CAD — ${report.patches} patches, ${solid}.`,
  };
}
