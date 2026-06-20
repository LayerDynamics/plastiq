// SPEC-6 R1.5 / R5.1 — reactive AI slice (zustand): provider settings + the active
// project's conversation. The Settings panel + the generation UI read `settings`;
// settings persistence is delegated to settings.ts and the conversation to
// conversation.ts (both IndexedDB, separate DBs). The R5.1 conversation slice loads a
// project's saved history on open and clears it on delete (decision 14, FR-20).

import { create } from "zustand";
import { type AiSettings, loadSettings, saveSettings, clearSettings } from "./settings.js";
import {
  type Conversation,
  type TraceEntry,
  emptyConversation,
  getConversation as dbGetConversation,
  putConversation as dbPutConversation,
  deleteConversation as dbDeleteConversation,
} from "./conversation.js";
import type { ChatMessage } from "./providers/types.js";

interface AiState {
  /** Configured provider settings, or null until the user picks one (FR-5a). */
  settings: AiSettings | null;
  /** True once we've read persistence (so the UI can distinguish "loading" vs "first run"). */
  loaded: boolean;
  /** Hydrate from IndexedDB (call once at app start). */
  load: () => Promise<void>;
  /** Persist + apply new settings. */
  save: (settings: AiSettings) => Promise<void>;
  /** Forget the configured provider (back to first-run chooser). */
  clear: () => Promise<void>;

  /** The active project's conversation (messages + generation trace), in memory. */
  conversation: Conversation;
  /** The project id the in-memory conversation belongs to (null = untitled/none). */
  conversationProjectId: string | null;
  /** Switch to a project: load its saved conversation (empty if none). Pass null to
   * reset to an untitled in-memory conversation (a new project). */
  openConversation: (projectId: string | null) => Promise<void>;
  /** Append a message to the active conversation and persist it (if a project is open). */
  appendMessage: (message: ChatMessage) => Promise<void>;
  /** Append a generation-trace step and persist it (if a project is open). */
  appendTrace: (entry: TraceEntry) => Promise<void>;
  /** Remove a project's conversation (on delete); resets memory if it was active. */
  deleteConversation: (projectId: string) => Promise<void>;
}

export const useAiStore = create<AiState>((set, get) => ({
  settings: null,
  loaded: false,
  load: async () => {
    const settings = await loadSettings();
    set({ settings, loaded: true });
  },
  save: async (settings) => {
    await saveSettings(settings);
    set({ settings, loaded: true });
  },
  clear: async () => {
    await clearSettings();
    set({ settings: null, loaded: true });
  },

  conversation: emptyConversation(),
  conversationProjectId: null,
  openConversation: async (projectId) => {
    if (projectId === null) {
      set({ conversation: emptyConversation(), conversationProjectId: null });
      return;
    }
    const saved = await dbGetConversation(projectId);
    set({ conversation: saved ?? emptyConversation(), conversationProjectId: projectId });
  },
  appendMessage: async (message) => {
    const conv = get().conversation;
    const next: Conversation = { messages: [...conv.messages, message], trace: conv.trace };
    set({ conversation: next });
    const id = get().conversationProjectId;
    if (id) await dbPutConversation(id, next);
  },
  appendTrace: async (entry) => {
    const conv = get().conversation;
    const next: Conversation = { messages: conv.messages, trace: [...conv.trace, entry] };
    set({ conversation: next });
    const id = get().conversationProjectId;
    if (id) await dbPutConversation(id, next);
  },
  deleteConversation: async (projectId) => {
    await dbDeleteConversation(projectId);
    if (get().conversationProjectId === projectId) {
      set({ conversation: emptyConversation(), conversationProjectId: null });
    }
  },
}));
