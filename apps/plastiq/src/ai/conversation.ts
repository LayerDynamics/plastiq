// SPEC-6 R5.1 — per-project AI conversation + generation trace persistence
// (decision 14, FR-20).
//
// The AI conversation (messages) and a generation trace (the tool-call/build steps the
// panel shows) are saved WITH the project and reloaded with it, so iterative editing is
// resumable. This lives in its OWN IndexedDB database, isolated from BOTH the "plastiq"
// projects DB (so AI history can never corrupt a CAD document — R5 risk note) and the
// "plastiq-ai" settings DB (so the two evolve their schemas independently). Keyed by the
// project id. A linear conversation only — branching is out of scope (§13).

import type { ChatMessage } from "./providers/types.js";

/** One step in the visible generation trace (what the panel renders under a turn). */
export interface TraceEntry {
  kind: "tool-call" | "tool-result" | "status";
  /** Tool name (for tool-call / tool-result entries). */
  name?: string;
  /** Human-readable summary line. */
  detail: string;
  /** True when a tool result was an error fed back for self-correction. */
  isError?: boolean;
}

/** A project's saved AI conversation: the messages plus the generation trace. */
export interface Conversation {
  messages: ChatMessage[];
  trace: TraceEntry[];
}

/** A fresh, empty conversation (for a new/untitled project or a missing record). */
export function emptyConversation(): Conversation {
  return { messages: [], trace: [] };
}

const DB_NAME = "plastiq-ai-conversations";
const DB_VERSION = 1;
const STORE = "conversations"; // keyed by project id

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("plastiq-ai-conversations: open failed"));
  });
}

function runTx<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = op(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("plastiq-ai-conversations: op failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

/** Load a project's saved conversation, or null if none was saved. */
export async function getConversation(projectId: string): Promise<Conversation | null> {
  const value = await runTx<Conversation | undefined>("readonly", (s) => s.get(projectId));
  return value ?? null;
}

/** Write (replace) a project's conversation. */
export async function putConversation(projectId: string, conversation: Conversation): Promise<void> {
  await runTx("readwrite", (s) => s.put(conversation, projectId));
}

/** Remove a project's conversation (called when the project is deleted). */
export async function deleteConversation(projectId: string): Promise<void> {
  await runTx("readwrite", (s) => s.delete(projectId));
}
