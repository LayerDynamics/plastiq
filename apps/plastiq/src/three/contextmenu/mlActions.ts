// ML canvas context-menu actions: convert the open generated mesh (`activeMeshDoc`) into CAD via the
// self-hosted services — mesh→B-rep (reconstruct, :8000) or mesh→NURBS surfaces (nurbs, :8003) —
// landing the returned STEP through the SAME `loadDocument` path the GenerationPanel uses
// (GenerationPanel.tsx:320,381). Because both the context menu (contextOptions) and the RECM radial
// ring (recmContext) consume CONTEXT_ACTIONS, spreading these in surfaces them on BOTH at once.
//
// The async work is fired from `run()` (context-menu runs are `void`) with progress reported through
// the projects store's `status`. The actual logic lives in DI-injected `run*` fns so it unit-tests in
// Node with no WebGL / fetch / global stores (mirrors the codebase's createMesh/fitMeshToCad DI).

import type { CadDocument, MeshDoc } from "../../store/types.js";
import type { ContextAction } from "./config.js";
import { useProjectsStore } from "../../persistence/projectsStore.js";
import { useCadStore } from "../../store/store.js";
import { useAiStore } from "../../ai/aiStore.js";
import { reconstructMesh, stepToImportDocument } from "../../ai/reconstruct.js";
import { fitMeshToCad, NURBS_DEFAULT_BASE_URL, nurbsFitStatusMessage, nurbsUnreachableMessage } from "../../ai/nurbs.js";
import { RECONSTRUCT_DEFAULT_BASE_URL, checkServiceHealth, serviceUnreachableMessage } from "../../ai/errorHints.js";

export interface MlActionDeps {
  /** The mesh document to convert. */
  mesh: MeshDoc;
  reconstructBaseURL: string | undefined;
  nurbsBaseURL: string | undefined;
  /** Pre-flight GET /health so a down service fails fast with a "start it with…" hint. */
  checkHealth: (base: string) => Promise<boolean>;
  reconstruct: typeof reconstructMesh;
  fitNurbs: typeof fitMeshToCad;
  /** Land the reconstructed/fitted STEP as a parametric doc (useCadStore.loadDocument). */
  load: (doc: CadDocument) => void;
  /** Leave mesh mode + report the terminal status (the projects-store handoff the panel does). */
  finish: (name: string, status: string) => void;
  /** Progress line while the job runs. */
  setStatus: (s: string) => void;
}

/** Reconstruct the active mesh to an editable B-rep and load the STEP as a fresh parametric doc. */
export async function runReconstructBrep(deps: MlActionDeps): Promise<void> {
  const name = deps.mesh.name ?? "Reconstructed mesh";
  const base = (deps.reconstructBaseURL ?? RECONSTRUCT_DEFAULT_BASE_URL).replace(/\/+$/, "");
  deps.setStatus("checking reconstruct service…");
  if (!(await deps.checkHealth(base))) {
    deps.setStatus(serviceUnreachableMessage("reconstruct", base));
    return;
  }
  deps.setStatus("reconstructing B-rep…");
  const result = await deps.reconstruct(deps.mesh.glb, {
    ...(deps.reconstructBaseURL ? { baseURL: deps.reconstructBaseURL } : {}),
    onState: (s) => deps.setStatus(s),
  });
  deps.load(stepToImportDocument(result.step, name));
  const solid = result.report.is_solid ? "solid" : "shell";
  deps.finish(name, `reconstructed to CAD — ${result.report.faces_built} faces, ${solid}`);
}

/** Fit smooth NURBS surfaces to the active mesh and load the STEP as a fresh parametric doc. */
export async function runFitNurbs(deps: MlActionDeps): Promise<void> {
  const name = deps.mesh.name ?? "Fitted mesh";
  const base = (deps.nurbsBaseURL ?? NURBS_DEFAULT_BASE_URL).replace(/\/+$/, "");
  deps.setStatus("checking NURBS service…");
  if (!(await deps.checkHealth(base))) {
    deps.setStatus(nurbsUnreachableMessage(base));
    return;
  }
  deps.setStatus("fitting NURBS surfaces…");
  const { report } = await deps.fitNurbs(
    deps.mesh.glb,
    { load: deps.load },
    { ...(deps.nurbsBaseURL ? { baseURL: deps.nurbsBaseURL } : {}), onState: (s) => deps.setStatus(s) },
    name,
  );
  deps.finish(name, nurbsFitStatusMessage(report));
}

/** Wire the DI deps to the live stores/services for the active mesh; null when no mesh is open. */
export function liveMlDeps(): MlActionDeps | null {
  const mesh = useProjectsStore.getState().activeMeshDoc;
  if (!mesh) return null;
  const settings = useAiStore.getState().settings;
  return {
    mesh,
    reconstructBaseURL: settings?.reconstructBaseURL,
    nurbsBaseURL: settings?.nurbsBaseURL,
    checkHealth: checkServiceHealth,
    reconstruct: reconstructMesh,
    fitNurbs: fitMeshToCad,
    load: (doc) => useCadStore.getState().loadDocument(doc),
    finish: (name, status) =>
      useProjectsStore.setState({ activeMeshDoc: null, currentId: null, currentName: name, status }),
    setStatus: (s) => useProjectsStore.setState({ status: s }),
  };
}

/** Fire a run* fn against the live deps, surfacing any failure as the projects-store status. */
function runLive(fn: (deps: MlActionDeps) => Promise<void>): void {
  const deps = liveMlDeps();
  if (!deps) return;
  void fn(deps).catch((e: unknown) => {
    useProjectsStore.setState({ status: `failed: ${e instanceof Error ? e.message : String(e)}` });
  });
}

const hasMesh = (ctx: { activeMeshDoc: MeshDoc | null }): boolean => ctx.activeMeshDoc != null;

/** The mesh→CAD context actions (spread into CONTEXT_ACTIONS by config.ts). Visible only when a
 * generated mesh document is open; they surface in the context menu AND the RECM radial ring. */
export const ML_CONTEXT_ACTIONS: ContextAction[] = [
  {
    id: "ml-reconstruct-brep",
    group: "modify",
    label: () => "Reconstruct B-rep",
    visible: (ctx) => hasMesh(ctx),
    enabled: (ctx) => hasMesh(ctx),
    run: () => runLive(runReconstructBrep),
  },
  {
    id: "ml-fit-nurbs",
    group: "modify",
    label: () => "Fit NURBS surface",
    visible: (ctx) => hasMesh(ctx),
    enabled: (ctx) => hasMesh(ctx),
    run: () => runLive(runFitNurbs),
  },
];
