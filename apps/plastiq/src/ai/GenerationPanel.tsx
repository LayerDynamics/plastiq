// SPEC-6 R2.4 — the AI generation cockpit (FR-19). A dockable side panel: prompt input,
// streaming response + a visible tool-call/build trace, a usage meter, and cancel. It
// wires the real dependencies — the off-thread build seam (__plastiqBuild on the single
// geometry worker) as the build_part/inspect_geometry probe, loadDocument as the atomic
// apply, and the live document as edit context — then drives runGeneration. A compact
// neutral first-run chooser (FR-5a) lets the user pick a provider so the panel is
// self-sufficient. Conversation + trace persist per project via the aiStore (R5.1).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { buildProvider, keyResolverFor } from "./providers/registry.js";
import { isFirstRun, toProviderSettings, type AiSettings } from "./settings.js";
import { runGeneration } from "./runGeneration.js";
import {
  cancelReconstruct,
  commitStepDocument,
  reconstructMesh,
  stepToImportDocument,
} from "./reconstruct.js";
import { liveBuildProbe } from "./agentTurn.js";
import {
  cancelFit,
  fitMeshToCad,
  nurbsFitStatusMessage,
  nurbsUnreachableMessage,
  NURBS_DEFAULT_BASE_URL,
} from "./nurbs.js";
import { cancelCapture, captureFromPhotos } from "./nerf.js";
import type { NerfEncoding, NerfMethod } from "@plastiq/nerf";
import { cancelCaptureJob, meshFromPartialScan, meshFromPointCloud } from "./capture.js";
import { parsePointCloud, MIN_POINTS, type ParsedPointCloud } from "@plastiq/capture";
import {
  cancelPhotogrammetry,
  DEFAULT_SPARSE_MAX_DIM,
  denseCloudToMeshDoc,
  solvePhotogrammetry,
} from "./photogrammetry.js";
import type { PhotogrammetryResult } from "@plastiq/photogrammetry";
import {
  checkServiceHealth,
  providerEndpoint,
  serviceUnreachableMessage,
  translateProviderError,
  CAPTURE_DEFAULT_BASE_URL,
  NERF_DEFAULT_BASE_URL,
  PHOTOGRAMMETRY_DEFAULT_BASE_URL,
  RECONSTRUCT_DEFAULT_BASE_URL,
  type ProviderEndpoint,
} from "./errorHints.js";
import { fileToBase64, fileToText } from "./fileRead.js";
import {
  detectOllama,
  ollamaNotDetectedMessage,
  OLLAMA_DEFAULT_V1,
  type OllamaModelChoice,
} from "./ollamaDetect.js";
import { pairImagesToFrames, type NamedImage } from "./framePairing.js";
import { exportMeshGlb } from "../mesh/exportGlb.js";
import { buildMeshGenDeps, meshGenConfigured, DEFAULT_IMAGE_PROVIDER_ID } from "./meshGenDeps.js";
import { buildTurnTools, buildCreateMeshDeps, buildSeam, type TurnToolsDeps } from "./agentTurn.js";
import { PaidJobConfirmModal, type PendingConfirm } from "./PaidJobConfirmModal.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { planAttachmentRoute, type AttachmentRoute } from "./visionRoute.js";
import { UsageMeter, type UsageSnapshot } from "./usage.js";
import { createMesh } from "./tools/createMesh.js";
import type { PlanGraph } from "./planning.js";
import type { GenImage } from "./meshgen/types.js";
import type { ChatMessage, ContentPart } from "./providers/types.js";
import type { MeshDoc } from "../store/types.js";

/** An image the user attached to a prompt, with a stable id so the creative img3d route
 * (create_mesh) can reference it via resolveImage. */
interface Attachment {
  image: GenImage;
  id: string;
  name: string;
}

/** Read a user-selected image File into the GenImage (base64) the providers consume. */
async function fileToGenImage(file: File): Promise<GenImage> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return { mediaType: file.type || "image/png", data: btoa(binary) };
}

/** A line in the visible transcript (assistant text, a tool step, or a status). */
interface Line {
  kind: "text" | "tool" | "status" | "error";
  text: string;
  isError?: boolean;
  /** Secondary detail (the raw provider error), rendered collapsed under the line. */
  detail?: string;
  /** True for messages replayed from the persisted conversation (a prior session). */
  prior?: boolean;
}

/** Flatten a persisted message's content to plain text (image parts noted inline). */
function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "(image)")).join(" ");
}

/** Compact structured view of a committed decomposition plan (9-M1): a header line,
 * the node hierarchy indented under its roots (`id — part`), then every relation with
 * its kind. FULL content — unlike the generic tool lines (which cut args at 200 chars)
 * a plan is never truncated; the transcript is whitespace-pre-wrap, so the newlines and
 * indentation render as written. A validated plan is acyclic with referential integrity
 * (planning.validatePlan), so the root walk reaches every node. */
