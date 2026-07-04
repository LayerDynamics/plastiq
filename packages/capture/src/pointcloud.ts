// @plastiq/capture — point-cloud file parsers (ASCII PLY, XYZ, JSON) → the service's JSON schema.
//
// The capture service takes raw Nx3 arrays (`{points, normals}` — main.py's CaptureBody), but
// scans arrive as files: `.ply` (COLMAP/MeshLab exports), `.xyz` (plain columns, common from
// LiDAR/depth tooling), or `.json` (already in wire shape). These parsers convert client-side so
// the browser POSTs the exact schema the server validates. All parsing is strict and real: every
// consumed value must be finite, malformed lines fail with a line number, and binary PLY is
// rejected with a clear message (only `format ascii 1.0` is parseable from text).

/** A parsed cloud in the server's shape: Nx3 `points`, plus Nx3 `normals` when the file carried
 * them (PLY `nx/ny/nz` properties or 6-column XYZ). `/capture` requires normals; `/complete`
 * ignores them. */
export interface ParsedPointCloud {
  points: number[][];
  normals?: number[][];
}

/** Parse one whitespace-separated numeric column, failing loudly with its position. */
function num(token: string | undefined, what: string, line: number): number {
  const v = token === undefined ? NaN : Number(token);
  if (!Number.isFinite(v)) throw new Error(`${what}: non-finite or missing value on line ${line}`);
  return v;
}

/** One `element <name> <count>` block of a PLY header, with its property names in order. */
interface PlyElement {
  name: string;
  count: number;
  properties: string[];
}

/** Parse an ASCII PLY (the `format ascii 1.0` flavor). Reads the `element vertex` block's
 * `x y z` properties (required) and `nx ny nz` (optional, all-or-none); other properties (color,
 * confidence, …) and other elements (faces, …) are skipped by position. Binary PLY is rejected —
 * export as ASCII (MeshLab/COLMAP both can) or use `.xyz`. */
export function parsePlyAscii(text: string): ParsedPointCloud {
  const lines = text.split(/\r\n|\r|\n/);
  let i = 0;
  const nextLine = (): string => {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) throw new Error("PLY: unexpected end of file");
    return lines[i++]!.trim();
  };

  if (nextLine() !== "ply") throw new Error("PLY: missing 'ply' magic line");

  const elements: PlyElement[] = [];
  let formatSeen = false;
  for (;;) {
    const line = nextLine();
    if (line === "end_header") break;
    const parts = line.split(/\s+/);
    if (parts[0] === "comment" || parts[0] === "obj_info") continue;
    if (parts[0] === "format") {
      if (parts[1] !== "ascii") {
        throw new Error(`PLY: binary PLY (${parts[1] ?? "?"}) is not supported — export as ASCII ('format ascii 1.0')`);
      }
      formatSeen = true;
      continue;
    }
    if (parts[0] === "element") {
      const count = Number(parts[2]);
      if (!parts[1] || !Number.isInteger(count) || count < 0) throw new Error(`PLY: bad element line '${line}'`);
      elements.push({ name: parts[1], count, properties: [] });
      continue;
    }
    if (parts[0] === "property") {
      const el = elements[elements.length - 1];
      if (!el) throw new Error("PLY: property before any element");
      // "property list <count-type> <item-type> <name>" (faces) vs "property <type> <name>".
      const name = parts[parts.length - 1];
      if (!name) throw new Error(`PLY: bad property line '${line}'`);
      el.properties.push(name);
      continue;
    }
    throw new Error(`PLY: unrecognized header line '${line}'`);
  }
  if (!formatSeen) throw new Error("PLY: header has no 'format' line");

  const vertexIndex = elements.findIndex((e) => e.name === "vertex");
  if (vertexIndex < 0) throw new Error("PLY: no 'element vertex' in header");
  const vertex = elements[vertexIndex]!;

  const xi = vertex.properties.indexOf("x");
  const yi = vertex.properties.indexOf("y");
  const zi = vertex.properties.indexOf("z");
  if (xi < 0 || yi < 0 || zi < 0) throw new Error("PLY: vertex element lacks x/y/z properties");
  const nxi = vertex.properties.indexOf("nx");
  const nyi = vertex.properties.indexOf("ny");
  const nzi = vertex.properties.indexOf("nz");
  const hasNormals = nxi >= 0 && nyi >= 0 && nzi >= 0;

  // Data blocks appear in element-declaration order — skip the lines of elements before vertex.
  for (let e = 0; e < vertexIndex; e++) for (let k = 0; k < elements[e]!.count; k++) nextLine();

  const points: number[][] = [];
  const normals: number[][] = [];
  for (let v = 0; v < vertex.count; v++) {
    const lineNo = i + 1; // 1-based, for error messages (nextLine advances i past the line)
    const cols = nextLine().split(/\s+/);
    points.push([num(cols[xi], "PLY vertex", lineNo), num(cols[yi], "PLY vertex", lineNo), num(cols[zi], "PLY vertex", lineNo)]);
    if (hasNormals) {
      normals.push([num(cols[nxi], "PLY normal", lineNo), num(cols[nyi], "PLY normal", lineNo), num(cols[nzi], "PLY normal", lineNo)]);
    }
  }
  return hasNormals ? { points, normals } : { points };
}

