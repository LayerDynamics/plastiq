// Unit tests for point-cloud FILE ingestion (Task #13): parseCloudFileToDoc turns a dropped/loaded
// .ply/.xyz/.json into a PointCloudDoc with FLAT buffers, colours preserved, and the base name as the
// project name — the real @plastiq/capture parser (no mocks), so a bad file throws its own message.

import { describe, expect, it } from "vitest";
import { parseCloudFileToDoc, parsedToPointCloudDoc } from "./pointcloudFile.js";

const PLY = `ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
property float nx
property float ny
property float nz
property uchar red
property uchar green
property uchar blue
end_header
0 0 0 0 0 1 255 0 0
1 1 1 0 1 0 0 0 255
`;

describe("parseCloudFileToDoc", () => {
  it("parses a coloured .ply into a flat PointCloudDoc named after the file", () => {
    const doc = parseCloudFileToDoc("gargoyle.ply", PLY);
    expect(doc.kind).toBe("pointcloud");
    expect(doc.name).toBe("gargoyle");
    expect(doc.source).toEqual({ mode: "import", providerId: "file" });
    expect(doc.points).toEqual([0, 0, 0, 1, 1, 1]); // flattened
    expect(doc.normals).toEqual([0, 0, 1, 0, 1, 0]);
    expect(doc.colors).toEqual([1, 0, 0, 0, 0, 1]); // uchar 255→1, flattened
  });

  it("parses a points-only .xyz (no colors/normals keys)", () => {
    const doc = parseCloudFileToDoc("lidar.xyz", "0 0 0\n1 2 3\n");
    expect(doc.points).toEqual([0, 0, 0, 1, 2, 3]);
    expect(doc.normals).toBeUndefined();
    expect(doc.colors).toBeUndefined();
  });

  it("throws the parser's user-showable message on a malformed file", () => {
    expect(() => parseCloudFileToDoc("bad.ply", "not a ply\n")).toThrow(/missing 'ply' magic/);
  });
});

describe("parsedToPointCloudDoc", () => {
  it("flattens Nx3 rows and carries the given name + source", () => {
    const doc = parsedToPointCloudDoc(
      { points: [[1, 2, 3]], normals: [[0, 0, 1]] },
      "cloud",
      { mode: "scan", providerId: "capture" },
    );
    expect(doc).toEqual({
      kind: "pointcloud",
      name: "cloud",
      points: [1, 2, 3],
      normals: [0, 0, 1],
      source: { mode: "scan", providerId: "capture" },
    });
  });
});
