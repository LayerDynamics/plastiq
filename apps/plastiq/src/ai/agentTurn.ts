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
import type { AgentTools } from "./agentRunner.js";
import type { MeshProbe } from "./tools/inspectGeometry.js";
import type { ConfirmPaidJob, CreateMeshDeps } from "./tools/createMesh.js";
import type { AiSettings } from "./settings.js";
import type { GenImage } from "./meshgen/types.js";
import type { CadDocument } from "../store/types.js";
import type { TransferMesh } from "../worker/protocol.js";

/** The off-thread build seam the viewport publishes (build_part/inspect_geometry probe). */
export type BuildSeam = (doc: CadDocument) => Promise<TransferMesh | null>;

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
  const meshProbe: MeshProbe = (doc) => build(doc);
  const apply: ApplyDocument = (doc) => useCadStore.getState().loadDocument(doc);

  return buildAgentTools({
    buildPart: { probe, apply },
    probe: meshProbe,
    currentDoc: () => useCadStore.getState().toDocument(),
    createMesh: buildCreateMeshDeps(deps),
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