export function formatPlanGraph(plan: PlanGraph): string {
  const byParent = new Map<string | undefined, PlanGraph["nodes"]>();
  for (const n of plan.nodes) {
    const siblings = byParent.get(n.parent);
    if (siblings) siblings.push(n);
    else byParent.set(n.parent, [n]);
  }
  const lines = [
    `◆ plan: ${plan.nodes.length} part${plan.nodes.length === 1 ? "" : "s"}, ${plan.relations.length} relation${plan.relations.length === 1 ? "" : "s"}`,
  ];
  const walk = (parent: string | undefined, depth: number): void => {
    for (const n of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}${n.id} — ${n.part}`);
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 1);
  for (const r of plan.relations) lines.push(`  ${r.from} —${r.kind}→ ${r.to}`);
  return lines.join("\n");
}

/** R5.1 transcript replay — render the persisted per-project conversation as prior-
 * session lines so reopening a project doesn't present an empty panel. Tool/system
 * turns are internal loop plumbing; only user/assistant turns are replayed. */
function hydrateTranscript(messages: ChatMessage[]): Line[] {
  const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (visible.length === 0) return [];
  const lines: Line[] = [
    { kind: "status", text: "— earlier messages in this project —", prior: true },
  ];
  for (const m of visible) {
    const text = messageText(m.content);
    lines.push({ kind: "text", text: m.role === "user" ? `> ${text}` : text, prior: true });
  }
  return lines;
}

/** Compact neutral first-run chooser (decision 17 / FR-5a) — local Ollama (no key,
 * offline) or a BYO Anthropic key. Persists via the aiStore.
 *
 * 6-L3 / R-10: the Ollama path DETECTS the running server instead of blindly saving a
 * fixed qwen2.5 @ localhost:11434 config. Detection lists the models actually installed
 * (tool-capable first) so the user saves one that exists; an unreachable/CORS-blocked
 * server shows an actionable start hint rather than a silent dead save. */
function FirstRunChooser(): React.JSX.Element {
  const save = useAiStore((s) => s.save);
  const [key, setKey] = useState("");
  // Ollama detection state machine: idle → the neutral detect button; detecting → in-flight;
  // reachable → the installed-model picker (empty ⇒ a "no models, pull one" hint); unreachable
  // → the start/CORS hint. A dead config is never persisted (the pre-6-L3 bug).
  const [detect, setDetect] = useState<"idle" | "detecting" | "reachable" | "unreachable">("idle");
  const [models, setModels] = useState<OllamaModelChoice[]>([]);
  const [chosenModel, setChosenModel] = useState("");

  const runDetect = async (): Promise<void> => {
    setDetect("detecting");
    const result = await detectOllama();
    if (!result.reachable) {
      setModels([]);
      setDetect("unreachable");
      return;
    }
    setModels(result.models);
    setChosenModel(result.models[0]?.name ?? "");
    setDetect("reachable");
  };

  const useOllama = (): void => {
    if (!chosenModel) return;
    void save({
      providerKey: "ollama",
      providerId: "openai-compatible",
      model: chosenModel,
      baseURL: OLLAMA_DEFAULT_V1,
      apiKeys: {},
    });
  };
  const useAnthropic = (): void => {
    if (!key.trim()) return;
    const settings: AiSettings = {
      providerKey: "anthropic",
      providerId: "anthropic",
      model: "claude-opus-4-8",
      apiKeys: { anthropic: key.trim() },
    };
    void save(settings);
  };
  return (
    <div data-testid="ai-setup" className="space-y-2 text-xs text-[#9ab]">
      <p>Choose an AI provider to generate parts:</p>
      {/* Local Ollama — detect what's actually installed, then save a model that exists. */}
      <div data-testid="ai-ollama" className="rounded border border-[#2a3444] bg-[#10141c] p-2">
        {detect === "idle" && (
          <button
            type="button"
            data-testid="ai-detect-ollama"
            onClick={() => void runDetect()}
            className="w-full rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-left text-[#cfe] hover:bg-[#16202c]"
          >
            Use local Ollama — detect installed models (no key, offline)
          </button>
        )}
        {detect === "detecting" && (
          <div data-testid="ai-ollama-detecting" className="text-[#789]">
            Detecting local Ollama…
          </div>
        )}
        {detect === "reachable" && models.length > 0 && (
          <div className="flex gap-1">
            <select
              data-testid="ai-ollama-model"
              value={chosenModel}
              onChange={(e) => setChosenModel(e.target.value)}
              className="min-w-0 flex-1 rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-1 text-[#cfe]"
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.toolCapable ? "" : " (tool support unverified)"}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="ai-use-ollama"
              onClick={useOllama}
              className="rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe] hover:bg-[#16202c]"
            >
              Use
            </button>
          </div>
        )}
        {detect === "reachable" && models.length === 0 && (
          <div data-testid="ai-ollama-empty" className="space-y-1 text-[#fb9]">
            <p>
              Ollama is running but no models are installed — pull one, e.g. `ollama pull qwen2.5`.
            </p>
            <button
              type="button"
              data-testid="ai-ollama-retry"
              onClick={() => void runDetect()}
              className="rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-0.5 text-[#cde] hover:bg-[#16202c]"
            >
              Retry detection
            </button>
          </div>
        )}
        {detect === "unreachable" && (
          <div data-testid="ai-ollama-unreachable" className="space-y-1 text-[#fb9]">
            <p>{ollamaNotDetectedMessage()}</p>
            <button
              type="button"
              data-testid="ai-ollama-retry"
              onClick={() => void runDetect()}
              className="rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-0.5 text-[#cde] hover:bg-[#16202c]"
            >
              Retry detection
            </button>
          </div>
        )}
      </div>
      <div className="flex gap-1">
        <input
          data-testid="ai-anthropic-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Anthropic API key (BYO)"
          className="min-w-0 flex-1 rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe]"
        />
        <button
          type="button"
          data-testid="ai-use-anthropic"
          onClick={useAnthropic}
          className="rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]"
        >
          Use
        </button>
      </div>
      {/* Advanced: OpenAI / other OpenAI-compatible, a custom model, a base URL, or a
          hosted proxy — the full configuration surface on first run too (FR-5a/FR-5b). */}
      <details data-testid="ai-setup-advanced" className="text-[10px] text-[#678]">
        <summary className="cursor-pointer select-none">Other provider / advanced…</summary>
        <div className="mt-1">
          <SettingsPanel />
        </div>
      </details>
      <p className="text-[10px] text-[#678]">
        Keys stay in your browser (IndexedDB) and are sent only to the provider you choose.
      </p>
    </div>
  );
}

/** Shown when a generated MESH document is open: convert it to editable CAD by sending it
 * to the reconstruction backend (R6.6) and loading the returned STEP as a B-rep part — or,
 * for smooth/organic shapes, fit NURBS surfaces via the SPEC-12 fitting service instead
 * (fitMeshToCad), landing through the same stepToImportDocument path. One action runs at a
 * time (shared busy/status/error state). */
function MeshConvertSection(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [keepNurbsEditable, setKeepNurbsEditable] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** In-flight job id from reconstructMesh/fitMeshToCad onJob — Cancel DELETEs it so the server
   * stops working a job nobody will collect (M4b), not just the client-side polling. */
  const jobIdRef = useRef<string | null>(null);
  /** Which service owns `jobIdRef` — reconstruct (:8000) vs nurbs (:8003); only one runs at a time. */
  const jobKindRef = useRef<"reconstruct" | "nurbs" | null>(null);

  const convert = useCallback(async (): Promise<void> => {
    const doc = useProjectsStore.getState().activeMeshDoc;
    if (!doc || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    jobKindRef.current = "reconstruct";
    setBusy(true);
    setError(null);
    setStatus("checking service…");
    const baseURL = useAiStore.getState().settings?.reconstructBaseURL;
    // Pre-flight GET /health (short timeout) so a down service fails in seconds with a
    // "start it with …" hint instead of submitting the job into a raw fetch error.
    const healthBase = (baseURL ?? RECONSTRUCT_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("reconstruct", healthBase));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      jobKindRef.current = null;
      return;
    }
    setStatus("submitting…");
    try {
      const result = await reconstructMesh(doc.glb, {
        ...(baseURL ? { baseURL } : {}),
        signal: controller.signal,
        onState: (s) => setStatus(s),
        onJob: (id) => {
          jobIdRef.current = id;
        },
      });
      const name = doc.name ?? "Reconstructed mesh";
      // Validate-then-commit (§2.12.2): a throw lands in the catch below, so the
      // store keeps the current document and the mesh stays open to retry from.
      await commitStepDocument(stepToImportDocument(result.step, name), {
        probe: liveBuildProbe(),
        load: (d) => useCadStore.getState().replaceDocument(d),
      });
      // M1: surface a pose/scale-robust fidelity readout (SCD) when the server reports it —
      // honest NFR-4 UX: "good" if the reconstructed surface tracks the mesh, "coarse" otherwise.
      const dev = result.report.surface_deviation;
      const tol = result.report.fidelity_tol ?? 0.01;
      const fidelity =
        typeof dev === "number" && Number.isFinite(dev)
          ? `, fidelity ${dev <= tol ? "good" : "coarse"} (Δ${dev.toFixed(4)})`
          : "";
      // M2c (SPEC-8): the structural fingerprint — tangent-connected regions recognised in
      // the INPUT mesh (box→6, cylinder→3, blob→many) — surfaced alongside faces_built for
      // honest UX (regions ≫ faces built means the conversion flattened real structure).
      // Absent on older servers → omitted.
      const regions = result.report.tangent_regions;
      const recognized =
        typeof regions === "number" && Number.isFinite(regions)
          ? `, ${regions} tangent region${regions === 1 ? "" : "s"}`
          : "";
      // Switch out of mesh mode: the viewport now renders the new B-rep part as a fresh
      // untitled parametric document (the original mesh project is left untouched).
      useProjectsStore.setState({
        activeMeshDoc: null,
        currentId: null,
        currentName: name,
        status: `converted to CAD — ${result.report.faces_built} face${result.report.faces_built === 1 ? "" : "s"}${result.report.is_solid ? ", solid" : ", shell"}${fidelity}${recognized}`,
      });
      setStatus(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else {
        setError(e instanceof Error ? e.message : String(e));
        setStatus(null);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      jobIdRef.current = null;
      jobKindRef.current = null;
    }
  }, [busy]);

  /** SPEC-12 FR-8 — the smooth/organic sibling of `convert`: fit NURBS surfaces to the mesh via
   * the fitting service and load the STEP through the same import path. The FR-9 report drives an
   * honest status line (shell vs solid, faceted fallbacks — NFR-5). */
  const fitSmooth = useCallback(async (): Promise<void> => {
    const doc = useProjectsStore.getState().activeMeshDoc;
    if (!doc || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    jobKindRef.current = "nurbs";
    setBusy(true);
    setError(null);
    setStatus("checking service…");
    const baseURL = useAiStore.getState().settings?.nurbsBaseURL;
    // Pre-flight GET /health (short timeout) BEFORE the minutes-long fit, so a down service
    // fails in seconds with a "start it with …" hint instead of a raw fetch error.
    const healthBase = (baseURL ?? NURBS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(nurbsUnreachableMessage(healthBase));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      jobKindRef.current = null;
      return;
    }
    setStatus("submitting…");
    try {
      const name = doc.name ?? "Fitted mesh";
      const { report } = await fitMeshToCad(
        doc.glb,
        {
          load: (d) => useCadStore.getState().replaceDocument(d),
          probe: liveBuildProbe(),
        },
        {
          keepEditable: keepNurbsEditable,
          signal: controller.signal,
          onState: (s) => setStatus(s),
          onJob: (id) => {
            jobIdRef.current = id;
          },
        },
        name,
      );
      // Switch out of mesh mode: the viewport now renders the fitted B-rep as a fresh untitled
      // parametric document (the original mesh project is left untouched) — the convert precedent.
      useProjectsStore.setState({
        activeMeshDoc: null,
        currentId: null,
        currentName: name,
        status: nurbsFitStatusMessage(report),
      });
      setStatus(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      jobIdRef.current = null;
      jobKindRef.current = null;
    }
  }, [busy, keepNurbsEditable]);

  /** Cancel: abort client-side polling immediately, then best-effort DELETE the server-side job
   * (M4b) — without it the service keeps reconstructing/fitting for nobody. A failed DELETE
   * (unreachable / already gone) must never surface in the error slot. */
  const cancel = useCallback(async (): Promise<void> => {
    const jobId = jobIdRef.current;
    const kind = jobKindRef.current;
    jobIdRef.current = null;
    jobKindRef.current = null;
    abortRef.current?.abort();
    if (!jobId || !kind) return;
    try {
      if (kind === "reconstruct") {
        const baseURL = useAiStore.getState().settings?.reconstructBaseURL;
        await cancelReconstruct(jobId, baseURL ? { baseURL } : {});
      } else {
        const baseURL = useAiStore.getState().settings?.nurbsBaseURL;
        await cancelFit(jobId, baseURL ? { baseURL } : {});
      }
    } catch {
      // Best-effort cleanup — swallow network errors (cancel already succeeded client-side).
    }
  }, []);

  return (
    <div data-testid="mesh-convert" className="space-y-2 text-xs text-[#9ab]">
      <p>
        This is a generated mesh. Convert it to an editable B-rep CAD part (STEP) via the
        reconstruction service.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="mesh-convert-run"
          onClick={() => void convert()}
          disabled={busy}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
        >
          {busy ? "Converting…" : "Convert to CAD (STEP)"}
        </button>
        <div className="flex flex-col gap-1">
          {/* SPEC-12 FR-8 + §15 Lane B: smooth fitting can land as editable
              control nets (default) or as the service's opaque STEP result. */}
          <button
            type="button"
            data-testid="mesh-nurbs-run"
            onClick={() => void fitSmooth()}
            disabled={busy}
            className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
          >
            Fit smooth CAD (NURBS)
          </button>
          <label className="flex items-center gap-1 text-[10px] text-[#9fc]">
            <input
              type="checkbox"
              data-testid="mesh-nurbs-keep-editable"
              checked={keepNurbsEditable}
              disabled={busy}
              onChange={(event) => setKeepNurbsEditable(event.currentTarget.checked)}
            />
            Keep editable control net
          </label>
        </div>
        {busy && (
          <button
            type="button"
            data-testid="mesh-convert-cancel"
            onClick={() => void cancel()}
            className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
          >
            Cancel
          </button>
        )}
        {/* FR-18: a mesh document is export-capable (GLB). The parametric export commands
            export the B-rep CadDocument via the worker and don't apply here, so a mesh doc
            gets its own binary GLB download straight from the inline base64 model. */}
        <button
          type="button"
          data-testid="mesh-export-glb"
          disabled={busy}
          onClick={() => {
            const doc = useProjectsStore.getState().activeMeshDoc;
            if (doc) exportMeshGlb(doc.glb, doc.name ?? "mesh");
          }}
          className="rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 text-[#cde] hover:bg-[#16202c] disabled:opacity-40"
        >
          Export GLB
        </button>
        {status && <span className="text-[10px] text-[#789]">{status}</span>}
      </div>
      {error && (
        <p data-testid="mesh-convert-error" className="text-[10px] text-[#fb9]">
          {error}
        </p>
      )}
      <p className="text-[10px] text-[#678]">
        Mechanical shapes (flats, holes) convert best via Convert to CAD; smooth/organic shapes fit
        best via NURBS (which rounds sharp edges — the result reports its fidelity honestly).
      </p>
    </div>
  );
}

/** Cap on photos per capture — bounds peak browser memory (each is base64-inflated ~33% and the whole
 * set is serialized into one /train POST body). Generous for photogrammetry; a real cap, not a guess. */
const MAX_CAPTURE_IMAGES = 300;

/** Server-truth defaults for the §5 /train training knobs (services/nerf TrainRequest). The section
 * sends a knob ONLY when the user moves it off its default — untouched controls keep the submit body
 * identical to the pre-knob panel (the @plastiq/nerf client omits unset fields on the wire). */
const NERF_DEFAULT_METHOD: NerfMethod = "neus";
const NERF_DEFAULT_ITERS = 500;
/** The service's iters cap (MAX_ITERS in services/nerf). */
const NERF_MAX_ITERS = 5000;
const NERF_DEFAULT_GRID_RES = 64;
/** Marching-cubes resolutions offered — a sane sweep inside the service's 16–256 bounds. */
const NERF_GRID_RES_CHOICES = [32, 64, 96, 128];
const NERF_DEFAULT_ENCODING: NerfEncoding = "frequency";
/** The service's fine-PDF (importance) samples-per-ray cap (MAX_IMPORTANCE_SAMPLES in services/nerf). */
const NERF_MAX_IMPORTANCE_SAMPLES = 128;

/** Parse a bounded numeric knob: blank/garbage falls back to the default, else clamps into [min, max]
 * (matching the input's own min/max, which jsdom and pasted values can bypass). */
function clampKnob(raw: string, min: number, max: number, dflt: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** SPEC-11 N11.3 — capture a mesh from posed photos via the @plastiq/nerf service. The user picks a
 * transforms.json (camera poses) + the images it describes; trainNerf fits an MLX surface server-side
 * and returns a GLB, persisted as a MeshDoc. On success the new project is OPENED (createMeshProject
 * only persists — it deliberately does not switch the active doc), so the panel switches to
 * MeshConvertSection — i.e. the captured mesh flows into the existing "Convert to CAD" (mesh → B-rep)
 * path. The nerf base URL comes from settings (nerfBaseURL). Training is the longest job in the app,
 * so it is abortable.
 *
 * A compact knobs row (11-L6) exposes the §5 training parameters — method (NeuS/NeRF), iters,
 * marching-cubes grid, position encoding (NeRF only — the neus SDF trunk has none, the server 422s
 * `hashgrid`+`neus`), and fine PDF samples. Every knob defaults to the SERVER default and is omitted
 * from the request until moved, so an untouched panel submits exactly what it did before. */
function NerfCaptureSection(): React.JSX.Element {
  const [transformsJson, setTransformsJson] = useState<string | null>(null);
  const [transformsName, setTransformsName] = useState<string | null>(null);
  // Selected images keep their filenames (11-M3) so they can be paired to transforms frames by
  // name, not by picker order — the server pairs images[i]↔frames[i], so selection order that
  // differs from the frames order would silently misassign poses. `data` is the base64 payload.
  const [images, setImages] = useState<NamedImage[]>([]);
  /** Set when pairing fell back to positional (transforms carried no per-frame file paths) —
   * a visible note so the user knows the order came from their selection, not the filenames. */
  const [pairingNote, setPairingNote] = useState<string | null>(null);
  // §5 training knobs (11-L6), all starting on the SERVER defaults (services/nerf TrainRequest) so
  // an untouched panel submits the same body it did before the knobs existed. The number inputs
  // keep the raw string (natural typing) and are parsed/clamped at submit time.
  const [method, setMethod] = useState<NerfMethod>(NERF_DEFAULT_METHOD);
  const [itersRaw, setItersRaw] = useState(String(NERF_DEFAULT_ITERS));
  const [gridRes, setGridRes] = useState(NERF_DEFAULT_GRID_RES);
  const [encoding, setEncoding] = useState<NerfEncoding>(NERF_DEFAULT_ENCODING);
  const [importanceRaw, setImportanceRaw] = useState("0");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The in-flight training job's server-side id (from trainNerf's onJob) — Cancel DELETEs it so
   * the server stops training a job nobody will collect (11-M2), not just the client-side polling. */
  const jobIdRef = useRef<string | null>(null);

  /** Switch the training model. The hash grid is the NeRF field's position encoding — the neus SDF
   * trunk consumes raw coordinates by design, so the service 422s `hashgrid`+`neus`. Mirror that
   * constraint truthfully: switching to neus resets the encoding (the select also disables). */
  const onMethod = useCallback((m: NerfMethod): void => {
    setMethod(m);
    if (m !== "nerf") setEncoding(NERF_DEFAULT_ENCODING);
  }, []);

  const onTransforms = useCallback(
    async (f?: File): Promise<void> => {
      if (!f || busy) return;
      setError(null);
      setPairingNote(null); // the frames changed — a stale pairing note would mislead
      setTransformsName(f.name);
      setTransformsJson(await fileToText(f));
    },
    [busy],
  );

  const onImages = useCallback(
    async (files: FileList | null): Promise<void> => {
      if (!files || files.length === 0 || busy) return;
      setError(null);
      setPairingNote(null);
      if (files.length > MAX_CAPTURE_IMAGES) {
        setError(`Too many images (${files.length}); the cap is ${MAX_CAPTURE_IMAGES}.`);
        return;
      }
      // Keep each file's NAME alongside its base64 payload for filename-based frame pairing (11-M3).
      setImages(
        await Promise.all(
          Array.from(files).map(async (f) => ({ name: f.name, data: await fileToBase64(f) })),
        ),
      );
    },
    [busy],
  );

  const capture = useCallback(async (): Promise<void> => {
    if (!transformsJson || images.length === 0 || busy) return;

    // Pair the photos to the transforms frames by FILENAME (not picker order) BEFORE the
    // (minutes-long) round-trip: the server pairs images[i]↔frames[i] positionally, so a
    // selection order that differs from the frames order would silently misassign poses (11-M3).
    // The helper also enforces the count invariant and reports JSON/missing/ambiguous errors.
    const pairing = pairImagesToFrames(images, transformsJson);
    if (!pairing.ok) {
      setError(pairing.error);
      return;
    }
    // Show the fallback note synchronously (before the health await) so it's visible; cleared
    // when the pairing matched by filename.
    setPairingNote(pairing.note ?? null);
    const orderedImages = pairing.order.map((i) => i.data);

    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    setBusy(true);
    setError(null);
    setStatus("checking service…");
    const baseURL = useAiStore.getState().settings?.nerfBaseURL;
    // Pre-flight GET /health (short timeout) BEFORE the minutes-long train job, so a
    // down service fails in seconds with a "start it with …" hint.
    const healthBase = (baseURL ?? NERF_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("nerf", healthBase));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      return;
    }
    setStatus("submitting…");
    // Send only the knobs the user moved off the server defaults — the client omits unset fields
    // on the wire (SPEC-11 §5), so an untouched panel's submit body is unchanged. Encoding rides
    // only with method "nerf" (the neus SDF trunk has no position encoding — the server 422s the
    // combo; onMethod already reset it, this guard just makes the invariant local and unmissable).
    const iters = clampKnob(itersRaw, 1, NERF_MAX_ITERS, NERF_DEFAULT_ITERS);
    const importanceSamples = clampKnob(importanceRaw, 0, NERF_MAX_IMPORTANCE_SAMPLES, 0);
    try {
      const { meshDocId } = await captureFromPhotos(
        {
          transformsJson,
          images: orderedImages,
          ...(method !== NERF_DEFAULT_METHOD ? { method } : {}),
          ...(iters !== NERF_DEFAULT_ITERS ? { iters } : {}),
          ...(gridRes !== NERF_DEFAULT_GRID_RES ? { gridRes } : {}),
          ...(method === "nerf" && encoding !== NERF_DEFAULT_ENCODING ? { encoding } : {}),
          ...(importanceSamples !== 0 ? { importanceSamples } : {}),
        },
        { persist: (doc) => useProjectsStore.getState().createMeshProject(doc) },
        {
          ...(baseURL ? { baseURL } : {}),
          signal: controller.signal,
          onState: (s) => setStatus(s),
          onJob: (id) => {
            jobIdRef.current = id;
          },
        },
        "Captured mesh",
      );
      // Open the new mesh project so the panel switches to MeshConvertSection ("Convert to CAD").
      await useProjectsStore.getState().open(meshDocId);
      setTransformsJson(null);
      setTransformsName(null);
      setImages([]);
      setStatus(null);
      // pairingNote is left as-is: on success the panel opens the mesh and this section
      // unmounts; the note otherwise clears when the user picks a new transforms/image set.
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      jobIdRef.current = null;
    }
  }, [transformsJson, images, busy, method, itersRaw, gridRes, encoding, importanceRaw]);

  /** Cancel: abort the client-side polling immediately, then best-effort DELETE the server-side
   * job (11-M2) — without it the service keeps training to completion for nobody. The DELETE
   * failing (service unreachable, job already gone — cancelJob itself tolerates the 404) must
   * never surface in the error slot: from the user's point of view the cancel already succeeded
   * the moment polling stopped. Auth/base URL are threaded exactly like the capture itself. */
  const cancel = useCallback(async (): Promise<void> => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    abortRef.current?.abort();
    if (!jobId) return;
    const baseURL = useAiStore.getState().settings?.nerfBaseURL;
    try {
      await cancelCapture(jobId, baseURL ? { baseURL } : {});
    } catch {
      // Best-effort cleanup — swallow abort-adjacent/network errors (see JSDoc above).
    }
  }, []);

  return (
    <div
      data-testid="nerf-capture"
      className="flex flex-col gap-1 rounded border border-[#1b2230] bg-black/20 p-2"
    >
      <div className="text-[10px] text-[#9ab]">Capture from photos (NeRF → mesh → CAD)</div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]">
        <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]">
          <input
            data-testid="nerf-transforms-input"
            type="file"
            accept=".json,application/json"
            className="hidden"
            disabled={busy}
            onChange={(e) => void onTransforms(e.target.files?.[0])}
          />
          {transformsName ? "Replace transforms.json" : "transforms.json"}
        </label>
        {transformsName && (
          <span data-testid="nerf-transforms-name" className="max-w-[9rem] truncate text-[#cde]">
            {transformsName}
          </span>
        )}
        <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]">
          <input
            data-testid="nerf-images-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => void onImages(e.target.files)}
          />
          {images.length > 0 ? `${images.length} image${images.length === 1 ? "" : "s"}` : "Images"}
        </label>
        <button
          type="button"
          data-testid="nerf-capture-btn"
          onClick={() => void capture()}
          disabled={busy || !transformsJson || images.length === 0}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
        >
          {busy ? "Capturing…" : "Capture"}
        </button>
        {busy && (
          <button
            type="button"
            data-testid="nerf-cancel-btn"
            onClick={() => void cancel()}
            className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
          >
            Cancel
          </button>
        )}
      </div>
      <div
        data-testid="nerf-knobs"
        className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]"
      >
        <div
          data-testid="nerf-method"
          className="flex overflow-hidden rounded border border-[#2a3444]"
        >
          <button
            type="button"
            data-testid="nerf-method-neus"
            onClick={() => onMethod("neus")}
            disabled={busy}
            className={`px-2 py-0.5 ${method === "neus" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
          >
            NeuS (surface)
          </button>
          <button
            type="button"
            data-testid="nerf-method-nerf"
            onClick={() => onMethod("nerf")}
            disabled={busy}
            className={`px-2 py-0.5 ${method === "nerf" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
          >
            NeRF (density)
          </button>
        </div>
        <label className="flex items-center gap-1">
          iters
          <input
            data-testid="nerf-iters"
            type="number"
            min={1}
            max={NERF_MAX_ITERS}
            step={100}
            value={itersRaw}
            disabled={busy}
            onChange={(e) => setItersRaw(e.target.value)}
            className="w-16 rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe]"
          />
        </label>
        <label className="flex items-center gap-1">
          grid
          <select
            data-testid="nerf-grid-res"
            value={gridRes}
            disabled={busy}
            onChange={(e) => setGridRes(Number(e.target.value))}
            className="rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe]"
          >
            {NERF_GRID_RES_CHOICES.map((r) => (
              <option key={r} value={r}>
                {r}³
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-1"
          title="Position encoding — NeRF (density) only; the NeuS SDF trunk has none"
        >
          encoding
          <select
            data-testid="nerf-encoding"
            value={encoding}
            disabled={busy || method !== "nerf"}
            onChange={(e) => setEncoding(e.target.value as NerfEncoding)}
            className="rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe] disabled:opacity-40"
          >
            <option value="frequency">frequency</option>
            <option value="hashgrid">hashgrid</option>
          </select>
        </label>
        <label
          className="flex items-center gap-1"
          title="Fine PDF (importance) samples per ray — 0 keeps the coarse-only default"
        >
          fine samples
          <input
            data-testid="nerf-importance"
            type="number"
            min={0}
            max={NERF_MAX_IMPORTANCE_SAMPLES}
            step={16}
            value={importanceRaw}
            disabled={busy}
            onChange={(e) => setImportanceRaw(e.target.value)}
            className="w-12 rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe]"
          />
        </label>
      </div>
      {pairingNote && (
        <div data-testid="nerf-pairing-note" className="text-[10px] text-[#9ab]">
          {pairingNote}
        </div>
      )}
      {status && (
        <div data-testid="nerf-status" className="text-[10px] text-[#789]">
          {status}
        </div>
      )}
      {error && (
        <div data-testid="nerf-error" className="text-[10px] text-[#fb9]">
          {error}
        </div>
      )}
    </div>
  );
}

/** SPEC-13 P11.2 — photogrammetry: unposed photos → camera poses + a dense oriented cloud, then two
 * hand-offs to the SAME "Convert to CAD" terminus. The user picks photos; `solvePhotogrammetry` runs
 * the SfM + MLX plane-sweep MVS solve server-side (:8004, minutes-long, abortable, Cancel DELETEs the
 * job). On success the panel offers two routes:
 *   (a) Poses → NeRF surface — the emitted transforms.json + the uploads (paired to its frames by
 *       filename) train an MLX surface (`captureFromPhotos` → MeshDoc), and
 *   (b) Dense cloud → mesh — the dense oriented cloud is reconstructed to a watertight MeshDoc via the
 *       capture service (`denseCloudToMeshDoc`).
 * Both persist a MeshDoc and OPEN it, so the panel switches to MeshConvertSection ("Convert to CAD" —
 * mesh → editable B-rep). Base URLs / keys come from the persisted service settings. */
function PhotoSolveSection(): React.JSX.Element {
  // Selected photos keep their filenames so the emitted frames can be paired back by name (the
  // NeRF hand-off pairs images[i]↔frames[i] positionally). `data` is the base64 payload.
  const [images, setImages] = useState<NamedImage[]>([]);
  const [dense, setDense] = useState(true);
  /** Sparse SfM longest-side cap (T39/M9); dense MVS still uses full native frames. */
  const [sparseMaxDim, setSparseMaxDim] = useState(DEFAULT_SPARSE_MAX_DIM);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PhotogrammetryResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The in-flight solve's server-side job id (from solvePhotogrammetry's onJob) — Cancel DELETEs it
   * so the server stops solving a job nobody will collect, not just the client-side polling. */
  const jobIdRef = useRef<string | null>(null);

  const onImages = useCallback(
    async (files: FileList | null): Promise<void> => {
      if (!files || files.length === 0 || busy) return;
      setError(null);
      setResult(null);
      if (files.length > MAX_CAPTURE_IMAGES) {
        setError(`Too many images (${files.length}); the cap is ${MAX_CAPTURE_IMAGES}.`);
        return;
      }
      setImages(
        await Promise.all(
          Array.from(files).map(async (f) => ({ name: f.name, data: await fileToBase64(f) })),
        ),
      );
    },
    [busy],
  );

  const solve = useCallback(async (): Promise<void> => {
    if (images.length < 3 || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus("checking service…");
    const baseURL = useAiStore.getState().settings?.photogrammetryBaseURL;
    // Pre-flight GET /health BEFORE the minutes-long solve, so a down service fails in seconds.
    const healthBase = (baseURL ?? PHOTOGRAMMETRY_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("photogrammetry", healthBase));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      return;
    }
    setStatus("solving (SfM + MVS — minutes)…");
    // Clamp to the service field range (256..4096); empty/invalid falls back to the app default.
    const dim =
      Number.isFinite(sparseMaxDim) && sparseMaxDim >= 256 && sparseMaxDim <= 4096
        ? Math.round(sparseMaxDim)
        : DEFAULT_SPARSE_MAX_DIM;
    try {
      const res = await solvePhotogrammetry(
        {
          images: images.map((i) => i.data),
          names: images.map((i) => i.name),
          dense,
          sparseMaxDim: dim,
        },
        {
          ...(baseURL ? { baseURL } : {}),
          signal: controller.signal,
          // Real job state on every poll (M4) — replaces the static "solving…" line with live progress.
          onState: (s: string) => setStatus(`solving (SfM + MVS — minutes)… [${s}]`),
          onJob: (id: string) => {
            jobIdRef.current = id;
          },
        },
      );
      setResult(res);
      const r = res.report;
      setStatus(
        `solved: ${r.images_registered}/${r.images_total} registered · ${r.sparse_points} sparse · ${r.dense_points} dense pts`,
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      jobIdRef.current = null;
    }
  }, [images, dense, sparseMaxDim, busy]);

  /** Cancel: abort the client-side polling immediately, then best-effort DELETE the server-side job.
   * A failing DELETE (unreachable, already gone) must never surface — the cancel already succeeded the
   * moment polling stopped. Base URL/auth are threaded exactly like the solve. */
  const cancel = useCallback(async (): Promise<void> => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    abortRef.current?.abort();
    if (!jobId) return;
    const baseURL = useAiStore.getState().settings?.photogrammetryBaseURL;
    try {
      await cancelPhotogrammetry(jobId, baseURL ? { baseURL } : {});
    } catch {
      // Best-effort cleanup — swallow abort-adjacent/network errors.
    }
  }, []);

  /** Hand-off (b): reconstruct the dense oriented cloud into a watertight mesh via the capture
   * service, then open it (→ Convert-to-CAD). */
  const toDenseMesh = useCallback(async (): Promise<void> => {
    if (!result?.densePly || busy) return;
    setBusy(true);
    setError(null);
    setStatus("checking capture service…");
    const captureBaseURL = useAiStore.getState().settings?.captureBaseURL;
    const healthBase = (captureBaseURL ?? CAPTURE_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("capture", healthBase));
      setStatus(null);
      setBusy(false);
      return;
    }
    setStatus("reconstructing dense mesh (minutes)…");
    try {
      const { meshDocId } = await denseCloudToMeshDoc(
        result.densePly,
        { persist: (doc) => useProjectsStore.getState().createMeshProject(doc) },
        captureBaseURL ? { baseURL: captureBaseURL } : {},
        "Photogrammetry mesh",
      );
      await useProjectsStore.getState().open(meshDocId);
      setResult(null);
      setImages([]);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [result, busy]);

  /** Hand-off (a): train an MLX surface from the emitted poses + the uploaded frames via the NeRF
   * service, then open it (→ Convert-to-CAD). Frames go in FRAME order: the original uploads paired
   * to the emitted frames by filename. */
  const toNerfSurface = useCallback(async (): Promise<void> => {
    if (!result || busy) return;
    const pairing = pairImagesToFrames(images, result.transformsJson);
    if (!pairing.ok) {
      setError(pairing.error);
      return;
    }
    const orderedImages = pairing.order.map((i) => i.data);
    setBusy(true);
    setError(null);
    setStatus("checking NeRF service…");
    const nerfBaseURL = useAiStore.getState().settings?.nerfBaseURL;
    const healthBase = (nerfBaseURL ?? NERF_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("nerf", healthBase));
      setStatus(null);
      setBusy(false);
      return;
    }
    setStatus("training surface (minutes)…");
    try {
      const { meshDocId } = await captureFromPhotos(
        { transformsJson: result.transformsJson, images: orderedImages },
        { persist: (doc) => useProjectsStore.getState().createMeshProject(doc) },
        {
          ...(nerfBaseURL ? { baseURL: nerfBaseURL } : {}),
          onState: (s) => setStatus(s),
        },
        "Photogrammetry surface",
      );
      await useProjectsStore.getState().open(meshDocId);
      setResult(null);
      setImages([]);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [result, images, busy]);

  return (
    <div
      data-testid="photo-solve"
      className="flex flex-col gap-1 rounded border border-[#1b2230] bg-black/20 p-2"
    >
      <div className="text-[10px] text-[#9ab]">
        Photogrammetry (photos → poses + point cloud → CAD)
      </div>
      <div className="text-[10px] text-[#789]">
        Pick 20–60 overlapping photos of one object (≥60% overlap between neighbours, even
        lighting).
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]">
        <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]">
          <input
            data-testid="photo-images-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => void onImages(e.target.files)}
          />
          {images.length > 0 ? `Replace photos (${images.length})` : "Choose photos"}
        </label>
        <label
          className="flex items-center gap-1"
          title="Run dense MVS (a dense oriented cloud → mesh); off = poses only"
        >
          <input
            data-testid="photo-dense"
            type="checkbox"
            checked={dense}
            disabled={busy}
            onChange={(e) => setDense(e.target.checked)}
          />
          dense
        </label>
        <label
          className="flex items-center gap-1"
          title="Longest-side cap for sparse SfM only (256–4096). Dense MVS still uses full-res frames. Default 1600."
        >
          sparse max
          <input
            data-testid="photo-sparse-max-dim"
            type="number"
            min={256}
            max={4096}
            step={1}
            value={sparseMaxDim}
            disabled={busy}
            onChange={(e) => setSparseMaxDim(Number(e.target.value))}
            className="w-16 rounded border border-[#2a3444] bg-[#10141c] px-1 py-0.5 text-[#cfe]"
          />
        </label>
        {!result && (
          <button
            data-testid="photo-solve-btn"
            type="button"
            disabled={busy || images.length < 3}
            onClick={() => void solve()}
            className="rounded border border-[#2a3444] bg-[#16202c] px-2 py-1 text-[#cfe] disabled:opacity-40 hover:bg-[#1c2a38]"
          >
            Solve
          </button>
        )}
        {busy && (
          <button
            data-testid="photo-cancel-btn"
            type="button"
            onClick={() => void cancel()}
            className="rounded border border-[#3a2430] bg-[#241016] px-2 py-1 text-[#fb9] hover:bg-[#2c161c]"
          >
            Cancel
          </button>
        )}
      </div>
      {result && (
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <button
            data-testid="photo-to-nerf-btn"
            type="button"
            disabled={busy}
            onClick={() => void toNerfSurface()}
            className="rounded border border-[#2a3444] bg-[#16202c] px-2 py-1 text-[#cfe] disabled:opacity-40 hover:bg-[#1c2a38]"
          >
            Poses → NeRF surface → CAD
          </button>
          <button
            data-testid="photo-to-mesh-btn"
            type="button"
            disabled={busy || !result.densePly}
            title={result.densePly ? undefined : "no dense cloud — re-solve with dense enabled"}
            onClick={() => void toDenseMesh()}
            className="rounded border border-[#2a3444] bg-[#16202c] px-2 py-1 text-[#cfe] disabled:opacity-40 hover:bg-[#1c2a38]"
          >
            Dense cloud → mesh → CAD
          </button>
        </div>
      )}
      {status && (
        <div data-testid="photo-status" className="text-[10px] text-[#789]">
          {status}
        </div>
      )}
      {error && (
        <div data-testid="photo-error" className="text-[10px] text-[#fb9]">
          {error}
        </div>
      )}
    </div>
  );
}

/** Cap on points per scan — bounds the JSON POST body (each point serializes to ~40–70 bytes, so
 * 200k oriented points ≈ 15–25 MB) and keeps the server-side SDF fit tractable. The server floor
 * is MIN_POINTS (its 400 below 16 points); this is the client-side ceiling. */
const MAX_CAPTURE_POINTS = 200_000;

/** SPEC-10 (browser client, 2026-07-03) — build a mesh from a point-cloud scan via the
 * @plastiq/capture service. The user picks a `.ply`/`.xyz`/`.json` scan file, parsed client-side
 * into the service's raw-array schema; two modes map to the two endpoints: **Capture** (`/capture`,
 * needs an ORIENTED cloud — points + normals) and **Complete** (`/complete`, a partial points-only
 * scan filled into a full mesh). The returned GLB is persisted as a MeshDoc and the new project is
 * OPENED (createMeshProject only persists), so the panel switches to MeshConvertSection — the scan
 * flows into the existing "Convert to CAD" (mesh → B-rep) path, exactly like the NeRF capture. The
 * base URL comes from settings (captureBaseURL); the job can run minutes, so it is abortable. */
function CaptureScanSection(): React.JSX.Element {
  const [cloud, setCloud] = useState<ParsedPointCloud | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<"capture" | "complete">("capture");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Sticky after a demo-weights complete so the user never confuses it with a trained model (M2). */
  const [demoBanner, setDemoBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Server job id from onJob — Cancel DELETEs this so the spawn worker is force-stopped (M4). */
  const jobIdRef = useRef<string | null>(null);

  const onFile = useCallback(
    async (f?: File): Promise<void> => {
      if (!f || busy) return;
      setError(null);
      setDemoBanner(null);
      try {
        const parsed = parsePointCloud(f.name, await fileToText(f));
        setCloud(parsed);
        setFileName(f.name);
        // A points-only file can never feed /capture (the server 400s without normals) — flip to
        // the mode that can consume it instead of letting the submit fail later.
        if (!parsed.normals) setMode("complete");
      } catch (e) {
        setCloud(null);
        setFileName(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [busy],
  );

  const run = useCallback(async (): Promise<void> => {
    if (!cloud || busy) return;

    // Client-side pre-checks BEFORE the round-trip: the server's own floor (main.py 400s under
    // 16 points), the browser-memory ceiling, and /capture's oriented-cloud requirement. The
    // parsers already guarantee Nx3 finite values and parallel normals.
    if (cloud.points.length < MIN_POINTS) {
      setError(
        `Too few points (${cloud.points.length}); the service needs at least ${MIN_POINTS}.`,
      );
      return;
    }
    if (cloud.points.length > MAX_CAPTURE_POINTS) {
      setError(`Too many points (${cloud.points.length}); the cap is ${MAX_CAPTURE_POINTS}.`);
      return;
    }
    if (mode === "capture" && !cloud.normals) {
      setError(
        "This file has no normals — Capture needs an oriented cloud (x y z nx ny nz). Switch to Complete, or export normals.",
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = null;
    setBusy(true);
    setError(null);
    setDemoBanner(null);
    setStatus("checking service…");
    const baseURL = useAiStore.getState().settings?.captureBaseURL;
    // Pre-flight GET /health (short timeout) BEFORE the minutes-long fit, so a down service
    // fails in seconds with a "start it with …" hint.
    const healthBase = (baseURL ?? CAPTURE_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!(await checkServiceHealth(healthBase))) {
      setError(serviceUnreachableMessage("capture", healthBase));
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
      return;
    }
    setStatus("submitting…");
    try {
      const deps = {
        persist: (doc: MeshDoc) => useProjectsStore.getState().createMeshProject(doc),
      };
      const opts = {
        ...(baseURL ? { baseURL } : {}),
        signal: controller.signal,
        onState: (s: string) => setStatus(s),
        onJob: (id: string) => {
          jobIdRef.current = id;
        },
      };
      if (mode === "capture") {
        const { meshDocId } = await meshFromPointCloud(
          { points: cloud.points, normals: cloud.normals! },
          deps,
          opts,
          "Scanned mesh",
        );
        await useProjectsStore.getState().open(meshDocId);
        setCloud(null);
        setFileName(null);
        setStatus(null);
      } else {
        const { meshDocId, report } = await meshFromPartialScan(
          { points: cloud.points },
          deps,
          opts,
          "Completed scan",
        );
        // M2: never present demo-weight completion as a silent trained success.
        if (report.demoWeights) {
          setDemoBanner(
            "Demo completion weights — this mesh is a synthetic sphere-family completer, not a trained real-world model. Set CAPTURE_COMPLETION_CHECKPOINT for production weights.",
          );
          setStatus("completed (demo weights)");
        } else {
          setStatus(null);
        }
        await useProjectsStore.getState().open(meshDocId);
        setCloud(null);
        setFileName(null);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      jobIdRef.current = null;
    }
  }, [cloud, mode, busy]);

  const cancel = useCallback(() => {
    const jobId = jobIdRef.current;
    abortRef.current?.abort();
    if (jobId) {
      const baseURL = useAiStore.getState().settings?.captureBaseURL;
      void cancelCaptureJob(jobId, baseURL ? { baseURL } : {}).catch(() => {
        /* 404 / network: poll abort still stops the UI */
      });
    }
  }, []);

  return (
    <div
      data-testid="capture-scan"
      className="flex flex-col gap-1 rounded border border-[#1b2230] bg-black/20 p-2"
    >
      <div className="text-[10px] text-[#9ab]">Scan to mesh (point cloud → mesh → CAD)</div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]">
        <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]">
          <input
            data-testid="capture-file-input"
            type="file"
            accept=".ply,.xyz,.json"
            className="hidden"
            disabled={busy}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {fileName ? "Replace scan" : "Scan file (.ply/.xyz/.json)"}
        </label>
        {fileName && cloud && (
          <span data-testid="capture-file-name" className="max-w-[11rem] truncate text-[#cde]">
            {fileName} ({cloud.points.length} pts{cloud.normals ? ", normals" : ""})
          </span>
        )}
        <div
          data-testid="capture-mode"
          className="flex overflow-hidden rounded border border-[#2a3444]"
        >
          <button
            type="button"
            data-testid="capture-mode-capture"
            onClick={() => setMode("capture")}
            disabled={busy}
            className={`px-2 py-0.5 ${mode === "capture" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
          >
            Capture (oriented)
          </button>
          <button
            type="button"
            data-testid="capture-mode-complete"
            onClick={() => setMode("complete")}
            disabled={busy}
            className={`px-2 py-0.5 ${mode === "complete" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
          >
            Complete partial scan
          </button>
        </div>
        <button
          type="button"
          data-testid="capture-run-btn"
          onClick={() => void run()}
          disabled={busy || !cloud}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
        >
          {busy
            ? mode === "capture"
              ? "Capturing…"
              : "Completing…"
            : mode === "capture"
              ? "Build mesh"
              : "Complete scan"}
        </button>
        {busy && (
          <button
            type="button"
            data-testid="capture-cancel-btn"
            onClick={cancel}
            className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
          >
            Cancel
          </button>
        )}
      </div>
      {status && (
        <div data-testid="capture-status" className="text-[10px] text-[#789]">
          {status}
        </div>
      )}
      {demoBanner && (
        <div
          data-testid="capture-demo-weights"
          className="rounded border border-[#7a5a2a] bg-[#221a10] px-2 py-1 text-[10px] text-[#fc9]"
        >
          ⚠ {demoBanner}
        </div>
      )}
      {error && (
        <div data-testid="capture-error" className="text-[10px] text-[#fb9]">
          {error}
        </div>
      )}
    </div>
  );
}

/** Compact affordance to set the creative mesh-gen (fal) API key (FR-15). The key is
 * stored in settings.apiKeys["fal"] and sent only to fal (or a configured proxy). A
 * DIRECT browser→fal call needs fal CORS — the proxy seam (meshGenBaseURL) is the
 * production path; this offers a BYO key for a CORS-enabled key/proxy. */
function CreativeKeyField(): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const save = useAiStore((s) => s.save);
  const [key, setKey] = useState("");
  if (!settings) return <></>;
  const configured = meshGenConfigured(settings);
  const saveKey = (): void => {
    if (!key.trim()) return;
    void save({ ...settings, apiKeys: { ...settings.apiKeys, fal: key.trim() } });
    setKey("");
  };
  return (
    <details data-testid="creative-key" className="text-[10px] text-[#678]">
      <summary className="cursor-pointer select-none">
        Creative mesh-gen (fal) {configured ? "✓ configured" : "— not configured"}
      </summary>
      <div className="mt-1 flex gap-1">
        <input
          data-testid="creative-key-input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="fal API key (for create_mesh)"
          className="min-w-0 flex-1 rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe]"
        />
        <button
          type="button"
          data-testid="creative-key-save"
          onClick={saveKey}
          className="rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]"
        >
          Save
        </button>
      </div>
      <p className="mt-1">
        Used only for AI mesh generation (organic shapes the parametric kernel can’t author). A
        direct browser call needs fal CORS; otherwise route through a proxy. The key stays in your
        browser and is sent only to the configured endpoint.
      </p>
    </details>
  );
}

/** Everything a generation run needs, captured at submit time so a failed run can be
 * retried verbatim (same prompt, same attachment, same route) via the Retry button. */
interface RunRequest {
  text: string;
  attached: Attachment | null;
  route: AttachmentRoute;
  meshProvider: string;
  /** Per-job image-gen provider for the text2img3d image stage (6-L1-ui) — captured so a
   * Retry re-runs with the same image model the user chose. */
  imageProvider: string;
}

export function GenerationPanel(): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const activeMeshDoc = useProjectsStore((s) => s.activeMeshDoc);
  const conversationProjectId = useAiStore((s) => s.conversationProjectId);
  // Session-cumulative usage across ALL runs (6-L2) — survives each generation so the readout
  // reflects the whole session, not just the last run (which lives in the per-run `usage` state).
  const sessionUsage = useAiStore((s) => s.sessionUsage);
  const [prompt, setPrompt] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [paidConfirm, setPaidConfirm] = useState<PendingConfirm | null>(null);
  // Image attachment + its route (FR-10a/FR-10b): a parametric vision reference, or the
  // creative image→3D path. `meshProviderId` is the 3D-gen provider for the creative route.
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachRoute, setAttachRoute] = useState<AttachmentRoute>("parametric");
  const [meshProviderId, setMeshProviderId] = useState("fal:tripo");
  // Per-job image-gen model for the text→image stage of AI text→3D (create_mesh text2img3d),
  // 6-L1-ui. Defaults to the persisted setting (or the catalog default); a run-scoped override
  // threaded through turnDeps.settings — NOT a save (that would change the persisted default and
  // defeat the per-job semantics). Mirrors meshProviderId's un-synced initial-value pattern.
  const [imageProviderId, setImageProviderId] = useState(
    settings?.imageProviderId ?? DEFAULT_IMAGE_PROVIDER_ID,
  );
  const abortRef = useRef<AbortController | null>(null);
  /** Monotonic id source for attachments (Date.now/Math.random are banned in some
   * contexts; a counter is deterministic and unique within a session). */
  const attachSeq = useRef(0);
  const { meshProviders, imageProviders } = useMemo(() => {
    if (!settings) return { meshProviders: [], imageProviders: [] };
    const deps = buildMeshGenDeps(settings);
    return { meshProviders: deps.providers, imageProviders: deps.imageProviders };
  }, [settings]);
  /** Set by create_mesh's persist dep when a mesh document is generated mid-run; the
   * panel opens it AFTER the agent loop so a success never swaps the UI mid-generation. */
  const createdMeshIdRef = useRef<string | null>(null);
  /** The last run that failed, kept so Retry can re-run it verbatim; null after a
   * success (or before any failure). */
  const [failedRun, setFailedRun] = useState<RunRequest | null>(null);

  const append = useCallback((line: Line): void => setLines((prev) => [...prev, line]), []);

  // R5.1 transcript replay — when the panel mounts or the open project changes, seed the
  // visible transcript from the persisted conversation (rendered dimmed as prior-session
  // messages) instead of an empty panel. Keyed on the project id: openConversation sets
  // the id and the loaded conversation together, and mid-run appendMessage updates only
  // the conversation, so a live transcript is never wiped by its own persistence.
  useEffect(() => {
    setLines(hydrateTranscript(useAiStore.getState().conversation.messages));
    setFailedRun(null);
  }, [conversationProjectId]);

  const run = useCallback(
    async (retryOf?: RunRequest): Promise<void> => {
      const current = useAiStore.getState().settings;
      if (!current || running) return;
      const req: RunRequest = retryOf ?? {
        text: prompt.trim(),
        attached: attachment,
        route: attachRoute,
        meshProvider: meshProviderId,
        imageProvider: imageProviderId,
      };
      const { text, attached } = req;
      if (!text && !attached) return;

      if (!buildSeam()) {
        append({
          kind: "error",
          text: "The geometry viewport isn’t ready yet — try again in a moment.",
          isError: true,
        });
        return;
      }

      const controller = new AbortController();
      const meter = new UsageMeter();
      createdMeshIdRef.current = null;

      // Shared agent-turn deps (build_part/inspect + create_mesh) — the SAME wiring the
      // command palette uses, so both entry points stay in lockstep. The attached image (if
      // any) is the img3d creative input, resolved by id (FR-10a). The model can always reach
      // create_mesh — and runGeneration derives the creative-path guidance from that tool
      // surface, so the prompt teaches what it offers; without a fal key/proxy the tool
      // fails cleanly (meshGenConfigured hints).
      const turnDeps: TurnToolsDeps = {
        // Per-job image-gen model override (6-L1-ui): the user's pick this run wins over the
        // persisted settings.imageProviderId, flowing through buildCreateMeshDeps → buildMeshGenDeps
        // to the create_mesh text2img3d image stage. img3d ignores imageProvider, so this is inert there.
        settings: { ...current, imageProviderId: req.imageProvider },
        confirm: (info) => new Promise<boolean>((resolve) => setPaidConfirm({ info, resolve })),
        recordPaidJob: () => {
          meter.addPaidJob();
          setUsage(meter.snapshot());
        },
        onMeshCreated: (id) => {
          createdMeshIdRef.current = id;
        },
        // 9-M1: render the committed plan as a structured, untruncated view (the trace
        // entry itself — kind "plan", full graph — is recorded by buildTurnTools).
        onPlan: (plan) => append({ kind: "tool", text: formatPlanGraph(plan) }),
        ...(attached
          ? {
              resolveImage: async (id: string) => {
                if (id === attached.id) return attached.image;
                throw new Error(`no attached image with id '${id}'`);
              },
            }
          : {}),
        signal: controller.signal,
      };
      const tools = buildTurnTools(turnDeps);
      if (!tools) {
        append({
          kind: "error",
          text: "The geometry viewport isn’t ready yet — try again in a moment.",
          isError: true,
        });
        return;
      }

      // Key resolution goes through the decision-21 indirection: BYO key locally, or the
      // hosted-proxy resolver when the settings are in the proxy state (registry decides).
      const provider = buildProvider(toProviderSettings(current, keyResolverFor(current)));
      const ai = useAiStore.getState();
      const history = ai.conversation.messages;
      const currentDoc = useCadStore.getState().toDocument();

      // Route an attached image (FR-10a/FR-10b): a parametric vision reference, the creative
      // image→3D path, or disabled when the model can't see and the user chose parametric.
      let agentInput: string | ContentPart[] = text;
      let directCreative: { mode: "img3d"; imageId: string; prompt?: string } | null = null;
      if (attached) {
        const plan = planAttachmentRoute({
          route: req.route,
          prompt: text,
          image: attached.image,
          imageId: attached.id,
          supportsVision: provider.supportsVision,
        });
        if (plan.kind === "disabled") {
          append({ kind: "error", text: plan.reason, isError: true });
          return; // before setRunning — no run started
        }
        if (plan.kind === "parametric") agentInput = plan.userContent;
        else directCreative = plan.createMeshInput;
      }

      abortRef.current = controller;
      setRunning(true);
      setFailedRun(null);
      const routeTag = attached
        ? ` [${req.route === "creative" ? "→3D" : "vision"}: ${attached.name}]`
        : "";
      append({ kind: "text", text: `> ${text || "(image)"}${routeTag}` });
      void ai.appendMessage({ role: "user", content: text || "(image attached)" });
      if (!retryOf) {
        setPrompt("");
        setAttachment(null);
      }

      // Provider failures reach us as `[provider error]`/`[error]` text relays (agentRunner)
      // or a thrown Error; translate the common classes to actionable lines (raw kept as the
      // collapsed detail) and remember the request so the user can Retry it verbatim.
      const endpoint: ProviderEndpoint = providerEndpoint(current);
      let failed = false;
      const appendFailure = (raw: string): void => {
        failed = true;
        const hint = translateProviderError(raw, endpoint);
        append(
          hint
            ? { kind: "error", text: hint.friendly, detail: hint.raw, isError: true }
            : { kind: "error", text: raw, isError: true },
        );
      };

      let assistantText = "";
      try {
        if (directCreative) {
          // Creative image→3D runs the create_mesh pipeline directly (no LLM needed): the
          // attached image + the user-selected 3D-gen provider, gated by the paid confirm.
          append({ kind: "tool", text: `→ create_mesh(img3d via ${req.meshProvider})` });
          void ai.appendTrace({
            kind: "tool-call",
            name: "create_mesh",
            detail: `img3d via ${req.meshProvider}`,
          });
          const r = await createMesh(
            { ...directCreative, providerId: req.meshProvider },
            buildCreateMeshDeps(turnDeps),
          );
          if (r.status === "error") failed = true;
          append({
            kind: r.status === "error" ? "error" : "status",
            text: r.message,
            isError: r.status === "error",
          });
          void ai.appendTrace({
            kind: "tool-result",
            name: "create_mesh",
            detail: r.message,
            isError: r.status === "error",
          });
        } else {
          await runGeneration({
            provider,
            input: agentInput,
            history,
            currentDoc,
            tools,
            signal: controller.signal,
            onEvent: (e) => {
              if (e.type === "text") {
                // agentRunner relays provider failures as `[provider error] …` / `[error] …`
                // text events; route those through the translation layer instead of the
                // assistant transcript (and keep them out of the persisted assistant turn).
                const marker = /^\n?\[(?:provider )?error\] (.*)$/s.exec(e.text);
                if (marker?.[1] != null) {
                  appendFailure(marker[1]);
                  return;
                }
                assistantText += e.text;
                append({ kind: "text", text: e.text });
              } else if (e.type === "tool-call") {
                const detail = JSON.stringify(e.args).slice(0, 200);
                append({ kind: "tool", text: `→ ${e.name}(${detail})` });
                void ai.appendTrace({ kind: "tool-call", name: e.name, detail });
              } else if (e.type === "tool-result") {
                append({
                  kind: "tool",
                  text: `← ${e.name}: ${e.result.slice(0, 200)}`,
                  isError: e.isError,
                });
                void ai.appendTrace({
                  kind: "tool-result",
                  name: e.name,
                  detail: e.result.slice(0, 200),
                  isError: e.isError,
                });
              } else if (e.type === "usage") {
                meter.addTokens({ inputTokens: e.inputTokens, outputTokens: e.outputTokens });
                setUsage(meter.snapshot());
              } else if (e.type === "status") {
                if (e.finish === "error") failed = true;
                append({
                  kind: "status",
                  text: `[${e.finish} · ${e.steps} step${e.steps === 1 ? "" : "s"}]`,
                });
              }
            },
          });
          if (assistantText.trim())
            void ai.appendMessage({ role: "assistant", content: assistantText });
        }
        // If create_mesh produced a mesh document this run, open it now (AFTER the loop)
        // so the panel switches to the convert-to-CAD view without yanking a live run.
        const newMeshId = createdMeshIdRef.current;
        createdMeshIdRef.current = null;
        if (newMeshId) {
          append({ kind: "status", text: "Opening the generated mesh — convert it to CAD below." });
          await useProjectsStore.getState().open(newMeshId);
        }
      } catch (e) {
        appendFailure(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
        abortRef.current = null;
        // A failed run is retryable verbatim; a success clears any earlier failure.
        setFailedRun(failed ? req : null);
        // Fold this run's usage into the session total (6-L2). Only meaningful runs count — a
        // run that spent no tokens and no paid jobs (e.g. an instant connection failure) is not a
        // "turn". Folded exactly once per run (the per-run meter's final snapshot).
        const runSnap = meter.snapshot();
        if (runSnap.totalTokens > 0 || runSnap.paidJobs > 0)
          useAiStore.getState().recordRunUsage(runSnap);
      }
    },
    [prompt, running, append, attachment, attachRoute, meshProviderId, imageProviderId],
  );

  const retry = useCallback((): void => {
    const req = failedRun;
    if (!req || running) return;
    void run(req);
  }, [failedRun, running, run]);

  const cancel = useCallback((): void => abortRef.current?.abort(), []);

  const onAttachFile = useCallback(async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const image = await fileToGenImage(file);
    attachSeq.current += 1;
    setAttachment({ image, id: `att-${attachSeq.current}`, name: file.name });
  }, []);

  return (
    <div data-testid="generation-panel" className="flex flex-col gap-2 text-xs">
      {activeMeshDoc ? (
        <MeshConvertSection />
      ) : isFirstRun(settings) ? (
        <FirstRunChooser />
      ) : (
        <>
          {paidConfirm && (
            <PaidJobConfirmModal
              info={paidConfirm.info}
              onResolve={(ok) => {
                paidConfirm.resolve(ok);
                setPaidConfirm(null);
              }}
            />
          )}
          <textarea
            data-testid="generation-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
            }}
            rows={3}
            placeholder="Describe a part to build or edit — e.g. “a 40×20×10 mm bracket with a 5 mm fillet on the top edges”. ⌘/Ctrl+Enter to send."
            disabled={running}
            className="w-full resize-none rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe] placeholder:text-[#566] disabled:opacity-60"
          />
          {/* Image attach + route (FR-10a/FR-10b): a parametric vision reference (needs a
              vision-capable model) or the creative image→3D path (picks a 3D-gen provider). */}
          <div
            data-testid="attach-row"
            className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]"
          >
            <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]">
              <input
                data-testid="attach-input"
                type="file"
                accept="image/*"
                className="hidden"
                disabled={running}
                onChange={(e) => void onAttachFile(e.target.files?.[0])}
              />
              {attachment ? "Replace image" : "Attach image"}
            </label>
            {attachment && (
              <>
                <span data-testid="attach-name" className="max-w-[10rem] truncate text-[#cde]">
                  {attachment.name}
                </span>
                <button
                  type="button"
                  data-testid="attach-clear"
                  onClick={() => setAttachment(null)}
                  className="rounded border border-[#7a3a3a] bg-[#2a1414] px-1.5 py-0.5 text-[#fbb] hover:bg-[#341a1a]"
                >
                  ✕
                </button>
                <div
                  data-testid="attach-route"
                  className="ml-1 flex overflow-hidden rounded border border-[#2a3444]"
                >
                  <button
                    type="button"
                    data-testid="attach-route-parametric"
                    onClick={() => setAttachRoute("parametric")}
                    className={`px-2 py-0.5 ${attachRoute === "parametric" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
                  >
                    Reference (parametric)
                  </button>
                  <button
                    type="button"
                    data-testid="attach-route-creative"
                    onClick={() => setAttachRoute("creative")}
                    className={`px-2 py-0.5 ${attachRoute === "creative" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"}`}
                  >
                    Generate mesh (image→3D)
                  </button>
                </div>
                {attachRoute === "creative" && (
                  <select
                    data-testid="attach-mesh-provider"
                    value={meshProviderId}
                    onChange={(e) => setMeshProviderId(e.target.value)}
                    className="rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe]"
                  >
                    {meshProviders
                      .filter((p) => p.supports.img3d)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </select>
                )}
              </>
            )}
          </div>
          {/* Per-job image-gen model (6-L1-ui) for AI text→3D (create_mesh text2img3d): the
              LLM turns a text prompt into an image with this model, then image→3D. Standalone
              (not gated on an attachment — text2img3d is text-only); only shown when there's a
              choice. The pick overrides settings.imageProviderId for this run only. */}
          {imageProviders.length > 1 && (
            <div
              data-testid="image-gen-row"
              className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]"
            >
              <label
                className="flex items-center gap-1"
                title="Image model for the text→image stage of AI text→3D generation (create_mesh text2img3d)"
              >
                Image model (text→3D)
                <select
                  data-testid="image-gen-provider"
                  value={imageProviderId}
                  disabled={running}
                  onChange={(e) => setImageProviderId(e.target.value)}
                  className="rounded border border-[#2a3444] bg-[#0b0d12] px-1 py-0.5 text-[#cfe] disabled:opacity-40"
                >
                  {imageProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="generation-send"
              onClick={() => void run()}
              disabled={running || (!prompt.trim() && !attachment)}
              className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
            >
              {running ? "Generating…" : "Generate"}
            </button>
            {running && (
              <button
                type="button"
                data-testid="generation-cancel"
                onClick={cancel}
                className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
              >
                Cancel
              </button>
            )}
            {!running && failedRun && (
              <button
                type="button"
                data-testid="generation-retry"
                onClick={retry}
                className="rounded border border-[#7a5a3a] bg-[#2a2014] px-2 py-1 text-[#fdb] hover:bg-[#342a1a]"
              >
                Retry
              </button>
            )}
            {(usage || sessionUsage.turns > 0) && (
              <span className="ml-auto text-right text-[10px] text-[#789]">
                {usage && (
                  <span data-testid="generation-usage">
                    {usage.totalTokens} tok{usage.paidJobs > 0 ? ` · ${usage.paidJobs} paid` : ""}
                  </span>
                )}
                {sessionUsage.turns > 0 && (
                  <span
                    data-testid="generation-usage-session"
                    className={`text-[#678] ${usage ? "ml-2" : ""}`}
                  >
                    session {sessionUsage.totalTokens} tok · {sessionUsage.turns} run
                    {sessionUsage.turns === 1 ? "" : "s"}
                    {sessionUsage.paidJobs > 0 ? ` · ${sessionUsage.paidJobs} paid` : ""}
                  </span>
                )}
              </span>
            )}
          </div>
          {lines.length > 0 && (
            <div
              data-testid="generation-transcript"
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#1b2230] bg-black/30 p-2 font-mono text-[10px] leading-snug"
            >
              {lines.map((l, i) => (
                <div
                  key={i}
                  {...(l.prior ? { "data-prior": "true" } : {})}
                  className={`${
                    l.isError
                      ? "text-[#fb9]"
                      : l.kind === "tool"
                        ? "text-[#9cf]"
                        : l.kind === "status"
                          ? "text-[#789]"
                          : "text-[#cde]"
                  }${l.prior ? " opacity-60" : ""}`}
                >
                  {l.text}
                  {l.detail && (
                    <details data-testid="error-detail" className="text-[#a87]">
                      <summary className="cursor-pointer select-none">raw error</summary>
                      {l.detail}
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
          <NerfCaptureSection />
          <CaptureScanSection />
          <PhotoSolveSection />
          <CreativeKeyField />
          {/* Full provider/model/base-URL/key configuration (FR-4/FR-5/FR-5b) — collapsed
              by default so the prompt stays the focus; the first-run chooser only sets the
              minimum, this is where the curated model picker + proxy/service URLs live. */}
          <details data-testid="ai-settings" className="text-[10px] text-[#678]">
            <summary className="cursor-pointer select-none">⚙ Provider settings</summary>
            <div className="mt-1">
              <SettingsPanel />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
