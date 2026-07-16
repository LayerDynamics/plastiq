// Unit tests for the point-cloud → mesh canvas context actions (Task #12). The DI-injected run* fns
// are driven with fake deps (no service / stores) so we assert the exact orchestration: health
// pre-flight → capture/complete the open cloud → persist the MeshDoc → OPEN it (mesh view +
// Convert-to-CAD take over). Also pins the CLOUD_CONTEXT_ACTIONS gating (visible/enabled iff a cloud
// is open) that surfaces them in BOTH the context menu and the RECM ring.

import { describe, expect, it, vi } from "vitest";
import { CLOUD_CONTEXT_ACTIONS, runCloudToMesh, runCompleteScan, type CloudActionDeps } from "./cloudActions.js";
import type { ContextTarget } from "./contextSelection.js";
import type { MeshDoc, PointCloudDoc } from "../../store/types.js";
import type { CaptureReport } from "@plastiq/capture";

const CLOUD: PointCloudDoc = {
  kind: "pointcloud",
  name: "Scan",
  points: [0, 0, 0, 1, 0, 0],
  normals: [0, 0, 1, 0, 0, 1],
  source: { mode: "photos3d", providerId: "photogrammetry" },
};

const report = (): CaptureReport => ({ triangles: 100, vertices: 60 }) as unknown as CaptureReport;
const meshResult = (name: string): { meshDocId: string; doc: MeshDoc; report: CaptureReport } => ({
  meshDocId: "m1",
  doc: { kind: "mesh", name, glb: "GLB", source: { mode: "photos3d", providerId: "capture" } },
  report: report(),
});

function makeDeps(over: Partial<CloudActionDeps> = {}): CloudActionDeps & {
  statuses: string[];
  opened: string[];
  persisted: MeshDoc[];
} {
  const statuses: string[] = [];
  const opened: string[] = [];
  const persisted: MeshDoc[] = [];
  const base: CloudActionDeps = {
    cloud: CLOUD,
    captureBaseURL: undefined,
    checkHealth: vi.fn(async () => true),
    meshFromCloud: vi.fn(async (_input, deps, _opts, name) => {
      await deps.persist(meshResult(name ?? "Scanned mesh").doc);
      return meshResult(name ?? "Scanned mesh");
    }),
    completeScan: vi.fn(async (_input, deps, _opts, name) => {
      await deps.persist(meshResult(name ?? "Completed scan").doc);
      return meshResult(name ?? "Completed scan");
    }),
    persist: async (doc) => {
      persisted.push(doc);
      return "m1";
    },
    open: async (id) => {
      opened.push(id);
    },
    setStatus: (s) => statuses.push(s),
    ...over,
  };
  return Object.assign(base, { statuses, opened, persisted });
}

describe("runCloudToMesh", () => {
  it("health-checks :8001, un-flattens the oriented cloud, captures, persists + opens the mesh", async () => {
    const deps = makeDeps();
    await runCloudToMesh(deps);

    expect(deps.checkHealth).toHaveBeenCalledWith("http://localhost:8001");
    expect(deps.meshFromCloud).toHaveBeenCalledWith(
      { points: [[0, 0, 0], [1, 0, 0]], normals: [[0, 0, 1], [0, 0, 1]] }, // un-flattened Nx3
      expect.objectContaining({ persist: expect.any(Function) }),
      expect.any(Object),
      "Scan",
    );
    expect(deps.opened).toEqual(["m1"]); // opened so the mesh view + Convert-to-CAD take over
    expect(deps.statuses.at(-1)).toMatch(/reconstructed 'Scan' to a mesh/);
  });

  it("refuses a cloud with no normals (capture needs an oriented cloud) — no capture call", async () => {
    const deps = makeDeps({ cloud: { ...CLOUD, normals: undefined } });
    await runCloudToMesh(deps);
    expect(deps.meshFromCloud).not.toHaveBeenCalled();
    expect(deps.opened).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/no normals/);
  });

  it("aborts with the capture 'start it with…' hint when the service is down", async () => {
    const deps = makeDeps({ checkHealth: vi.fn(async () => false) });
    await runCloudToMesh(deps);
    expect(deps.meshFromCloud).not.toHaveBeenCalled();
    expect(deps.statuses.at(-1)).toMatch(/Capture.*unreachable at http:\/\/localhost:8001/);
  });
});

describe("runCompleteScan", () => {
  it("completes the partial cloud (points only), persists + opens the mesh", async () => {
    const deps = makeDeps();
    await runCompleteScan(deps);

    expect(deps.completeScan).toHaveBeenCalledWith(
      { points: [[0, 0, 0], [1, 0, 0]] }, // /complete ignores normals
      expect.objectContaining({ persist: expect.any(Function) }),
      expect.any(Object),
      "Scan",
    );
    expect(deps.opened).toEqual(["m1"]);
    expect(deps.statuses.at(-1)).toMatch(/completed 'Scan' into a full mesh/);
  });

  it("aborts when the capture service is down", async () => {
    const deps = makeDeps({ checkHealth: vi.fn(async () => false) });
    await runCompleteScan(deps);
    expect(deps.completeScan).not.toHaveBeenCalled();
  });
});

describe("CLOUD_CONTEXT_ACTIONS gating", () => {
  const withCloud = { activePointCloudDoc: CLOUD } as ContextTarget;
  const noCloud = { activePointCloudDoc: null } as ContextTarget;

  it("exposes exactly the two cloud→mesh actions in the 'modify' group", () => {
    expect(CLOUD_CONTEXT_ACTIONS.map((a) => a.id)).toEqual(["cloud-to-mesh", "cloud-complete"]);
    expect(CLOUD_CONTEXT_ACTIONS.every((a) => a.group === "modify")).toBe(true);
  });

  it("is visible + enabled only when a point-cloud document is open", () => {
    for (const a of CLOUD_CONTEXT_ACTIONS) {
      expect(a.visible(withCloud)).toBe(true);
      expect(a.enabled(withCloud)).toBe(true);
      expect(a.visible(noCloud)).toBe(false);
      expect(a.enabled(noCloud)).toBe(false);
    }
  });

  it("labels read for a menu/ring", () => {
    expect(CLOUD_CONTEXT_ACTIONS[0]!.label(withCloud)).toBe("Point cloud → mesh");
    expect(CLOUD_CONTEXT_ACTIONS[1]!.label(withCloud)).toBe("Complete partial scan");
  });
});
