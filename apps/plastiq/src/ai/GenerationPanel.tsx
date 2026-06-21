// SPEC-6 R2.4 — the AI generation cockpit (FR-19). A dockable side panel: prompt input,
// streaming response + a visible tool-call/build trace, a usage meter, and cancel. It
// wires the real dependencies — the off-thread build seam (__plastiqBuild on the single
// geometry worker) as the build_part/inspect_geometry probe, loadDocument as the atomic
// apply, and the live document as edit context — then drives runGeneration. A compact
// neutral first-run chooser (FR-5a) lets the user pick a provider so the panel is
// self-sufficient. Conversation + trace persist per project via the aiStore (R5.1).

import { useCallback, useMemo, useRef, useState } from "react";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { buildProvider } from "./providers/registry.js";
import { toProviderSettings, type AiSettings } from "./settings.js";
import { buildAgentTools } from "./tools/toolDefs.js";
import { runGeneration } from "./runGeneration.js";
import { reconstructMesh, stepToImportDocument } from "./reconstruct.js";
import { buildMeshGenDeps, meshGenConfigured } from "./meshGenDeps.js";
import { planAttachmentRoute, type AttachmentRoute } from "./visionRoute.js";
import { UsageMeter, type UsageSnapshot } from "./usage.js";
import type { BuildProbe, ApplyDocument } from "./tools/buildPart.js";
import type { MeshProbe } from "./tools/inspectGeometry.js";
import { createMesh, type CreateMeshDeps, type PaidJobInfo } from "./tools/createMesh.js";
import type { GenImage } from "./meshgen/types.js";
import type { CadDocument } from "../store/types.js";
import type { ContentPart } from "./providers/types.js";
import type { TransferMesh } from "../worker/protocol.js";

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
}

