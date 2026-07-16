// Boot-time capability guard (Review #17): Plastiq is unusable without WebGL2
// (the three.js viewport), WebAssembly (the OCCT kernel, planegcs, sql.js), and
// browser storage (localStorage crash-recovery snapshots + the IndexedDB-backed
// project store). main.tsx runs detectCapabilities() BEFORE booting the app; on
// any miss it renders a friendly unsupported-browser screen naming exactly what
// is missing instead of letting the editor crash mid-load.
//
// renderUnsupportedScreen uses plain DOM + inline styles on purpose: if the
// browser is this broken, the less machinery the screen depends on the better.

export interface CapabilityReport {
  ok: boolean;
  /** Human-readable names of the missing capabilities (empty when ok). */
  missing: string[];
}

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

function hasWebAssembly(): boolean {
  try {
    const wasm = (globalThis as { WebAssembly?: { instantiate?: unknown } }).WebAssembly;
    return typeof wasm === "object" && wasm !== null && typeof wasm.instantiate === "function";
  } catch {
    return false;
  }
}

/** localStorage must exist AND be writable — Safari private windows and locked-
 * down contexts throw on setItem even though the object is present. */
function hasLocalStorage(): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    const probe = "plastiq:capability-probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function hasIndexedDb(): boolean {
  try {
    return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined";
  } catch {
    return false;
  }
}

/** Probe every capability the editor needs to boot. Never throws. */
export function detectCapabilities(): CapabilityReport {
  const missing: string[] = [];
  if (!hasWebGL2()) missing.push("WebGL2 (hardware 3D graphics for the viewport)");
  if (!hasWebAssembly()) missing.push("WebAssembly (the geometry kernel)");
  if (!hasLocalStorage()) missing.push("localStorage (crash-recovery snapshots)");
  if (!hasIndexedDb()) missing.push("IndexedDB (saved projects)");
  return { ok: missing.length === 0, missing };
}

/** Replace the app root with a friendly unsupported-browser screen listing the
 * missing capabilities. Plain DOM — no React, no Tailwind, no app modules. */
export function renderUnsupportedScreen(root: HTMLElement, missing: string[]): void {
  root.textContent = ""; // drop anything already in the mount point

  const screen = document.createElement("div");
  screen.setAttribute("data-testid", "unsupported-browser");
  screen.setAttribute("role", "alert");
  screen.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:16px;height:100%;padding:24px;text-align:center;background:#0b0d12;" +
    "color:#ccffee;font-family:system-ui,sans-serif;";

  const title = document.createElement("h1");
  title.textContent = "This browser can't run Plastiq";
  title.style.cssText = "font-size:18px;font-weight:700;margin:0;";
  screen.appendChild(title);

  const intro = document.createElement("p");
  intro.textContent = "Plastiq needs the following, which this browser doesn't provide:";
  intro.style.cssText = "font-size:13px;color:#99aabb;margin:0;max-width:32rem;";
  screen.appendChild(intro);

  const list = document.createElement("ul");
  list.setAttribute("data-testid", "unsupported-missing");
  list.style.cssText = "margin:0;padding:0;list-style:none;font-size:13px;color:#ff9a9a;";
  for (const item of missing) {
    const li = document.createElement("li");
    li.setAttribute("data-testid", "unsupported-missing-item");
    li.textContent = item;
    li.style.cssText = "padding:2px 0;";
    list.appendChild(li);
  }
  screen.appendChild(list);

  const hint = document.createElement("p");
  hint.textContent =
    "Try a current version of Chrome, Edge, Firefox, or Safari (outside private browsing).";
  hint.style.cssText = "font-size:12px;color:#99aabb;margin:0;max-width:32rem;";
  screen.appendChild(hint);

  root.appendChild(screen);
}
