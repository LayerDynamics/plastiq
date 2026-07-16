// Point-cloud FILE ingestion (SPEC-13, Task #13): parse a dropped/loaded `.ply` / `.xyz` / `.json`
// cloud into a PointCloudDoc for the canvas. Wraps @plastiq/capture's parsePointCloud (strict, real
// parsing — throws a user-showable message on malformed input) and flattens its Nx3 rows into the
// flat JSON buffers a PointCloudDoc persists. Colours ride along when the file carried them.

import { parsePointCloud, type ParsedPointCloud } from "@plastiq/capture";
import type { PointCloudDoc, PointCloudSource } from "../store/types.js";

/** Flatten a parser result (Nx3 rows) into the flat number[] buffers a PointCloudDoc stores. */
export function parsedToPointCloudDoc(
  parsed: ParsedPointCloud,
  name: string,
  source: PointCloudSource,
): PointCloudDoc {
  const flat = (rows: number[][]): number[] => rows.flat();
  return {
    kind: "pointcloud",
    name,
    points: flat(parsed.points),
    ...(parsed.colors ? { colors: flat(parsed.colors) } : {}),
    ...(parsed.normals ? { normals: flat(parsed.normals) } : {}),
    source,
  };
}

/** Parse a point-cloud file (name decides the format) into a PointCloudDoc. The project name is the
 * file's base name; the source records that it was imported from a file. Throws parsePointCloud's
 * user-showable message on a malformed/binary/unsupported file. */
export function parseCloudFileToDoc(fileName: string, text: string): PointCloudDoc {
  const parsed = parsePointCloud(fileName, text);
  const name = fileName.replace(/\.[^.]+$/, "") || fileName;
  return parsedToPointCloudDoc(parsed, name, { mode: "import", providerId: "file" });
}
