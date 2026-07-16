// SPEC-6 FR-19 — the command palette: the SECOND surface for AI generation (alongside the
// dockable GenerationPanel), plus quick action search. ⌘/Ctrl-K opens a modal with one
// search box that does two things:
//   • a quick AI prompt — drives the SAME agentRunner as the panel (shared agentTurn
//     wiring), so a one-line "make a 20mm cube" works without opening the panel;
//   • action search over the shared action registry (actions/registry.ts) — run any
//     enabled editor action (sketch, loft, export, undo…) by name.
// FR-19 parity with the panel: prompt input, image attach + route choice (parametric
// vision reference vs creative image→3D via visionRoute), live streaming text, a visible
// tool-call/build trace while the run is in flight, and an error surface. Conversation +
// trace persist via the aiStore, so a palette run shows up in the panel's history and the
// next turn continues it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS, runAction } from "../actions/registry.js";
import { useActionContext } from "../ribbon/useActionContext.js";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { buildProvider, keyResolverFor } from "./providers/registry.js";
import { toProviderSettings } from "./settings.js";
import { runGeneration } from "./runGeneration.js";
import { buildTurnTools, buildCreateMeshDeps, buildSeam, type TurnToolsDeps } from "./agentTurn.js";
import { buildMeshGenDeps, DEFAULT_IMAGE_PROVIDER_ID } from "./meshGenDeps.js";
import { planAttachmentRoute, type AttachmentRoute } from "./visionRoute.js";
import { createMesh } from "./tools/createMesh.js";
import { fileToBase64 } from "./fileRead.js";
import { PaidJobConfirmModal, type PendingConfirm } from "./PaidJobConfirmModal.js";
import { UsageMeter } from "./usage.js";
import type { GenImage } from "./meshgen/types.js";
import type { ContentPart } from "./providers/types.js";

/** One row in the palette: a quick-AI prompt or a registry action. `text` carries the
 * raw prompt (the label is display-only — an image-only run has an empty prompt). */
type PaletteItem =
  | { kind: "ai"; label: string; text: string }
  | { kind: "action"; id: string; label: string };

/** An image attached to the quick prompt (FR-10a) — same shape as the panel's. */
interface PaletteAttachment {
  image: GenImage;
  id: string;
  name: string;
}

/** A line in the palette's compact live region: the echoed prompt, streaming assistant
 * text, a tool-call/build trace entry, a status, or an error (FR-19 parity). */
interface PaletteLine {
  kind: "user" | "text" | "tool" | "status" | "error";
  text: string;
  isError?: boolean;
}

