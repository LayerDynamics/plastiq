// SPEC-6 R1.5 — AI provider settings, persisted client-side (FR-4), with a
// proxy-ready key indirection (decision 21) and a neutral first-run state (FR-5a).
//
// Settings live in their OWN IndexedDB database ("plastiq-ai"), separate from the
// "plastiq" projects DB, so AI config can never collide with a CAD document. API
// keys are stored here (the user's own keys, never logged, sent only to the
// configured endpoint) behind a `KeyResolver` so a future hosted proxy can supply
// them instead with no change at the call sites.

import type { ProviderSettings } from "./providers/registry.js";
import type { ProviderId } from "./providers/models.js";

export interface AiSettings {
  /** Catalog preset key: "anthropic" | "ollama" | "openai" | a custom key. */
  providerKey: string;
  providerId: ProviderId;
  model: string;
  /** Overrides the preset default base URL — also the hosted-proxy hook (FR-5). */
  baseURL?: string;
  /** BYO keys by provider key (client-side only). Empty for Ollama / proxy. */
  apiKeys: Record<string, string>;
}

const DB_NAME = "plastiq-ai";
const DB_VERSION = 1;
const STORE = "kv";
const SETTINGS_KEY = "settings";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("plastiq-ai: indexedDB open failed"));
  });
}

function runTx<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = op(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("plastiq-ai: indexedDB op failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

/** Load persisted settings, or null on first run (no provider configured yet). */
export async function loadSettings(): Promise<AiSettings | null> {
  const value = await runTx<AiSettings | undefined>("readonly", (s) => s.get(SETTINGS_KEY));
  return value ?? null;
}

export async function saveSettings(settings: AiSettings): Promise<void> {
  await runTx("readwrite", (s) => s.put(settings, SETTINGS_KEY));
}

export async function clearSettings(): Promise<void> {
  await runTx("readwrite", (s) => s.delete(SETTINGS_KEY));
}

/** First run = no settings persisted → the UI shows the neutral provider chooser. */
export function isFirstRun(settings: AiSettings | null): boolean {
  return settings === null;
}

/** Resolves a provider's API key. Swapping the resolver is the proxy seam (FR-5). */
export type KeyResolver = (providerKey: string) => string | undefined;

/** Default resolver — returns the user's BYO key from local settings. */
export function localKeyResolver(settings: AiSettings): KeyResolver {
  return (providerKey) => settings.apiKeys[providerKey];
}

/** Proxy resolver — returns no key; the hosted proxy injects it server-side. */
export function proxyKeyResolver(): KeyResolver {
  return () => undefined;
}

/** Map persisted AiSettings to the registry's ProviderSettings, resolving the key
 * through `resolveKey` (BYO by default, proxy when swapped). */
export function toProviderSettings(
  settings: AiSettings,
  resolveKey: KeyResolver = localKeyResolver(settings),
): ProviderSettings {
  return {
    providerKey: settings.providerKey,
    providerId: settings.providerId,
    model: settings.model,
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
    apiKey: resolveKey(settings.providerKey),
  };
}