/** Parse a plain-column XYZ file: one point per line, whitespace-separated. 3 columns = `x y z`,
 * 6 columns = `x y z nx ny nz`; the first data line fixes the width and every line must match.
 * Blank lines and `#`/`//` comment lines are skipped. */
export function parseXyz(text: string): ParsedPointCloud {
  const points: number[][] = [];
  const normals: number[][] = [];
  let width: 3 | 6 | null = null;
  const lines = text.split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;
    const cols = line.split(/[\s,;]+/);
    if (width === null) {
      if (cols.length !== 3 && cols.length !== 6) {
        throw new Error(`XYZ: expected 3 (x y z) or 6 (x y z nx ny nz) columns, got ${cols.length} on line ${ln + 1}`);
      }
      width = cols.length as 3 | 6;
    } else if (cols.length !== width) {
      throw new Error(`XYZ: inconsistent column count on line ${ln + 1} (expected ${width}, got ${cols.length})`);
    }
    points.push([num(cols[0], "XYZ point", ln + 1), num(cols[1], "XYZ point", ln + 1), num(cols[2], "XYZ point", ln + 1)]);
    if (width === 6) {
      normals.push([num(cols[3], "XYZ normal", ln + 1), num(cols[4], "XYZ normal", ln + 1), num(cols[5], "XYZ normal", ln + 1)]);
    }
  }
  if (points.length === 0) throw new Error("XYZ: no data lines found");
  return width === 6 ? { points, normals } : { points };
}

/** Validate an Nx3 array of finite numbers (the JSON path — PLY/XYZ validate as they parse). */
function checkNx3(value: unknown, what: string): number[][] {
  if (!Array.isArray(value)) throw new Error(`JSON: '${what}' is not an array`);
  return value.map((row, idx) => {
    if (!Array.isArray(row) || row.length !== 3 || !row.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error(`JSON: '${what}[${idx}]' is not a [x, y, z] triple of finite numbers`);
    }
    return row as number[];
  });
}

/** Parse a JSON point cloud: either the wire shape `{points, normals?}` or a bare `[[x,y,z], …]`
 * array (points only). Values are validated as finite Nx3, and a `normals` length mismatch fails
 * here rather than as a server 400. */
export function parsePointCloudJson(text: string): ParsedPointCloud {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON: file is not valid JSON");
  }
  if (Array.isArray(parsed)) return { points: checkNx3(parsed, "points") };
  if (parsed !== null && typeof parsed === "object" && "points" in parsed) {
    const obj = parsed as { points: unknown; normals?: unknown };
    const points = checkNx3(obj.points, "points");
    if (obj.normals === undefined) return { points };
    const normals = checkNx3(obj.normals, "normals");
    if (normals.length !== points.length) {
      throw new Error(`JSON: normals length (${normals.length}) must match points length (${points.length})`);
    }
    return { points, normals };
  }
  throw new Error("JSON: expected {points, normals?} or a bare [[x,y,z], …] array");
}

/** Parse a point-cloud file by extension: `.ply` (ASCII), `.xyz`, or `.json`. Throws a
 * user-showable message on any malformed input; never returns a cloud with non-finite values. */
export function parsePointCloud(fileName: string, text: string): ParsedPointCloud {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (ext === ".ply") return parsePlyAscii(text);
  if (ext === ".xyz") return parseXyz(text);
  if (ext === ".json") return parsePointCloudJson(text);
  throw new Error(`unsupported point-cloud file '${fileName}' — use .ply (ASCII), .xyz, or .json`);
}
