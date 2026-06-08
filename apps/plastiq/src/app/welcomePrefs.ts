// Persistence for the welcome screen's "don't show this again" preference. Uses
// localStorage with a Map fallback when it's absent (Node tests), mirroring the
// recovery-snapshot helper. The welcome screen shows on every load UNLESS this flag
// is set; ticking "Don't show this again" sets it.

interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const memoryFallback = new Map<string, string>();
const memoryStore: KeyValue = {
  getItem: (k) => memoryFallback.get(k) ?? null,
  setItem: (k, v) => void memoryFallback.set(k, v),
};

function store(): KeyValue {
  const ls = (globalThis as { localStorage?: KeyValue }).localStorage;
  return ls ?? memoryStore;
}

const KEY = "plastiq.welcomeHidden";

/** True when the user has chosen not to see the welcome screen on launch. */
export function welcomeHidden(): boolean {
  try {
    return store().getItem(KEY) === "1";
  } catch {
    return false; // storage unavailable → default to showing the guide
  }
}

/** Persist (or clear) the "don't show on launch" preference. */
export function setWelcomeHidden(hidden: boolean): void {
  try {
    store().setItem(KEY, hidden ? "1" : "0");
  } catch {
    // Best-effort: a blocked storage just means the guide shows again next launch.
  }
}
