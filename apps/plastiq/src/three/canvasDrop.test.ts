// Unit tests for the canvas drag-and-drop routing (Task #13). classifyDrop + routeDroppedFiles are
// pure and dependency-injected, so this drives them in Node with plain {name,type} files and fake
// deps — verifying the by-type routing (cloud file vs photos vs unsupported) and that every route
// lands on persist→open, with failures surfaced on the status line rather than thrown.

import { describe, expect, it, vi } from "vitest";
import { classifyDrop, routeDroppedFiles, type DropRouteDeps, type DroppedFile } from "./canvasDrop.js";
import type { PointCloudDoc } from "../store/types.js";

const f = (name: string, type = ""): DroppedFile => ({ name, type });
const cloudDoc = (name: string): PointCloudDoc => ({
  kind: "pointcloud",
  name,
  points: [0, 0, 0, 1, 0, 0],
  source: { mode: "import", providerId: "file" },
});

describe("classifyDrop", () => {
  it("routes a point-cloud file to 'cloud' (even alongside images — it wins)", () => {
    expect(classifyDrop([f("scan.ply")])).toBe("cloud");
    expect(classifyDrop([f("cloud.xyz")])).toBe("cloud");
    expect(classifyDrop([f("cloud.json")])).toBe("cloud");
    expect(classifyDrop([f("scan.ply"), f("a.jpg", "image/jpeg"), f("b.jpg", "image/jpeg")])).toBe("cloud");
  });

  it("routes ≥3 images to 'photos' (by MIME or by extension)", () => {
    expect(classifyDrop([f("a.jpg", "image/jpeg"), f("b.png", "image/png"), f("c.webp", "image/webp")])).toBe("photos");
    expect(classifyDrop([f("a.JPG"), f("b.jpeg"), f("c.png")])).toBe("photos"); // no MIME → extension
  });

  it("is 'unsupported' for too few photos, empty, or unknown types", () => {
    expect(classifyDrop([f("a.jpg", "image/jpeg"), f("b.jpg", "image/jpeg")])).toBe("unsupported"); // only 2
    expect(classifyDrop([])).toBe("unsupported");
    expect(classifyDrop([f("notes.txt", "text/plain")])).toBe("unsupported");
  });
});

function makeDeps(over: Partial<DropRouteDeps> = {}): DropRouteDeps & {
  statuses: string[];
  persisted: PointCloudDoc[];
  opened: string[];
} {
  const statuses: string[] = [];
  const persisted: PointCloudDoc[] = [];
  const opened: string[] = [];
  const base: DropRouteDeps = {
    readText: vi.fn(async () => "PLY_TEXT"),
    readBase64: vi.fn(async (file) => `b64:${file.name}`),
    parseCloudFile: vi.fn((name) => cloudDoc(name.replace(/\.[^.]+$/, ""))),
    solvePhotos: vi.fn(async () => cloudDoc("Photogrammetry cloud")),
    persistCloud: async (doc) => {
      persisted.push(doc);
      return "pc1";
    },
    open: async (id) => {
      opened.push(id);
    },
    setStatus: (s) => statuses.push(s),
    ...over,
  };
  return Object.assign(base, { statuses, persisted, opened });
}

describe("routeDroppedFiles — cloud file", () => {
  it("reads + parses the cloud file, persists and opens the project", async () => {
    const deps = makeDeps();
    await routeDroppedFiles([f("widget.ply")], deps);

    expect(deps.readText).toHaveBeenCalledOnce();
    expect(deps.parseCloudFile).toHaveBeenCalledWith("widget.ply", "PLY_TEXT");
    expect(deps.persisted).toHaveLength(1);
    expect(deps.persisted[0]!.name).toBe("widget");
    expect(deps.opened).toEqual(["pc1"]);
    expect(deps.statuses.at(-1)).toMatch(/opened point cloud 'widget' \(2 points\)/);
    expect(deps.solvePhotos).not.toHaveBeenCalled();
  });

  it("surfaces a parse failure on the status line (no throw, nothing opened)", async () => {
    const deps = makeDeps({
      parseCloudFile: vi.fn(() => {
        throw new Error("PLY: binary PLY not supported");
      }),
    });
    await routeDroppedFiles([f("bad.ply")], deps);
    expect(deps.opened).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/import failed: PLY: binary PLY not supported/);
  });
});

describe("routeDroppedFiles — photos", () => {
  it("reads images to base64, solves photogrammetry, persists + opens the dense cloud", async () => {
    const deps = makeDeps();
    await routeDroppedFiles([f("1.jpg", "image/jpeg"), f("2.jpg", "image/jpeg"), f("3.jpg", "image/jpeg")], deps);

    expect(deps.readBase64).toHaveBeenCalledTimes(3);
    expect(deps.solvePhotos).toHaveBeenCalledWith([
      { name: "1.jpg", data: "b64:1.jpg" },
      { name: "2.jpg", data: "b64:2.jpg" },
      { name: "3.jpg", data: "b64:3.jpg" },
    ]);
    expect(deps.opened).toEqual(["pc1"]);
    expect(deps.parseCloudFile).not.toHaveBeenCalled();
  });

  it("surfaces a solve failure (e.g. service down) without throwing", async () => {
    const deps = makeDeps({
      solvePhotos: vi.fn(async () => {
        throw new Error("Photogrammetry service unreachable");
      }),
    });
    await routeDroppedFiles([f("1.jpg", "image/jpeg"), f("2.png", "image/png"), f("3.webp", "image/webp")], deps);
    expect(deps.opened).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/import failed: Photogrammetry service unreachable/);
  });
});

describe("routeDroppedFiles — unsupported", () => {
  it("shows the accepted-types hint and does nothing else", async () => {
    const deps = makeDeps();
    await routeDroppedFiles([f("notes.txt", "text/plain")], deps);
    expect(deps.persisted).toHaveLength(0);
    expect(deps.opened).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/Drop a folder of photos.*or a \.ply/);
  });
});
