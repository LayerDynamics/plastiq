// SPEC-6 R1.5 — reactive AI settings slice (zustand). The Settings panel + the
// generation UI (R2.4) read `settings` from here; persistence is delegated to
// settings.ts (IndexedDB). Conversation/usage slices are added in R2.4 / R5.1.

import { create } from "zustand";
import { type AiSettings, loadSettings, saveSettings, clearSettings } from "./settings.js";

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
}

export const useAiStore = create<AiState>((set) => ({
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
}));
