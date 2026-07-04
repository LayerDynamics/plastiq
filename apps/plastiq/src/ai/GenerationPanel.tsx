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
import { buildProvider } from "./providers/registry.js";
import { toProviderSettings, type AiSettings } from "./settings.js";
import { runGeneration } from "./runGeneration.js";
import { reconstructMesh, stepToImportDocument } from "./reconstruct.js";
import { captureFromPhotos } from "./nerf.js";
import { meshFromPartialScan, meshFromPointCloud } from "./capture.js";
import { parsePointCloud, MIN_POINTS, type ParsedPointCloud } from "@plastiq/capture";
import {
  checkServiceHealth,
  providerEndpoint,
  serviceUnreachableMessage,
  translateProviderError,
  CAPTURE_DEFAULT_BASE_URL,
  NERF_DEFAULT_BASE_URL,
  RECONSTRUCT_DEFAULT_BASE_URL,
  type ProviderEndpoint,
} from "./errorHints.js";
import { fileToBase64, fileToText } from "./fileRead.js";
import { exportMeshGlb } from "../mesh/exportGlb.js";
import { buildMeshGenDeps, meshGenConfigured } from "./meshGenDeps.js";
import { buildTurnTools, buildCreateMeshDeps, buildSeam, type TurnToolsDeps } from "./agentTurn.js";
import { PaidJobConfirmModal, type PendingConfirm } from "./PaidJobConfirmModal.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { planAttachmentRoute, type AttachmentRoute } from "./visionRoute.js";
import { UsageMeter, type UsageSnapshot } from "./usage.js";
import { createMesh } from "./tools/createMesh.js";
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
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
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

/** R5.1 transcript replay — render the persisted per-project conversation as prior-
 * session lines so reopening a project doesn't present an empty panel. Tool/system
 * turns are internal loop plumbing; only user/assistant turns are replayed. */
function hydrateTranscript(messages: ChatMessage[]): Line[] {
  const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (visible.length === 0) return [];
  const lines: Line[] = [{ kind: "status", text: "— earlier messages in this project —", prior: true }];
  for (const m of visible) {
    const text = messageText(m.content);
    lines.push({ kind: "text", text: m.role === "user" ? `> ${text}` : text, prior: true });
  }
  return lines;
}

/** Compact neutral first-run chooser (decision 17 / FR-5a) — local Ollama (no key,
 * offline) or a BYO Anthropic key. Persists via the aiStore. */
