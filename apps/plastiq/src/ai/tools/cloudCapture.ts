// T34 / M5 — agent tools for point-cloud → mesh and photo capture paths.
// Mirrors meshToCad: zod args, DI deps, structured errors (never throw across the tool boundary).

import { z } from "zod";
import type { MeshDoc, PointCloudDoc } from "../../store/types.js";
import type { meshFromPointCloud, meshFromPartialScan } from "../capture.js";

export const CLOUD_TO_MESH = "cloud_to_mesh";
export const COMPLETE_SCAN = "complete_scan";

const emptyArgs = z.object({});

export interface CloudCaptureResult {
  status: "ok" | "error";
  message: string;
  errors?: string;
}

export interface CloudCaptureDeps {
  /** Open point-cloud document, or null. */
  cloud: () => PointCloudDoc | null;
  meshFromCloud: typeof meshFromPointCloud;
  completeScan: typeof meshFromPartialScan;
  persist: (doc: MeshDoc) => Promise<string>;
  open: (id: string) => Promise<void>;
  captureBaseURL?: string;
  signal?: AbortSignal;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toRows(flat: number[]): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) rows.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return rows;
}

/** Oriented cloud → watertight mesh via /capture. */
export async function cloudToMesh(input: unknown, deps: CloudCaptureDeps): Promise<CloudCaptureResult> {
  const parsed = emptyArgs.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      status: "error",
      message: "cloud_to_mesh arguments did not validate.",
      errors: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const cloud = deps.cloud();
  if (!cloud) {
    return {
      status: "error",
      message: "No point-cloud document is open — drop a .ply/.xyz or solve photos first.",
    };
  }
  if (!cloud.normals || cloud.normals.length !== cloud.points.length) {
    return {
      status: "error",
      message:
        "This point cloud has no normals — cloud_to_mesh needs an oriented cloud; try complete_scan instead.",
    };
  }
  const name = cloud.name ?? "Scanned mesh";
  try {
    const { meshDocId, report } = await deps.meshFromCloud(
      { points: toRows(cloud.points), normals: toRows(cloud.normals) },
      { persist: deps.persist },
      {
        ...(deps.captureBaseURL ? { baseURL: deps.captureBaseURL } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      name,
    );
    await deps.open(meshDocId);
    return {
      status: "ok",
      message: `Reconstructed '${name}' to a mesh (${report.vertices} verts) — open reconstruct_brep or fit_nurbs next.`,
    };
  } catch (e) {
    return { status: "error", message: "Point cloud → mesh failed.", errors: errMessage(e) };
  }
}

/** Partial cloud → completed mesh via /complete. */
export async function completeScan(input: unknown, deps: CloudCaptureDeps): Promise<CloudCaptureResult> {
  const parsed = emptyArgs.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      status: "error",
      message: "complete_scan arguments did not validate.",
      errors: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const cloud = deps.cloud();
  if (!cloud) {
    return {
      status: "error",
      message: "No point-cloud document is open — drop a partial scan (.ply/.xyz) first.",
    };
  }
  const name = cloud.name ?? "Completed scan";
  try {
    const { meshDocId, report } = await deps.completeScan(
      { points: toRows(cloud.points) },
      { persist: deps.persist },
      {
        ...(deps.captureBaseURL ? { baseURL: deps.captureBaseURL } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      name,
    );
    await deps.open(meshDocId);
    const demo = report.demoWeights
      ? " (demo weights — set CAPTURE_COMPLETION_CHECKPOINT for real meshes)"
      : "";
    return {
      status: "ok",
      message: `Completed '${name}' into a full mesh${demo} — open reconstruct_brep or fit_nurbs next.`,
    };
  } catch (e) {
    return { status: "error", message: "Partial scan completion failed.", errors: errMessage(e) };
  }
}
