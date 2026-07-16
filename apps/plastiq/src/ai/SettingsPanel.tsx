// SPEC-6 R1.4 — the AI provider Settings panel (FR-4, FR-5, FR-5b).
//
// The full configuration surface the first-run chooser only hints at: pick a provider
// preset (Anthropic / local Ollama / OpenAI-compatible), choose a model from the curated
// catalog (Appendix A) OR type a free-text override, set the base URL (also the hosted-proxy
// seam — FR-5), the BYO API key, the creative mesh-gen (fal) key + proxy URL, and the
// self-hosted reconstruction / NeRF / NURBS / capture / photogrammetry service URLs and
// their optional API keys (RECONSTRUCT_API_KEY, CAPTURE_API_KEY, NERF_API_KEY, NURBS_API_KEY,
// PHOTOGRAMMETRY_API_KEY — SPEC-7/10/11/12/13). The tool-capability preflight warning (FR-5b) is
// SURFACED here so a non-tool model isn't silently accepted: the static catalog hint
// shows immediately, and a debounced LIVE probe (probeModelCapabilities — Ollama model
// metadata or a minimal tools-enabled chat probe, §6.9) supersedes it once the endpoint
// answers — confirming, refuting, or leaving the unverified note. Persists via the aiStore.

import { useEffect, useMemo, useState } from "react";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";
import { MODEL_CATALOG, preflightModel, probeModelCapabilities, type ProbeResult } from "./providers/models.js";

const PRESET_KEYS = Object.keys(MODEL_CATALOG); // "anthropic" | "ollama" | "openai" | "llama-mlx"

const field = "min-w-0 flex-1 rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe]";
const labelCls = "flex flex-col gap-0.5 text-[10px] text-[#9ab]";

/** A labelled text/password input row. */
function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  testid: string;
}): React.JSX.Element {
  return (
    <label className={labelCls}>
      <span>{props.label}</span>
      <input
        data-testid={props.testid}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className={field}
      />
    </label>
  );
}