const MAX_ACTIONS = 8;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const ctx = useActionContext();
  const settings = useAiStore((s) => s.settings);
  // Session-cumulative usage across ALL runs (6-L2), shared with the panel via the aiStore —
  // the palette both contributes its runs' spend and shows the running session readout.
  const sessionUsage = useAiStore((s) => s.sessionUsage);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lines, setLines] = useState<PaletteLine[]>([]);
  const [paidConfirm, setPaidConfirm] = useState<PendingConfirm | null>(null);
  // Image attach + its route (FR-10a/FR-10b): a parametric vision reference, or the
  // creative image→3D path. `meshProviderId` is the per-job 3D-gen provider (creative).
  const [attachment, setAttachment] = useState<PaletteAttachment | null>(null);
  const [attachRoute, setAttachRoute] = useState<AttachmentRoute>("parametric");
  const [meshProviderId, setMeshProviderId] = useState("fal:tripo");
  // Per-job image-gen model for the text→image stage of AI text→3D (create_mesh text2img3d),
  // 6-L1-ui / task #47 — the palette's parity with the panel's image-gen selector. Defaults to
  // the persisted setting (or the catalog default); a run-scoped override threaded through
  // turnDeps.settings — NOT a save. The palette has no retry path, so the live state value IS
  // the override (mirrors meshProviderId's un-synced initial-value pattern).
  const [imageProviderId, setImageProviderId] = useState(settings?.imageProviderId ?? DEFAULT_IMAGE_PROVIDER_ID);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Monotonic id source for attachments (deterministic within a session). */
  const attachSeq = useRef(0);

  // Reset + focus whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setStatus(null);
      setLines([]);
      setAttachment(null);
      setAttachRoute("parametric");
      // Focus after paint so the input exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /** Whether the active chat model can see images (gates the parametric route, FR-10b).
   * Adapter construction does no network I/O (registry contract), so deriving this per
   * settings change is safe — the run itself re-checks against the constructed provider. */
  const supportsVision = useMemo(() => {
    if (!settings) return false;
    try {
      return buildProvider(toProviderSettings(settings, keyResolverFor(settings))).supportsVision;
    } catch {
      return false;
    }
  }, [settings]);

  /** The 3D-gen providers (creative-route per-job picker; img3d filtered at render) and the
   * image-gen providers (the text2img3d image-model picker, task #47) offered by settings. */
  const { meshProviders, imageProviders } = useMemo(() => {
    if (!settings) return { meshProviders: [], imageProviders: [] };
    const deps = buildMeshGenDeps(settings);
    return { meshProviders: deps.providers, imageProviders: deps.imageProviders };
  }, [settings]);

  /** Non-null when the parametric route is unavailable for the current attachment —
   * the visionRoute decision (disable with guidance, never silently drop the image). */
  const parametricDisabled = useMemo(() => {
    if (!attachment) return null;
    const plan = planAttachmentRoute({
      route: "parametric",
      prompt: "",
      image: attachment.image,
      imageId: attachment.id,
      supportsVision,
    });
    return plan.kind === "disabled" ? plan.reason : null;
  }, [attachment, supportsVision]);

  const actionMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(ACTIONS)
      .filter((a) => a.enabled(ctx))
      .map((a) => ({ id: a.id, label: a.label(ctx) }))
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .slice(0, MAX_ACTIONS);
  }, [query, ctx]);

  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    // An attachment alone is a runnable AI request (image-only creative gen — the panel
    // precedent: send enables on prompt OR attachment).
    const ai: PaletteItem[] =
      settings && (q.length > 0 || attachment)
        ? [{ kind: "ai", label: q ? `Ask AI: ${q}` : `Ask AI: (image) ${attachment!.name}`, text: q }]
        : [];
    return [...ai, ...actionMatches.map((a): PaletteItem => ({ kind: "action", id: a.id, label: a.label }))];
  }, [query, settings, actionMatches, attachment]);

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    setSel((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1)));
  }, [items.length]);

  /** Read a picked image File into the GenImage the providers consume. On a non-vision
   * model the parametric route is unavailable, so default the new attachment to the
   * route that can actually run (creative image→3D). */
  const onAttachFile = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (!file) return;
      const image: GenImage = { mediaType: file.type || "image/png", data: await fileToBase64(file) };
      attachSeq.current += 1;
      setAttachment({ image, id: `att-${attachSeq.current}`, name: file.name });
      if (!supportsVision) setAttachRoute("creative");
    },
    [supportsVision],
  );

  /** Drive one quick AI generation turn through the shared agent wiring. */
  const runQuickPrompt = useCallback(
    async (text: string): Promise<void> => {
      const current = useAiStore.getState().settings;
      if (!current) return;
      const attached = attachment;
      if (!text && !attached) return;
      if (!buildSeam()) {
        setStatus("The geometry viewport isn’t ready yet — try again in a moment.");
        return;
      }
      const controller = new AbortController();
      const meter = new UsageMeter();
      const created = { id: null as string | null };
      // Same shared turn deps as the panel (agentTurn) — the attached image (if any) is
      // the img3d creative input, resolved by id (FR-10a); the paid-confirm gate flows
      // through the modal for BOTH the agent loop and the direct creative path.
      const turnDeps: TurnToolsDeps = {
        // Per-job image-gen model override (6-L1-ui / task #47): the user's pick this run wins
        // over the persisted settings.imageProviderId, flowing through buildCreateMeshDeps →
        // buildMeshGenDeps to the create_mesh text2img3d image stage. img3d/text3d ignore it.
        settings: { ...current, imageProviderId },
        confirm: (info) => new Promise<boolean>((resolve) => setPaidConfirm({ info, resolve })),
        recordPaidJob: () => meter.addPaidJob(),
        onMeshCreated: (id) => {
          created.id = id;
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
        setStatus("The geometry viewport isn’t ready yet — try again in a moment.");
        return;
      }
      // Same decision-21 key indirection as the panel: BYO key locally, or the hosted-
      // proxy resolver when the settings are in the proxy state (registry decides).
      const provider = buildProvider(toProviderSettings(current, keyResolverFor(current)));

      // Route the attachment (FR-10a/FR-10b) via the shared visionRoute decision: a
      // parametric vision reference, the creative image→3D path, or disabled+guidance.
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
          setStatus(null);
          setLines([{ kind: "error", text: plan.reason, isError: true }]);
          return; // nothing ran — guidance shown, image kept
        }
        if (plan.kind === "parametric") agentInput = plan.userContent;
        else directCreative = plan.createMeshInput;
      }

      setBusy(true);
      setStatus("Generating…");
      const routeTag = attached ? ` [${attachRoute === "creative" ? "→3D" : "vision"}: ${attached.name}]` : "";
      setLines([{ kind: "user", text: `> ${text || "(image)"}${routeTag}` }]);
      const pushLine = (line: PaletteLine): void => setLines((prev) => [...prev, line]);
      /** Streaming text: grow the last assistant line in place so deltas render live. */
      const pushDelta = (t: string): void =>
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "text") return [...prev.slice(0, -1), { ...last, text: last.text + t }];
          return [...prev, { kind: "text", text: t }];
        });

      const ai = useAiStore.getState();
      const history = ai.conversation.messages;
      const currentDoc = useCadStore.getState().toDocument();
      void ai.appendMessage({ role: "user", content: text || "(image attached)" });
      let assistantText = "";
      let failed = false;
      try {
        if (directCreative) {
          // Creative image→3D runs the create_mesh pipeline directly (no LLM needed):
          // the attached image + the per-job 3D-gen provider, gated by the paid confirm —
          // the SAME buildCreateMeshDeps wiring the agent loop uses (panel parity).
          pushLine({ kind: "tool", text: `→ create_mesh(img3d via ${meshProviderId})` });
          void ai.appendTrace({ kind: "tool-call", name: "create_mesh", detail: `img3d via ${meshProviderId}` });
          const r = await createMesh({ ...directCreative, providerId: meshProviderId }, buildCreateMeshDeps(turnDeps));
          failed = r.status !== "ok";
          pushLine({ kind: r.status === "error" ? "error" : "status", text: r.message, isError: r.status === "error" });
          void ai.appendTrace({ kind: "tool-result", name: "create_mesh", detail: r.message, isError: r.status === "error" });
          if (failed) setStatus(r.status === "error" ? "Failed" : r.message);
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
                // text events; surface those on the error surface (and keep them out of
                // the persisted assistant turn) — the panel's marker idiom.
                const marker = /^\n?\[(?:provider )?error\] (.*)$/s.exec(e.text);
                if (marker?.[1] != null) {
                  failed = true;
                  pushLine({ kind: "error", text: marker[1], isError: true });
                  return;
                }
                assistantText += e.text;
                pushDelta(e.text);
              } else if (e.type === "tool-call") {
                const detail = JSON.stringify(e.args).slice(0, 200);
                pushLine({ kind: "tool", text: `→ ${e.name}(${detail})` });
                void ai.appendTrace({ kind: "tool-call", name: e.name, detail });
              } else if (e.type === "tool-result") {
                pushLine({ kind: "tool", text: `← ${e.name}: ${e.result.slice(0, 200)}`, isError: e.isError });
                void ai.appendTrace({
                  kind: "tool-result",
                  name: e.name,
                  detail: e.result.slice(0, 200),
                  isError: e.isError,
                });
              } else if (e.type === "usage") {
                // Fold provider token usage into the per-run meter so the palette contributes
                // to the shared session total (6-L2) — the panel's idiom.
                meter.addTokens({ inputTokens: e.inputTokens, outputTokens: e.outputTokens });
              } else if (e.type === "status") {
                if (e.finish === "error") failed = true;
                setStatus(
                  `${e.finish === "error" ? "Failed" : "Done"} · ${e.steps} step${e.steps === 1 ? "" : "s"}`,
                );
              }
            },
          });
          if (assistantText.trim()) void ai.appendMessage({ role: "assistant", content: assistantText });
        }
        if (created.id) await useProjectsStore.getState().open(created.id);
        // Success → dismiss the palette (the geometry/panel reflect the result). A
        // failure stays open: the trace + error lines above are the error surface.
        if (!failed) onClose();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Failed: ${msg}`);
        pushLine({ kind: "error", text: msg, isError: true });
        void ai.appendTrace({ kind: "tool-result", name: "error", detail: msg, isError: true });
      } finally {
        setBusy(false);
        // Fold this run's usage into the shared session total (6-L2), once per run — only a run
        // that actually spent tokens or a paid job counts as a turn (mirrors the panel).
        const runSnap = meter.snapshot();
        if (runSnap.totalTokens > 0 || runSnap.paidJobs > 0) useAiStore.getState().recordRunUsage(runSnap);
      }
    },
    [attachment, attachRoute, meshProviderId, imageProviderId, onClose],
  );

  const runItem = useCallback(
    (item: PaletteItem | undefined): void => {
      if (!item) return;
      if (item.kind === "ai") void runQuickPrompt(item.text);
      else {
        runAction(item.id, ctx);
        onClose();
      }
    },
    [ctx, onClose, runQuickPrompt],
  );

  if (!open) return <></>;

  return (
    <div
      data-testid="command-palette"
      role="dialog"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[34rem] max-w-[92vw] overflow-hidden rounded-lg border border-[#2a3444] bg-[#0b0d12] shadow-2xl">
        {paidConfirm ? (
          <div className="p-2">
            <PaidJobConfirmModal
              info={paidConfirm.info}
              onResolve={(ok) => {
                paidConfirm.resolve(ok);
                setPaidConfirm(null);
              }}
            />
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              data-testid="command-palette-input"
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => (items.length ? (s + 1) % items.length : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  runItem(items[sel]);
                }
              }}
              placeholder="Type a command, or describe a part for the AI…"
              className="w-full border-b border-[#1b2230] bg-transparent px-3 py-2 text-sm text-[#cfe] placeholder:text-[#566] focus:outline-none disabled:opacity-60"
            />
            {/* Image attach + route (FR-10a/FR-10b), palette-compact: a parametric vision
                reference (needs a vision-capable model) or the creative image→3D path
                (picks the per-job 3D-gen provider). */}
            {settings && (
              <div
                data-testid="palette-attach-row"
                className="flex flex-wrap items-center gap-2 border-b border-[#1b2230] px-3 py-1.5 text-[10px] text-[#9ab]"
              >
                <label className="cursor-pointer rounded border border-[#2a3444] bg-[#10141c] px-2 py-0.5 hover:bg-[#16202c]">
                  <input
                    data-testid="palette-attach-input"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => void onAttachFile(e.target.files?.[0])}
                  />
                  {attachment ? "Replace image" : "Attach image"}
                </label>
                {attachment && (
                  <>
                    <span data-testid="palette-attach-name" className="max-w-[8rem] truncate text-[#cde]">
                      {attachment.name}
                    </span>
                    <button
                      type="button"
                      data-testid="palette-attach-clear"
                      disabled={busy}
                      onClick={() => setAttachment(null)}
                      className="rounded border border-[#7a3a3a] bg-[#2a1414] px-1.5 py-0.5 text-[#fbb] hover:bg-[#341a1a]"
                    >
                      ✕
                    </button>
                    <div data-testid="palette-attach-route" className="ml-1 flex overflow-hidden rounded border border-[#2a3444]">
                      <button
                        type="button"
                        data-testid="palette-route-parametric"
                        disabled={busy || parametricDisabled != null}
                        title={parametricDisabled ?? undefined}
                        onClick={() => setAttachRoute("parametric")}
                        className={`px-2 py-0.5 disabled:opacity-40 ${
                          attachRoute === "parametric" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"
                        }`}
                      >
                        Reference (parametric)
                      </button>
                      <button
                        type="button"
                        data-testid="palette-route-creative"
                        disabled={busy}
                        onClick={() => setAttachRoute("creative")}
                        className={`px-2 py-0.5 ${
                          attachRoute === "creative" ? "bg-[#14253a] text-[#bfe]" : "bg-[#10141c] text-[#789]"
                        }`}
                      >
                        Generate mesh (image→3D)
                      </button>
                    </div>
                    {attachRoute === "creative" && (
                      <select
                        data-testid="palette-mesh-provider"
                        value={meshProviderId}
                        disabled={busy}
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
                    {parametricDisabled && (
                      <span data-testid="palette-route-guidance" className="w-full text-[#fb9]">
                        {parametricDisabled}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
            {/* Per-job image-gen model (6-L1-ui / task #47) for AI text→3D (create_mesh
                text2img3d): the LLM turns the prompt into an image with this model, then
                image→3D. Standalone (not gated on an attachment — text2img3d is text-only);
                only shown when there's a choice. The pick overrides settings.imageProviderId
                for this run only — panel parity (GenerationPanel's image-gen-provider). */}
            {imageProviders.length > 1 && (
              <div
                data-testid="palette-image-gen-row"
                className="flex flex-wrap items-center gap-2 border-b border-[#1b2230] px-3 py-1.5 text-[10px] text-[#9ab]"
              >
                <label
                  className="flex items-center gap-1"
                  title="Image model for the text→image stage of AI text→3D generation (create_mesh text2img3d)"
                >
                  Image model (text→3D)
                  <select
                    data-testid="palette-image-gen-provider"
                    value={imageProviderId}
                    disabled={busy}
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
            <ul data-testid="command-palette-results" className="max-h-72 overflow-auto py-1 text-sm">
              {items.length === 0 && (
                <li className="px-3 py-2 text-[11px] text-[#678]">No matching commands.</li>
              )}
              {items.map((item, i) => (
                <li key={item.kind === "ai" ? "ai" : item.id}>
                  <button
                    type="button"
                    data-testid={item.kind === "ai" ? "palette-ai" : `palette-action-${item.id}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => runItem(item)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                      i === sel ? "bg-[#14253a] text-[#bfe]" : "text-[#cde] hover:bg-[#10141c]"
                    }`}
                  >
                    <span className="text-[10px] text-[#789]">{item.kind === "ai" ? "AI" : "▸"}</span>
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {/* FR-19: live streaming text + the visible tool-call/build trace — compact,
                capped-height, visible WHILE the run is in flight (errors styled). */}
            {lines.length > 0 && (
              <div
                data-testid="palette-transcript"
                className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-[#1b2230] px-3 py-1.5 font-mono text-[10px] leading-snug"
              >
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.isError
                        ? "text-[#fb9]"
                        : l.kind === "tool"
                          ? "text-[#9cf]"
                          : l.kind === "status" || l.kind === "user"
                            ? "text-[#789]"
                            : "text-[#cde]"
                    }
                  >
                    {l.text}
                  </div>
                ))}
              </div>
            )}
            {status && (
              <div data-testid="command-palette-status" className="border-t border-[#1b2230] px-3 py-1.5 text-[11px] text-[#789]">
                {status}
              </div>
            )}
            {sessionUsage.turns > 0 && (
              <div
                data-testid="palette-usage-session"
                className="border-t border-[#1b2230] px-3 py-1 text-[10px] text-[#678]"
              >
                session {sessionUsage.totalTokens} tok · {sessionUsage.turns} run
                {sessionUsage.turns === 1 ? "" : "s"}
                {sessionUsage.paidJobs > 0 ? ` · ${sessionUsage.paidJobs} paid` : ""}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
