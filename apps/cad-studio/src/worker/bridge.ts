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

export class GeometryClient {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (res: WorkerResponse) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new GeometryWorker();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(new Error(res.error));
    };
    this.worker.onerror = (e: ErrorEvent): void => {
      for (const [, p] of this.pending) p.reject(new Error(e.message));
      this.pending.clear();
    };
  }

  private send(message: Record<string, unknown>): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    this.worker.terminate();
    this.pending.clear();
  }
}
