// Main-thread client for the geometry worker (SPEC-5 FR-5): a typed RPC bridge.
// `build(doc)` rebuilds + tags the part; `lower(doc)` lowers the assembly to a
// SimManifest (M4.5). Concurrent calls are matched by request id.

import GeometryWorker from "./geometry.worker.js?worker";
import type { SimManifest } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import type { ExportFormat, TransferMesh, WorkerResponse } from "./protocol.js";

/** Lowering result handed back to the UI (manifest + un-lowerable joints + COM). */
export interface LowerOutcome {
  manifest: SimManifest;
  skippedJoints: string[];
  /** The part's local centre of mass (for the simulate render-back). */
  localCom: [number, number, number];
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
  async build(doc: CadDocument, deflection = 0.0005): Promise<TransferMesh | null> {
    const res = await this.send({ op: "build", doc, deflection });
    return res.ok && res.op === "build" ? res.mesh : null;
  }

  /** Lower the document's assembly to a SimManifest (M4.5). */
  async lower(doc: CadDocument): Promise<LowerOutcome> {
    const res = await this.send({ op: "lower", doc });
    if (!res.ok || res.op !== "lower") throw new Error("lower: unexpected worker response");
    return { manifest: res.manifest, skippedJoints: res.skippedJoints, localCom: res.localCom };
  }

  /** Export the rebuilt part to a neutral interchange string (M6.2/M6.3). */
  async exportFile(doc: CadDocument, format: ExportFormat): Promise<string> {
    const res = await this.send({ op: "export", doc, format });
    if (!res.ok || res.op !== "export") throw new Error("export: unexpected worker response");
    return res.content;
  }

  dispose(): void {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.worker.terminate();
    this.pending.clear();
  }
}
