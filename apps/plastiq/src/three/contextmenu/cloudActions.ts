// Point-cloud canvas context actions (SPEC-13, Task #12): convert the open dense point-cloud document
// (`activePointCloudDoc`) into a mesh via the local capture service — "Point cloud → mesh" (/capture,
// oriented cloud → watertight mesh) or "Complete partial scan" (/complete, partial cloud → full mesh).
// Both persist a MeshDoc through createMeshProject and OPEN it, so the mesh view + the existing
// "Convert to CAD" (reconstruct/NURBS) path take over — the same handoff denseCloudToMeshDoc uses in
// the panel. Like mlActions the async work fires from run() with progress on the projects-store
// status, and the logic lives in DI-injected run* fns so it unit-tests with no service/stores.

import type { MeshDoc, PointCloudDoc } from "../../store/types.js";
import type { ContextAction } from "./config.js";
import { useProjectsStore } from "../../persistence/projectsStore.js";
import { useAiStore } from "../../ai/aiStore.js";
import { meshFromPartialScan, meshFromPointCloud } from "../../ai/capture.js";
import { CAPTURE_DEFAULT_BASE_URL, checkServiceHealth, serviceUnreachableMessage } from "../../ai/errorHints.js";

export interface CloudActionDeps {
  /** The point-cloud document to convert. */
  cloud: PointCloudDoc;
  captureBaseURL: string | undefined;
  /** Pre-flight GET /health so a down service fails fast with a "start it with…" hint. */
  checkHealth: (base: string) => Promise<boolean>;
  meshFromCloud: typeof meshFromPointCloud;
  completeScan: typeof meshFromPartialScan;
  /** Persist the produced MeshDoc as a new project (projectsStore.createMeshProject). */
  persist: (doc: MeshDoc) => Promise<string>;
  /** Open the new mesh project so the mesh view + Convert-to-CAD path take over. */
  open: (id: string) => Promise<void>;
  /** Progress line while the job runs. */
  setStatus: (s: string) => void;
}

/** Un-flatten a PointCloudDoc's flat XYZ buffer (x0,y0,z0,x1,…) into the capture service's Nx3 rows. */
function toRows(flat: number[]): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) rows.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return rows;
}

/** Reconstruct a watertight mesh from the open ORIENTED cloud (/capture) and open it as a mesh doc. */
export async function runCloudToMesh(deps: CloudActionDeps): Promise<void> {
  const name = deps.cloud.name ?? "Scanned mesh";
  const base = (deps.captureBaseURL ?? CAPTURE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  deps.setStatus("checking capture service…");
  if (!(await deps.checkHealth(base))) {
    deps.setStatus(serviceUnreachableMessage("capture", base));
    return;
  }
  // /capture needs oriented points (normals parallel to points); a cloud without them can't fit.
  if (!deps.cloud.normals || deps.cloud.normals.length !== deps.cloud.points.length) {
    deps.setStatus("this point cloud has no normals — cloud→mesh (capture) needs an oriented cloud; try Complete partial scan.");
    return;
  }
  deps.setStatus("reconstructing mesh (minutes)…");
  const { meshDocId } = await deps.meshFromCloud(
    { points: toRows(deps.cloud.points), normals: toRows(deps.cloud.normals) },
    { persist: deps.persist },
    { ...(deps.captureBaseURL ? { baseURL: deps.captureBaseURL } : {}), onState: (s) => deps.setStatus(s) },
    name,
  );
  await deps.open(meshDocId);
  deps.setStatus(`reconstructed '${name}' to a mesh — run “Convert to CAD” to make it editable`);
}

/** Complete the open PARTIAL cloud into a full mesh (/complete) and open it as a mesh doc. */
export async function runCompleteScan(deps: CloudActionDeps): Promise<void> {
  const name = deps.cloud.name ?? "Completed scan";
  const base = (deps.captureBaseURL ?? CAPTURE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  deps.setStatus("checking capture service…");
  if (!(await deps.checkHealth(base))) {
    deps.setStatus(serviceUnreachableMessage("capture", base));
    return;
  }
  deps.setStatus("completing partial scan (minutes)…");
  const { meshDocId } = await deps.completeScan(
    { points: toRows(deps.cloud.points) },
    { persist: deps.persist },
    { ...(deps.captureBaseURL ? { baseURL: deps.captureBaseURL } : {}), onState: (s) => deps.setStatus(s) },
    name,
  );
  await deps.open(meshDocId);
  deps.setStatus(`completed '${name}' into a full mesh — run “Convert to CAD” to make it editable`);
}

/** Wire the DI deps to the live stores/services for the active cloud; null when no cloud is open. */
export function liveCloudDeps(): CloudActionDeps | null {
  const cloud = useProjectsStore.getState().activePointCloudDoc;
  if (!cloud) return null;
  return {
    cloud,
    captureBaseURL: useAiStore.getState().settings?.captureBaseURL,
    checkHealth: checkServiceHealth,
    meshFromCloud: meshFromPointCloud,
    completeScan: meshFromPartialScan,
    persist: (doc) => useProjectsStore.getState().createMeshProject(doc),
    open: (id) => useProjectsStore.getState().open(id),
    setStatus: (s) => useProjectsStore.setState({ status: s }),
  };
}

/** Fire a run* fn against the live deps, surfacing any failure as the projects-store status. */
function runLive(fn: (deps: CloudActionDeps) => Promise<void>): void {
  const deps = liveCloudDeps();
  if (!deps) return;
  void fn(deps).catch((e: unknown) => {
    useProjectsStore.setState({ status: `failed: ${e instanceof Error ? e.message : String(e)}` });
  });
}

const hasCloud = (ctx: { activePointCloudDoc: PointCloudDoc | null }): boolean => ctx.activePointCloudDoc != null;

/** The cloud→mesh context actions (spread into CONTEXT_ACTIONS by config.ts). Visible only when a
 * dense point-cloud document is open; they surface in the context menu AND the RECM radial ring. */
export const CLOUD_CONTEXT_ACTIONS: ContextAction[] = [
  {
    id: "cloud-to-mesh",
    group: "modify",
    label: () => "Point cloud → mesh",
    visible: (ctx) => hasCloud(ctx),
    enabled: (ctx) => hasCloud(ctx),
    run: () => runLive(runCloudToMesh),
  },
  {
    id: "cloud-complete",
    group: "modify",
    label: () => "Complete partial scan",
    visible: (ctx) => hasCloud(ctx),
    enabled: (ctx) => hasCloud(ctx),
    run: () => runLive(runCompleteScan),
  },
];