export function SettingsPanel(props: { onClose?: () => void }): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const save = useAiStore((s) => s.save);
  const clear = useAiStore((s) => s.clear);

  const [providerKey, setProviderKey] = useState(settings?.providerKey ?? PRESET_KEYS[0]!);
  const [model, setModel] = useState(settings?.model ?? "");
  const [baseURL, setBaseURL] = useState(settings?.baseURL ?? "");
  const [apiKey, setApiKey] = useState(settings?.apiKeys[settings.providerKey] ?? "");
  const [falKey, setFalKey] = useState(settings?.apiKeys["fal"] ?? "");
  const [reconstructBaseURL, setReconstructBaseURL] = useState(settings?.reconstructBaseURL ?? "");
  const [reconstructApiKey, setReconstructApiKey] = useState(settings?.reconstructApiKey ?? "");
  const [nerfBaseURL, setNerfBaseURL] = useState(settings?.nerfBaseURL ?? "");
  const [nerfApiKey, setNerfApiKey] = useState(settings?.nerfApiKey ?? "");
  const [nurbsBaseURL, setNurbsBaseURL] = useState(settings?.nurbsBaseURL ?? "");
  const [nurbsApiKey, setNurbsApiKey] = useState(settings?.nurbsApiKey ?? "");
  const [captureBaseURL, setCaptureBaseURL] = useState(settings?.captureBaseURL ?? "");
  const [captureApiKey, setCaptureApiKey] = useState(settings?.captureApiKey ?? "");
  const [photogrammetryBaseURL, setPhotogrammetryBaseURL] = useState(
    settings?.photogrammetryBaseURL ?? "",
  );
  const [photogrammetryApiKey, setPhotogrammetryApiKey] = useState(
    settings?.photogrammetryApiKey ?? "",
  );
  const [meshGenBaseURL, setMeshGenBaseURL] = useState(settings?.meshGenBaseURL ?? "");
  const [saved, setSaved] = useState(false);

  const entry = MODEL_CATALOG[providerKey];
  // The preflight warning (FR-5b): surfaced, not swallowed. Empty model ⇒ no warning yet.
  const preflight = useMemo(
    () => (model.trim() ? preflightModel(providerKey, model.trim()) : null),
    [providerKey, model],
  );

  // The LIVE capability probe (FR-5b/§6.9): fired (debounced) whenever the selection
  // changes, aborting the previous in-flight probe. Non-blocking — the static catalog
  // hint shows meanwhile; the probe's answer supersedes it below once it lands.
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  useEffect(() => {
    setProbe(null);
    const m = model.trim();
    if (!m) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void probeModelCapabilities(providerKey, m, {
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        signal: controller.signal,
      }).then((result) => {
        if (!controller.signal.aborted) setProbe(result);
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [providerKey, model, baseURL, apiKey]);

  // Probe (live) supersedes catalog (static): a confirmation only counts when the
  // endpoint actually answered (source ≠ catalog — Anthropic's catalog truth stays quiet,
  // as does the offline fallback); a landed probe's warning replaces the static hint.
  const liveConfirmed = probe !== null && probe.verdict === "confirmed" && probe.source !== "catalog" ? probe : null;
  const toolWarning = probe ? probe.warning : preflight?.warning;

  /** Switching presets resets the model + base URL to that preset's defaults. */
  const onPreset = (key: string): void => {
    setProviderKey(key);
    const e = MODEL_CATALOG[key];
    setModel(e?.models[0]?.id ?? "");
    setBaseURL(e?.defaultBaseURL ?? "");
    setApiKey(settings?.providerKey === key ? (settings.apiKeys[key] ?? "") : "");
    setSaved(false);
  };

  const onSave = (): void => {
    if (!entry || !model.trim()) return;
    const apiKeys: Record<string, string> = { ...(settings?.apiKeys ?? {}) };
    if (apiKey.trim()) apiKeys[providerKey] = apiKey.trim();
    if (falKey.trim()) apiKeys["fal"] = falKey.trim();
    const next: AiSettings = {
      providerKey,
      providerId: entry.providerId,
      model: model.trim(),
      apiKeys,
      ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      ...(reconstructBaseURL.trim() ? { reconstructBaseURL: reconstructBaseURL.trim() } : {}),
      ...(reconstructApiKey.trim() ? { reconstructApiKey: reconstructApiKey.trim() } : {}),
      ...(nerfBaseURL.trim() ? { nerfBaseURL: nerfBaseURL.trim() } : {}),
      ...(nerfApiKey.trim() ? { nerfApiKey: nerfApiKey.trim() } : {}),
      ...(nurbsBaseURL.trim() ? { nurbsBaseURL: nurbsBaseURL.trim() } : {}),
      ...(nurbsApiKey.trim() ? { nurbsApiKey: nurbsApiKey.trim() } : {}),
      ...(captureBaseURL.trim() ? { captureBaseURL: captureBaseURL.trim() } : {}),
      ...(captureApiKey.trim() ? { captureApiKey: captureApiKey.trim() } : {}),
      ...(photogrammetryBaseURL.trim()
        ? { photogrammetryBaseURL: photogrammetryBaseURL.trim() }
        : {}),
      ...(photogrammetryApiKey.trim() ? { photogrammetryApiKey: photogrammetryApiKey.trim() } : {}),
      ...(meshGenBaseURL.trim() ? { meshGenBaseURL: meshGenBaseURL.trim() } : {}),
    };
    void save(next).then(() => {
      setSaved(true);
      props.onClose?.();
    });
  };

  return (
    <div data-testid="ai-settings-panel" className="space-y-2 text-xs text-[#9ab]">
      <label className={labelCls}>
        <span>Provider</span>
        <select
          data-testid="settings-provider"
          value={providerKey}
          onChange={(e) => onPreset(e.target.value)}
          className={field}
        >
          {PRESET_KEYS.map((k) => (
            <option key={k} value={k}>
              {MODEL_CATALOG[k]!.label}
            </option>
          ))}
        </select>
      </label>

      {/* Curated model list (FR-5b) — absent for OpenAI (ids move fast → free-text only). */}
      {entry && entry.models.length > 0 && (
        <label className={labelCls}>
          <span>Model (curated)</span>
          <select
            data-testid="settings-model-select"
            value={entry.models.some((m) => m.id === model) ? model : ""}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
            className={field}
          >
            <option value="">— choose or type below —</option>
            {entry.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Free-text model override (FR-5b) — always available. */}
      <Field
        testid="settings-model"
        label="Model (or custom id)"
        value={model}
        onChange={(v) => {
          setModel(v);
          setSaved(false);
        }}
        placeholder="e.g. qwen2.5 / claude-opus-4-8 / gpt-…"
      />

      {/* Tool-capability preflight (FR-5b/§6.9) — surfaced, never silent. The live probe's
          verdict supersedes the static catalog hint: confirmed ⇒ the green verified line,
          refuted ⇒ its hard warning, couldn't-verify ⇒ the unverified note. */}
      {liveConfirmed && (
        <p data-testid="settings-tool-confirmed" className="rounded border border-[#2a5a3a] bg-[#102217] px-2 py-1 text-[10px] text-[#9fc]">
          ✓ '{model.trim()}' supports tool calling — verified against the endpoint
          {liveConfirmed.supportsVision ? " (vision-capable)" : ""}.
        </p>
      )}
      {!liveConfirmed && toolWarning && (
        <p data-testid="settings-tool-warning" className="rounded border border-[#7a5a2a] bg-[#221a10] px-2 py-1 text-[10px] text-[#fc9]">
          ⚠ {toolWarning}
        </p>
      )}

      {entry?.needsKey && (
        <Field
          testid="settings-api-key"
          label={`${entry.label} API key (BYO — stays in your browser)`}
          value={apiKey}
          onChange={(v) => {
            setApiKey(v);
            setSaved(false);
          }}
          type="password"
          placeholder="sk-… / key"
        />
      )}

      <Field
        testid="settings-base-url"
        label="Base URL (override / hosted proxy — FR-5)"
        value={baseURL}
        onChange={(v) => {
          setBaseURL(v);
          setSaved(false);
        }}
        placeholder={entry?.defaultBaseURL ?? "(provider default)"}
      />

      <Field
        testid="settings-reconstruct-url"
        label="Reconstruction service URL (mesh→CAD)"
        value={reconstructBaseURL}
        onChange={(v) => {
          setReconstructBaseURL(v);
          setSaved(false);
        }}
        placeholder="http://localhost:8000"
      />

      <Field
        testid="settings-reconstruct-key"
        label="Reconstruction service API key (if it sets RECONSTRUCT_API_KEY)"
        value={reconstructApiKey}
        onChange={(v) => {
          setReconstructApiKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="(blank = open dev service)"
      />

      <Field
        testid="settings-nerf-url"
        label="NeRF / photo-capture service URL"
        value={nerfBaseURL}
        onChange={(v) => {
          setNerfBaseURL(v);
          setSaved(false);
        }}
        placeholder="http://localhost:8002"
      />

      <Field
        testid="settings-nerf-key"
        label="NeRF service API key (if it sets NERF_API_KEY)"
        value={nerfApiKey}
        onChange={(v) => {
          setNerfApiKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="(blank = open dev service)"
      />

      <Field
        testid="settings-nurbs-url"
        label="NURBS fitting service URL (mesh→smooth CAD)"
        value={nurbsBaseURL}
        onChange={(v) => {
          setNurbsBaseURL(v);
          setSaved(false);
        }}
        placeholder="http://localhost:8003"
      />

      <Field
        testid="settings-nurbs-key"
        label="NURBS service API key (if it sets NURBS_API_KEY)"
        value={nurbsApiKey}
        onChange={(v) => {
          setNurbsApiKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="(blank = open dev service)"
      />

      <Field
        testid="settings-capture-url"
        label="Capture service URL (point cloud→mesh)"
        value={captureBaseURL}
        onChange={(v) => {
          setCaptureBaseURL(v);
          setSaved(false);
        }}
        placeholder="http://localhost:8001"
      />

      <Field
        testid="settings-capture-key"
        label="Capture service API key (if it sets CAPTURE_API_KEY)"
        value={captureApiKey}
        onChange={(v) => {
          setCaptureApiKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="(blank = open dev service)"
      />

      <Field
        testid="settings-photogrammetry-url"
        label="Photogrammetry service URL (photos→poses+cloud)"
        value={photogrammetryBaseURL}
        onChange={(v) => {
          setPhotogrammetryBaseURL(v);
          setSaved(false);
        }}
        placeholder="http://localhost:8004"
      />

      <Field
        testid="settings-photogrammetry-key"
        label="Photogrammetry service API key (if it sets PHOTOGRAMMETRY_API_KEY)"
        value={photogrammetryApiKey}
        onChange={(v) => {
          setPhotogrammetryApiKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="(blank = open dev service)"
      />

      <Field
        testid="settings-fal-key"
        label="Creative mesh-gen (fal) API key"
        value={falKey}
        onChange={(v) => {
          setFalKey(v);
          setSaved(false);
        }}
        type="password"
        placeholder="fal key (for create_mesh)"
      />

      <Field
        testid="settings-meshgen-url"
        label="Mesh-gen base URL / proxy (decision 21)"
        value={meshGenBaseURL}
        onChange={(v) => {
          setMeshGenBaseURL(v);
          setSaved(false);
        }}
        placeholder="(fal queue default)"
      />

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          data-testid="settings-save"
          onClick={onSave}
          disabled={!model.trim()}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
        >
          Save settings
        </button>
        <button
          type="button"
          data-testid="settings-reset"
          onClick={() => void clear()}
          className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
        >
          Reset provider
        </button>
        {saved && <span className="text-[10px] text-[#6c9]">saved ✓</span>}
      </div>
      <p className="text-[10px] text-[#678]">
        Keys stay in your browser (IndexedDB) and are sent only to the endpoint you configure.
      </p>
    </div>
  );
}
