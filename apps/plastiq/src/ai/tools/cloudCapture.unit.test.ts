import { describe, expect, it, vi } from "vitest";
import { cloudToMesh, completeScan, type CloudCaptureDeps } from "./cloudCapture.js";
import type { PointCloudDoc } from "../../store/types.js";

const cloud: PointCloudDoc = {
  kind: "pointcloud",
  name: "scan",
  points: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  source: { mode: "import", providerId: "test" },
};

const meshDoc = {
  kind: "mesh" as const,
  glb: "x",
  name: "scan",
  source: { mode: "photos3d" as const, providerId: "capture" },
};

function deps(partial: Partial<CloudCaptureDeps> & { cloudDoc?: PointCloudDoc | null }): CloudCaptureDeps {
  const c = partial.cloudDoc === undefined ? cloud : partial.cloudDoc;
  return {
    cloud: () => c,
    meshFromCloud: vi.fn(async () => ({
      meshDocId: "m1",
      doc: meshDoc,
      report: { vertices: 10, faces: 12 },
    })),
    completeScan: vi.fn(async () => ({
      meshDocId: "m2",
      doc: { ...meshDoc, name: "done", glb: "y" },
      report: { vertices: 20, faces: 22, demoWeights: true },
    })),
    persist: vi.fn(async () => "m1"),
    open: vi.fn(async () => {}),
    ...partial,
  };
}

describe("cloudCapture tools (T34)", () => {
  it("cloud_to_mesh errors when no cloud is open", async () => {
    const r = await cloudToMesh({}, deps({ cloudDoc: null }));
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/No point-cloud/);
  });

  it("cloud_to_mesh errors without normals", async () => {
    const r = await cloudToMesh(
      {},
      deps({
        cloudDoc: {
          kind: "pointcloud",
          points: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          source: { mode: "import", providerId: "test" },
        },
      }),
    );
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/normals/);
  });

  it("cloud_to_mesh opens the mesh on success", async () => {
    const d = deps({});
    const r = await cloudToMesh({}, d);
    expect(r.status).toBe("ok");
    expect(d.open).toHaveBeenCalledWith("m1");
    expect(r.message).toMatch(/mesh/);
  });

  it("complete_scan surfaces demo weights", async () => {
    const d = deps({});
    const r = await completeScan({}, d);
    expect(r.status).toBe("ok");
    expect(r.message).toMatch(/demo weights/);
  });
});
