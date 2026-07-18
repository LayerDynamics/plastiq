// Main-thread client for the geometry worker (SPEC-5 FR-5): a typed RPC bridge.
// `build(doc)` rebuilds + tags the part; `lower(doc)` lowers the assembly to a
// SimManifest (M4.5). Concurrent calls are matched by request id.

import GeometryWorker from "./geometry.worker.js?worker";
import type { FaceRef, SimManifest } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import type {
  ExportFormat,
  FeatureBuildStatus,
  PlaneFrame,
  TransferMesh,
  WorkerResponse,
} from "./protocol.js";

/**
 * Build result handed back to the UI: the geometry that survived plus every
 * feature's fate. A null mesh with error statuses is a NORMAL outcome — the
 * rebuild isolates per-feature failures instead of failing the whole pass.
 */
export interface BuildOutcome {
  mesh: TransferMesh | null;
  statuses: FeatureBuildStatus[];
}

/** Lowering result handed back to the UI (manifest + un-lowerable joints + COM). */
export interface LowerOutcome {
  manifest: SimManifest;
  skippedJoints: string[];
  /** The part's local centre of mass (for the simulate render-back). */
  localCom: [number, number, number];
}

/** An interchange export: the file text, and how many bodies it carries
 * (assembly instances, or 1 for a bare part — §2.11.2). */
export interface ExportResult {
  content: string;
  bodyCount: number;
}

/** A hung OCCT op should fail, not block the UI forever (CADStudio.md §5.6). The
 *  default is generous: the first build also pays the ~50MB OCCT wasm load. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (res: WorkerResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  op: string;
}

export class GeometryClient {
  private readonly worker: Worker;
  private readonly timeoutMs: number;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  /** `worker` is injectable for tests; defaults to the real geometry worker. */
  constructor(opts?: { worker?: Worker; timeoutMs?: number }) {
    this.worker = opts?.worker ?? new GeometryWorker();
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(new Error(res.error));
    };
    this.worker.onerror = (e: ErrorEvent): void => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(e.message));
      }
      this.pending.clear();
    };
  }

  private send(message: Record<string, unknown>): Promise<WorkerResponse> {
    const id = ++this.seq;
    const op = String(message["op"] ?? "?");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`geometry worker timed out after ${this.timeoutMs}ms (op: ${op})`));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      this.worker.postMessage({ ...message, id });
    });
  }

  /** Rebuild `doc` and return its tagged mesh (null if it has no geometry). */
  /**
   * Rebuild the document. Per-feature failures are ISOLATED (FR-24): the mesh
   * is whatever geometry survived (null if none) and `statuses` carries every
   * feature's fate, so the caller badges features from structured data rather
   * than parsing an error string.
   */
  async build(doc: CadDocument, deflection = 0.0005): Promise<BuildOutcome> {
    const res = await this.send({ op: "build", doc, deflection });
    if (!res.ok || res.op !== "build") return { mesh: null, statuses: [] };
    // `?? []` so callers can always iterate: a worker build predating the
    // statuses field (or any malformed reply) must not crash the rebuild loop.
    return { mesh: res.mesh, statuses: res.statuses ?? [] };
  }

  /** Lower the document's assembly to a SimManifest (M4.5). */
  async lower(doc: CadDocument): Promise<LowerOutcome> {
    const res = await this.send({ op: "lower", doc });
    if (!res.ok || res.op !== "lower") throw new Error("lower: unexpected worker response");
    return { manifest: res.manifest, skippedJoints: res.skippedJoints, localCom: res.localCom };
  }

  /** Export the rebuilt part to a neutral interchange string (M6.2/M6.3), with
   * how many bodies the file carries (§2.11.2) so the UI can report it. */
  async exportFile(doc: CadDocument, format: ExportFormat): Promise<ExportResult> {
    const res = await this.send({ op: "export", doc, format });
    if (!res.ok || res.op !== "export") throw new Error("export: unexpected worker response");
    return { content: res.content, bodyCount: res.bodyCount };
  }

  /** Resolve a picked face on `doc` to a sketch datum frame for the "normal to"
   * camera (M3 on-face sketching); null if there's no body or the face is gone. */
  async facePlane(doc: CadDocument, face: FaceRef): Promise<PlaneFrame | null> {
    const res = await this.send({ op: "facePlane", doc, face });
    if (!res.ok || res.op !== "facePlane")
      throw new Error("facePlane: unexpected worker response");
    return res.plane;
  }

  dispose(): void {
    // Reject any in-flight requests so an awaiting caller doesn't hang forever once
    // the worker is terminated (mirrors `onerror`'s reject-all). Then stop the
    // worker and clear the map.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("geometry worker disposed"));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