type BuildSeam = (doc: CadDocument) => Promise<TransferMesh | null>;

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
    setStatus("submitting…");
    try {
      const baseURL = useAiStore.getState().settings?.reconstructBaseURL;
      const result = await reconstructMesh(doc.glb, {
        ...(baseURL ? { baseURL } : {}),
        signal: controller.signal,
        onState: (s) => setStatus(s),
      });
      const name = doc.name ?? "Reconstructed mesh";
      useCadStore.getState().loadDocument(stepToImportDocument(result.step, name));
      // Switch out of mesh mode: the viewport now renders the new B-rep part as a fresh
      // untitled parametric document (the original mesh project is left untouched).
      useProjectsStore.setState({
        activeMeshDoc: null,
        currentId: null,
        currentName: name,
        status: `converted to CAD — ${result.report.faces_built} face${result.report.faces_built === 1 ? "" : "s"}${result.report.is_solid ? ", solid" : ", shell"}`,
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

/** A pending paid-job confirmation (FR-18a) bridged from the create_mesh handler's
 * async `confirm` gate to a React modal: the handler awaits `resolve`, the modal's
 * buttons call it. Used instead of window.confirm (testable; no blocking browser modal). */
interface PendingConfirm {
  info: PaidJobInfo;
  resolve: (approved: boolean) => void;
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

/** The paid-job confirm dialog (FR-18a), shown when a create_mesh call awaits approval.
 * Resolves the bridged promise true/false; not a blocking browser modal. */
function PaidJobConfirmModal({
  info,
  onResolve,
}: {
  info: PaidJobInfo;
  onResolve: (approved: boolean) => void;
}): React.JSX.Element {
  const { mode, providerId, billableCalls } = info;
  return (
    <div data-testid="paid-confirm" className="rounded border border-[#7a5a2a] bg-[#1c1608] p-2 text-[11px] text-[#ecd]">
      <p className="mb-1 font-semibold text-[#fda]">Confirm paid generation</p>
      <p className="mb-2 text-[#cba]">
        This runs a billable cloud job: <span className="text-[#fec]">{mode}</span> via{" "}
        <span className="text-[#fec]">{providerId}</span> ({billableCalls} billable call
        {billableCalls === 1 ? "" : "s"}). Your provider account is charged.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="paid-confirm-yes"
          onClick={() => onResolve(true)}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48]"
        >
          Confirm &amp; run
        </button>
        <button
          type="button"
          data-testid="paid-confirm-no"
          onClick={() => onResolve(false)}
          className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function GenerationPanel(): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const activeMeshDoc = useProjectsStore((s) => s.activeMeshDoc);
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

  const append = useCallback((line: Line): void => setLines((prev) => [...prev, line]), []);

  const run = useCallback(async (): Promise<void> => {
    const current = useAiStore.getState().settings;
    if (!current || running) return;
    const text = prompt.trim();
    const attached = attachment;
    if (!text && !attached) return;

    const build = (globalThis as { __plastiqBuild?: BuildSeam }).__plastiqBuild;
    if (!build) {
      append({ kind: "error", text: "The geometry viewport isn’t ready yet — try again in a moment.", isError: true });
      return;
    }

    const probe: BuildProbe = async (doc) => {
      try {
        return (await build(doc)) ? { ok: true } : { ok: false, error: "the document produced no geometry or a feature failed to build" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const meshProbe: MeshProbe = (doc) => build(doc);
    const apply: ApplyDocument = (doc) => useCadStore.getState().loadDocument(doc);

    const controller = new AbortController();
    const meter = new UsageMeter();

    // Creative path (FR-15/FR-18a): wire create_mesh from the fal providers + a
    // promise-bridged confirm modal. The model can always reach the tool; without a fal
    // key or proxy it fails with a clean error (meshGenConfigured surfaces an honest hint).
    const providerDeps = buildMeshGenDeps(current);
    createdMeshIdRef.current = null;
    const createMeshDeps: CreateMeshDeps = {
      ...providerDeps,
      // The attached image is the img3d input — resolve it by id for create_mesh (FR-10a).
      ...(attached
        ? {
            resolveImage: async (id: string) => {
              if (id === attached.id) return attached.image;
              throw new Error(`no attached image with id '${id}'`);
            },
          }
        : {}),
      confirm: (info) => new Promise<boolean>((resolve) => setPaidConfirm({ info, resolve })),
      persist: async (doc) => {
        const id = await useProjectsStore.getState().createMeshProject(doc);
        createdMeshIdRef.current = id;
        return id;
      },
      recordPaidJob: () => {
        meter.addPaidJob();
        setUsage(meter.snapshot());
      },
      signal: controller.signal,
    };
    const tools = buildAgentTools({
      buildPart: { probe, apply },
      probe: meshProbe,
      currentDoc: () => useCadStore.getState().toDocument(),
      createMesh: createMeshDeps,
    });

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
        route: attachRoute,
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
    const routeTag = attached ? ` [${attachRoute === "creative" ? "→3D" : "vision"}: ${attached.name}]` : "";
    append({ kind: "text", text: `> ${text || "(image)"}${routeTag}` });
    void ai.appendMessage({ role: "user", content: text || "(image attached)" });
    setPrompt("");
    setAttachment(null);

    let assistantText = "";
    try {
      if (directCreative) {
        // Creative image→3D runs the create_mesh pipeline directly (no LLM needed): the
        // attached image + the user-selected 3D-gen provider, gated by the paid confirm.
        append({ kind: "tool", text: `→ create_mesh(img3d via ${meshProviderId})` });
        void ai.appendTrace({ kind: "tool-call", name: "create_mesh", detail: `img3d via ${meshProviderId}` });
        const r = await createMesh({ ...directCreative, providerId: meshProviderId }, createMeshDeps);
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
      append({ kind: "error", text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [prompt, running, append, attachment, attachRoute, meshProviderId]);

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
                  className={
                    l.isError
                      ? "text-[#fb9]"
                      : l.kind === "tool"
                        ? "text-[#9cf]"
                        : l.kind === "status"
                          ? "text-[#789]"
                          : "text-[#cde]"
                  }
                >
                  {l.text}
                </div>
              ))}
            </div>
          )}
          <CreativeKeyField />
        </>
      )}
    </div>
  );
}
