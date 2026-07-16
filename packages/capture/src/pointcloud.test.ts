// @plastiq/capture — point-cloud parsers over REAL tiny fixtures: an ASCII PLY exactly as
// MeshLab/COLMAP write it (header comments, extra color properties, a face element), plain and
// commented XYZ in both widths, and the JSON wire shapes. Malformed input must fail with a
// pointed, user-showable message — these errors land verbatim in the panel's error slot.

import { describe, expect, it } from "vitest";
import { parsePlyAscii, parsePointCloud, parsePointCloudJson, parseXyz, MIN_POINTS } from "./index.js";

/** An ASCII PLY with normals, per-vertex color (skipped), a comment, and a face element whose
 * data lines follow the vertex block (and must not be read as vertices). */
const PLY_WITH_NORMALS = `ply
format ascii 1.0
comment exported by MeshLab
element vertex 3
property float x
property float y
property float z
property float nx
property float ny
property float nz
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
0.0 0.0 1.0 0.0 0.0 1.0 255 0 0
0.0 1.0 0.0 0.0 1.0 0.0 0 255 0
1.0 0.0 0.0 1.0 0.0 0.0 0 0 255
3 0 1 2
`;

const PLY_POINTS_ONLY = `ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
end_header
0.5 -0.25 3.0
1.5 2.5 -1.0
`;

describe("parsePlyAscii", () => {
  it("reads x/y/z + nx/ny/nz by property position, skipping the face block", () => {
    const cloud = parsePlyAscii(PLY_WITH_NORMALS);
    expect(cloud.points).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect(cloud.normals).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  });

  it("reads uchar red/green/blue as 0..1 RGB (255→1), index-aligned with points", () => {
    const cloud = parsePlyAscii(PLY_WITH_NORMALS);
    expect(cloud.colors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  it("reads float r/g/b as-is (already 0..1) and has no colors key when absent", () => {
    const floatRgb = `ply
format ascii 1.0
element vertex 1
property float x
property float y
property float z
property float r
property float g
property float b
end_header
0 0 0 0.25 0.5 0.75
`;
    expect(parsePlyAscii(floatRgb).colors).toEqual([[0.25, 0.5, 0.75]]);
    expect(parsePlyAscii(PLY_POINTS_ONLY).colors).toBeUndefined();
  });

  it("returns no normals key when the vertex element has no nx/ny/nz", () => {
    const cloud = parsePlyAscii(PLY_POINTS_ONLY);
    expect(cloud.points).toEqual([
      [0.5, -0.25, 3],
      [1.5, 2.5, -1],
    ]);
    expect(cloud.normals).toBeUndefined();
  });

  it("rejects binary PLY with an actionable message", () => {
    const binary = PLY_WITH_NORMALS.replace("format ascii 1.0", "format binary_little_endian 1.0");
    expect(() => parsePlyAscii(binary)).toThrow(/binary PLY.*not supported.*ASCII/);
  });

  it("rejects a missing magic line, a missing vertex element, and missing x/y/z", () => {
    expect(() => parsePlyAscii("not a ply\n")).toThrow(/missing 'ply' magic/);
    expect(() => parsePlyAscii("ply\nformat ascii 1.0\nelement face 0\nend_header\n")).toThrow(/no 'element vertex'/);
    expect(() =>
      parsePlyAscii("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nend_header\n0 0\n"),
    ).toThrow(/lacks x\/y\/z/);
  });

  it("fails with a line number on a truncated or non-finite vertex row", () => {
    const short = "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1.0 2.0\n";
    expect(() => parsePlyAscii(short)).toThrow(/non-finite or missing value on line 8/);
    const nan = short.replace("1.0 2.0", "1.0 2.0 nan");
    expect(() => parsePlyAscii(nan)).toThrow(/line 8/);
  });
});

describe("parseXyz", () => {
  it("parses 3-column x y z (points only), skipping blanks and # / // comments", () => {
    const cloud = parseXyz("# a scan\n\n0 0 1\n// mid comment\n0 1 0\n1 0 0\n");
    expect(cloud.points).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect(cloud.normals).toBeUndefined();
  });

  it("parses 6-column x y z nx ny nz into points + normals", () => {
    const cloud = parseXyz("0 0 1 0 0 1\n0 1 0 0 1 0\n");
    expect(cloud.points).toEqual([
      [0, 0, 1],
      [0, 1, 0],
    ]);
    expect(cloud.normals).toEqual([
      [0, 0, 1],
      [0, 1, 0],
    ]);
  });

  it("rejects an unsupported width, inconsistent widths, non-finite values, and an empty file", () => {
    expect(() => parseXyz("1 2\n")).toThrow(/expected 3 .*or 6 .*columns, got 2 on line 1/);
    expect(() => parseXyz("1 2 3\n4 5 6 0 0 1\n")).toThrow(/inconsistent column count on line 2/);
    expect(() => parseXyz("1 2 three\n")).toThrow(/non-finite or missing value on line 1/);
    expect(() => parseXyz("# only comments\n")).toThrow(/no data lines/);
  });
});

describe("parsePointCloudJson", () => {
  it("accepts the wire shape {points, normals} and the bare array shape", () => {
    expect(parsePointCloudJson('{"points":[[1,2,3]],"normals":[[0,0,1]]}')).toEqual({
      points: [[1, 2, 3]],
      normals: [[0, 0, 1]],
    });
    expect(parsePointCloudJson("[[1,2,3],[4,5,6]]")).toEqual({
      points: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(parsePointCloudJson('{"points":[[1,2,3]]}')).toEqual({ points: [[1, 2, 3]] });
  });

  it("rejects invalid JSON, bad triples, and a points/normals length mismatch", () => {
    expect(() => parsePointCloudJson("{nope")).toThrow(/not valid JSON/);
    expect(() => parsePointCloudJson('{"points":[[1,2]]}')).toThrow(/points\[0\].*triple/);
    expect(() => parsePointCloudJson('{"points":[[1,2,null]]}')).toThrow(/points\[0\].*finite/);
    expect(() => parsePointCloudJson('{"points":[[1,2,3]],"normals":[]}')).toThrow(/normals length \(0\).*points length \(1\)/);
    expect(() => parsePointCloudJson('"just a string"')).toThrow(/expected \{points/);
  });
});

describe("parsePointCloud (extension dispatch)", () => {
  it("routes .ply/.xyz/.json (case-insensitive) to the matching parser", () => {
    expect(parsePointCloud("scan.PLY", PLY_POINTS_ONLY).points).toHaveLength(2);
    expect(parsePointCloud("scan.xyz", "1 2 3\n").points).toEqual([[1, 2, 3]]);
    expect(parsePointCloud("scan.json", "[[1,2,3]]").points).toEqual([[1, 2, 3]]);
  });

  it("rejects any other extension with the supported list", () => {
    expect(() => parsePointCloud("scan.obj", "")).toThrow(/unsupported point-cloud file 'scan\.obj'.*\.ply.*\.xyz.*\.json/);
  });
});

describe("MIN_POINTS", () => {
  it("matches the server's documented floor (main.py: 'need at least 16 points')", () => {
    expect(MIN_POINTS).toBe(16);
  });
});