function FirstRunChooser(): React.JSX.Element {
  const save = useAiStore((s) => s.save);
  const [key, setKey] = useState("");
  const useOllama = (): void => {
    void save({
      providerKey: "ollama",
      providerId: "openai-compatible",
      model: "qwen2.5",
      baseURL: "http://localhost:11434/v1",
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
      <button
        type="button"
        data-testid="ai-use-ollama"
        onClick={useOllama}
        className="w-full rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 text-left text-[#cfe] hover:bg-[#16202c]"
      >
        Use local Ollama (qwen2.5) — no key, offline
      </button>
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
 * to the reconstruction backend (R6.6) and loading the returned STEP as a B-rep part. */
function MeshConvertSection(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const convert = useCallback(async (): Promise<void> => {
    const doc = useProjectsStore.getState().activeMeshDoc;
    if (!doc || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
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
      return;
    }
    setStatus("submitting…");
    try {
      const result = await reconstructMesh(doc.glb, {
        ...(baseURL ? { baseURL } : {}),
        signal: controller.signal,
        onState: (s) => setStatus(s),
      });
      const name = doc.name ?? "Reconstructed mesh";
      useCadStore.getState().loadDocument(stepToImportDocument(result.step, name));
      // M1: surface a pose/scale-robust fidelity readout (SCD) when the server reports it —
      // honest NFR-4 UX: "good" if the reconstructed surface tracks the mesh, "coarse" otherwise.
      const dev = result.report.surface_deviation;
      const tol = result.report.fidelity_tol ?? 0.01;
      const fidelity =
        typeof dev === "number" && Number.isFinite(dev)
          ? `, fidelity ${dev <= tol ? "good" : "coarse"} (Δ${dev.toFixed(4)})`
          : "";
      // Switch out of mesh mode: the viewport now renders the new B-rep part as a fresh
      // untitled parametric document (the original mesh project is left untouched).
      useProjectsStore.setState({
        activeMeshDoc: null,
        currentId: null,
        currentName: name,
        status: `converted to CAD — ${result.report.faces_built} face${result.report.faces_built === 1 ? "" : "s"}${result.report.is_solid ? ", solid" : ", shell"}${fidelity}`,
      });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy]);

  return (
    <div data-testid="mesh-convert" className="space-y-2 text-xs text-[#9ab]">
      <p>This is a generated mesh. Convert it to an editable B-rep CAD part (STEP) via the reconstruction service.</p>
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
        {busy && (
          <button
            type="button"
            data-testid="mesh-convert-cancel"
            onClick={() => abortRef.current?.abort()}
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
        Organic shapes reconstruct as dense surfaces; mechanical shapes (flats, holes) convert best.
      </p>
    </div>
  );
}

/** Cap on photos per capture — bounds peak browser memory (each is base64-inflated ~33% and the whole
 * set is serialized into one /train POST body). Generous for photogrammetry; a real cap, not a guess. */
const MAX_CAPTURE_IMAGES = 300;

/** SPEC-11 N11.3 — capture a mesh from posed photos via the @plastiq/nerf service. The user picks a
 * transforms.json (camera poses) + the images it describes; trainNerf fits an MLX surface server-side
 * and returns a GLB, persisted as a MeshDoc. On success the new project is OPENED (createMeshProject
 * only persists — it deliberately does not switch the active doc), so the panel switches to
 * MeshConvertSection — i.e. the captured mesh flows into the existing "Convert to CAD" (mesh → B-rep)
 * path. The nerf base URL comes from settings (nerfBaseURL). Training is the longest job in the app,
 * so it is abortable. */
function NerfCaptureSection(): React.JSX.Element {
  const [transformsJson, setTransformsJson] = useState<string | null>(null);
  const [transformsName, setTransformsName] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onTransforms = useCallback(
    async (f?: File): Promise<void> => {
      if (!f || busy) return;
      setError(null);
      setTransformsName(f.name);
      setTransformsJson(await fileToText(f));
    },
    [busy],
  );

  const onImages = useCallback(
    async (files: FileList | null): Promise<void> => {
      if (!files || files.length === 0 || busy) return;
      setError(null);
      if (files.length > MAX_CAPTURE_IMAGES) {
        setError(`Too many images (${files.length}); the cap is ${MAX_CAPTURE_IMAGES}.`);
        return;
      }
      setImages(await Promise.all(Array.from(files).map(fileToBase64)));
    },
    [busy],
  );

  const capture = useCallback(async (): Promise<void> => {
    if (!transformsJson || images.length === 0 || busy) return;

    // Validate the photos are parallel to the transforms frames BEFORE the (minutes-long) round-trip.
    let frameCount: number;
    try {
      const parsed = JSON.parse(transformsJson) as { frames?: unknown };
      if (!Array.isArray(parsed.frames)) {
        setError("transforms.json has no 'frames' array.");
        return;
      }
      frameCount = parsed.frames.length;
    } catch {
      setError("transforms.json is not valid JSON.");
      return;
    }
    if (frameCount !== images.length) {
      setError(`Image count (${images.length}) must match transforms frames (${frameCount}).`);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
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
    try {
      const { meshDocId } = await captureFromPhotos(
        { transformsJson, images },
        { persist: (doc) => useProjectsStore.getState().createMeshProject(doc) },
        { ...(baseURL ? { baseURL } : {}), signal: controller.signal, onState: (s) => setStatus(s) },
        "Captured mesh",
      );
      // Open the new mesh project so the panel switches to MeshConvertSection ("Convert to CAD").
      await useProjectsStore.getState().open(meshDocId);
      setTransformsJson(null);
      setTransformsName(null);
      setImages([]);
      setStatus(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [transformsJson, images, busy]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div data-testid="nerf-capture" className="flex flex-col gap-1 rounded border border-[#1b2230] bg-black/20 p-2">
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
            onClick={cancel}
            className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
          >
            Cancel
          </button>
        )}
      </div>
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
  const abortRef = useRef<AbortController | null>(null);

  const onFile = useCallback(
    async (f?: File): Promise<void> => {
      if (!f || busy) return;
      setError(null);
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
      setError(`Too few points (${cloud.points.length}); the service needs at least ${MIN_POINTS}.`);
      return;
    }
    if (cloud.points.length > MAX_CAPTURE_POINTS) {
      setError(`Too many points (${cloud.points.length}); the cap is ${MAX_CAPTURE_POINTS}.`);
      return;
    }
    if (mode === "capture" && !cloud.normals) {
      setError("This file has no normals — Capture needs an oriented cloud (x y z nx ny nz). Switch to Complete, or export normals.");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
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
      const deps = { persist: (doc: MeshDoc) => useProjectsStore.getState().createMeshProject(doc) };
      const opts = { ...(baseURL ? { baseURL } : {}), signal: controller.signal, onState: (s: string) => setStatus(s) };
      const { meshDocId } =
        mode === "capture"
          ? await meshFromPointCloud({ points: cloud.points, normals: cloud.normals! }, deps, opts, "Scanned mesh")
          : await meshFromPartialScan({ points: cloud.points }, deps, opts, "Completed scan");
      // Open the new mesh project so the panel switches to MeshConvertSection ("Convert to CAD").
      await useProjectsStore.getState().open(meshDocId);
      setCloud(null);
      setFileName(null);
      setStatus(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setStatus("cancelled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [cloud, mode, busy]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div data-testid="capture-scan" className="flex flex-col gap-1 rounded border border-[#1b2230] bg-black/20 p-2">
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
        <div data-testid="capture-mode" className="flex overflow-hidden rounded border border-[#2a3444]">
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
          {busy ? (mode === "capture" ? "Capturing…" : "Completing…") : mode === "capture" ? "Build mesh" : "Complete scan"}
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
        Used only for AI mesh generation (organic shapes the parametric kernel can’t author).
        A direct browser call needs fal CORS; otherwise route through a proxy. The key stays in
        your browser and is sent only to the configured endpoint.
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
}

export function GenerationPanel(): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const activeMeshDoc = useProjectsStore((s) => s.activeMeshDoc);
  const conversationProjectId = useAiStore((s) => s.conversationProjectId);
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
  const abortRef = useRef<AbortController | null>(null);
  /** Monotonic id source for attachments (Date.now/Math.random are banned in some
   * contexts; a counter is deterministic and unique within a session). */
  const attachSeq = useRef(0);
  const meshProviders = useMemo(() => (settings ? buildMeshGenDeps(settings).providers : []), [settings]);
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

  const run = useCallback(async (retryOf?: RunRequest): Promise<void> => {
    const current = useAiStore.getState().settings;
    if (!current || running) return;
    const req: RunRequest = retryOf ?? {
      text: prompt.trim(),
      attached: attachment,
      route: attachRoute,
      meshProvider: meshProviderId,
    };
    const { text, attached } = req;
    if (!text && !attached) return;

    if (!buildSeam()) {
      append({ kind: "error", text: "The geometry viewport isn’t ready yet — try again in a moment.", isError: true });
      return;
    }

    const controller = new AbortController();
    const meter = new UsageMeter();
    createdMeshIdRef.current = null;

    // Shared agent-turn deps (build_part/inspect + create_mesh) — the SAME wiring the
    // command palette uses, so both entry points stay in lockstep. The attached image (if
    // any) is the img3d creative input, resolved by id (FR-10a). The model can always reach
    // create_mesh; without a fal key/proxy it fails cleanly (meshGenConfigured hints).
    const turnDeps: TurnToolsDeps = {
      settings: current,
      confirm: (info) => new Promise<boolean>((resolve) => setPaidConfirm({ info, resolve })),
      recordPaidJob: () => {
        meter.addPaidJob();
        setUsage(meter.snapshot());
      },
      onMeshCreated: (id) => {
        createdMeshIdRef.current = id;
      },
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
      append({ kind: "error", text: "The geometry viewport isn’t ready yet — try again in a moment.", isError: true });
      return;
    }

    const provider = buildProvider(toProviderSettings(current));
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
    const routeTag = attached ? ` [${req.route === "creative" ? "→3D" : "vision"}: ${attached.name}]` : "";
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
        void ai.appendTrace({ kind: "tool-call", name: "create_mesh", detail: `img3d via ${req.meshProvider}` });
        const r = await createMesh({ ...directCreative, providerId: req.meshProvider }, buildCreateMeshDeps(turnDeps));
        if (r.status === "error") failed = true;
        append({ kind: r.status === "error" ? "error" : "status", text: r.message, isError: r.status === "error" });
        void ai.appendTrace({ kind: "tool-result", name: "create_mesh", detail: r.message, isError: r.status === "error" });
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
              append({ kind: "tool", text: `← ${e.name}: ${e.result.slice(0, 200)}`, isError: e.isError });
              void ai.appendTrace({ kind: "tool-result", name: e.name, detail: e.result.slice(0, 200), isError: e.isError });
            } else if (e.type === "usage") {
              meter.addTokens({ inputTokens: e.inputTokens, outputTokens: e.outputTokens });
              setUsage(meter.snapshot());
            } else if (e.type === "status") {
              if (e.finish === "error") failed = true;
              append({ kind: "status", text: `[${e.finish} · ${e.steps} step${e.steps === 1 ? "" : "s"}]` });
            }
          },
        });
        if (assistantText.trim()) void ai.appendMessage({ role: "assistant", content: assistantText });
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
    }
  }, [prompt, running, append, attachment, attachRoute, meshProviderId]);

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
      ) : !settings ? (
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
          <div data-testid="attach-row" className="flex flex-wrap items-center gap-2 text-[10px] text-[#9ab]">
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
                <div data-testid="attach-route" className="ml-1 flex overflow-hidden rounded border border-[#2a3444]">
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
            {usage && (
              <span data-testid="generation-usage" className="ml-auto text-[10px] text-[#789]">
                {usage.totalTokens} tok{usage.paidJobs > 0 ? ` · ${usage.paidJobs} paid` : ""}
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
