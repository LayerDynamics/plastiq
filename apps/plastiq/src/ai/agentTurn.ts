// SPEC-6 R2.4 — shared agent-turn wiring (FR-19). Both AI entry points — the dockable
// GenerationPanel and the command-palette quick prompt — drive the SAME agentRunner with
// the SAME tools. Extracting the wiring here keeps them in lockstep: build_part +
// inspect_geometry over the live off-thread build seam, plus the creative create_mesh
// path (fal providers + paid-job confirm + persist as a new mesh project).

import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { useAiStore } from "./aiStore.js";
import { buildAgentTools } from "./tools/toolDefs.js";
import { buildMeshGenDeps } from "./meshGenDeps.js";
import { summarizePlan, type PlanGraph } from "./planning.js";
import { geometryClientProbe, type ApplyDocument } from "./tools/buildPart.js";
import { reconstructMesh, stepToImportDocument } from "./reconstruct.js";
import { fitMeshToCad } from "./nurbs.js";
import { meshFromPartialScan, meshFromPointCloud } from "./capture.js";
import type { AgentTools } from "./agentRunner.js";
import type { MeshProbe } from "./tools/inspectGeometry.js";
import type { ConfirmPaidJob, CreateMeshDeps } from "./tools/createMesh.js";
import type { MeshToCadDeps } from "./tools/meshToCad.js";
import type { CloudCaptureDeps } from "./tools/cloudCapture.js";
import type { AiSettings } from "./settings.js";
import type { GenImage } from "./meshgen/types.js";
import type { CadDocument } from "../store/types.js";
import type { BuildOutcome } from "../worker/bridge.js";

/** The off-thread build seam the viewport publishes (build_part/inspect_geometry probe).
 * Returns the isolating build's outcome: surviving geometry + every feature's fate. */
export type BuildSeam = (doc: CadDocument) => Promise<BuildOutcome>;

/** Read the live build seam, or null when the geometry worker isn't ready yet. */
export function buildSeam(): BuildSeam | null {
  return (globalThis as { __plastiqBuild?: BuildSeam }).__plastiqBuild ?? null;
}

export interface TurnToolsDeps {
  settings: AiSettings;
  /** Paid-job confirm gate for create_mesh (FR-18a). */
  confirm: ConfirmPaidJob;
  /** Count one billable job against the usage meter (after the gate). */
  recordPaidJob: () => void;
  /** Notified with the new project id when create_mesh persists a mesh document. */
  onMeshCreated?: (id: string) => void;
  /** Notified with the validated decomposition plan when the agent commits one via
   * plan_part (9-M1) — the live-UI hook (the panel renders it structured). The FULL
   * plan is recorded into the conversation trace here regardless, so a caller that
   * omits this (the command palette) still persists it. */
  onPlan?: (plan: PlanGraph) => void;
  /** Resolve an attached image by id (the img3d creative input). */
  resolveImage?: (id: string) => Promise<GenImage>;
  signal?: AbortSignal;
}

/** Build the full create_mesh dependency set from the turn deps + settings. Exposed so
 * the panel's direct image→3D path (which bypasses the LLM) reuses the SAME wiring as the
 * agent loop — fal providers, the paid-job confirm, persist-as-project, usage recording. */
export function buildCreateMeshDeps(deps: TurnToolsDeps): CreateMeshDeps {
  return {
    ...buildMeshGenDeps(deps.settings),
    ...(deps.resolveImage ? { resolveImage: deps.resolveImage } : {}),
    confirm: deps.confirm,
    persist: async (doc) => {
      const id = await useProjectsStore.getState().createMeshProject(doc);
      deps.onMeshCreated?.(id);
      return id;
    },
    recordPaidJob: deps.recordPaidJob,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

/** Build the mesh→CAD dependency set (reconstruct_brep / fit_nurbs). The open mesh is read from the
 * projects store at call time (so a mesh created earlier in the SAME turn is convertible), the local
 * reconstruct/NURBS wrappers resolve their base URL from settings, and a successful conversion lands
 * the STEP via loadDocument and leaves mesh mode — the same handoff the panel/context actions use. */
export function buildMeshToCadDeps(deps: TurnToolsDeps): MeshToCadDeps {
  return {
    mesh: () => useProjectsStore.getState().activeMeshDoc,
    reconstruct: reconstructMesh,
    fitNurbs: fitMeshToCad,
    stepToDoc: stepToImportDocument,
    load: (doc) => useCadStore.getState().loadDocument(doc),
    onConverted: (name) =>
      useProjectsStore.setState({ activeMeshDoc: null, currentId: null, currentName: name }),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

/** Point-cloud → mesh tools (cloud_to_mesh / complete_scan). Always wired so the agent can
 * convert a cloud opened earlier in the turn (T34). */
export function buildCloudCaptureDeps(deps: TurnToolsDeps): CloudCaptureDeps {
  return {
    cloud: () => useProjectsStore.getState().activePointCloudDoc,
    meshFromCloud: meshFromPointCloud,
    completeScan: meshFromPartialScan,
    persist: (doc) => useProjectsStore.getState().createMeshProject(doc),
    open: (id) => useProjectsStore.getState().open(id),
    ...(deps.settings.captureBaseURL ? { captureBaseURL: deps.settings.captureBaseURL } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

/** Wire the agent's tools to the live build seam, the projects store, and create_mesh.
 * Returns null when the geometry worker seam isn't ready yet (caller surfaces a hint) —
 * deliberately NO fallback client here: the Viewport owns the app's single geometry
 * worker, so before it publishes the seam there is nothing to build against, and the
 * callers' "viewport isn't ready" line is the honest UX. */
export function buildTurnTools(deps: TurnToolsDeps): AgentTools | null {
  const build = buildSeam();
  if (!build) return null;

  // The documented app probe (buildPart.geometryClientProbe) over the seam-published
  // GeometryClient.build — the same null-mesh/throw → structured-error mapping the
  // headless probe implements against the kernel directly.
  const probe = geometryClientProbe({ build });
  // inspect_geometry only reads the mesh; the per-feature statuses are the
  // build_part probe's concern (it must reject a partially-failed document).
  const meshProbe: MeshProbe = async (doc) => (await build(doc)).mesh;
  const apply: ApplyDocument = (doc) => useCadStore.getState().loadDocument(doc);

  return buildAgentTools({
    buildPart: { probe, apply },
    probe: meshProbe,
    currentDoc: () => useCadStore.getState().toDocument(),
    createMesh: buildCreateMeshDeps(deps),
    meshToCad: buildMeshToCadDeps(deps),
    cloudCapture: buildCloudCaptureDeps(deps),
    // 9-M1: a committed plan is recorded, not discarded — the FULL validated graph
    // goes into the per-project conversation trace as its own typed entry (the
    // generic tool lines truncate args at 200 chars; this one never truncates),
    // then the caller's UI hook (if any) renders it live.
    onPlan: (plan) => {
      void useAiStore
        .getState()
        .appendTrace({ kind: "plan", name: "plan_part", detail: summarizePlan(plan), plan });
      deps.onPlan?.(plan);
    },
  });
}
