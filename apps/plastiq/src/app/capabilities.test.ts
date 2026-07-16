// @vitest-environment jsdom
// Boot capability guard (Review #17): detection of WebGL2 / WebAssembly /
// localStorage / IndexedDB with each global stubbed out in turn, and the
// unsupported-browser screen naming exactly what's missing.
//
// jsdom's canvas has no WebGL and no IndexedDB, so the "all present" case stubs
// both IN; the missing cases stub the remaining real globals OUT.

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectCapabilities, renderUnsupportedScreen } from "./capabilities.js";

/** Make every capability probe pass in jsdom (WebGL2 context + indexedDB). */
function stubAllPresent(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as unknown as RenderingContext,
  );
  vi.stubGlobal("indexedDB", {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectCapabilities", () => {
  it("reports ok with nothing missing when every capability is present", () => {
    stubAllPresent();
    const report = detectCapabilities();
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("flags WebGL2 when the context cannot be created", () => {
    stubAllPresent();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const report = detectCapabilities();
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("WebGL2"))).toBe(true);
    expect(report.missing.some((m) => m.startsWith("WebAssembly"))).toBe(false);
  });

  it("flags WebAssembly when the global is absent", () => {
    stubAllPresent();
    vi.stubGlobal("WebAssembly", undefined);
    const report = detectCapabilities();
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("WebAssembly"))).toBe(true);
  });

  it("flags localStorage when writes throw (private-mode style lockdown)", () => {
    stubAllPresent();
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("denied");
      },
      getItem: () => null,
      removeItem: () => undefined,
    });
    const report = detectCapabilities();
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("localStorage"))).toBe(true);
  });

  it("flags IndexedDB when the global is absent", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as unknown as RenderingContext,
    );
    // indexedDB deliberately NOT stubbed in — jsdom has none.
    const report = detectCapabilities();
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("IndexedDB"))).toBe(true);
  });

  it("never throws even with a hostile environment", () => {
    stubAllPresent();
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("WebAssembly", undefined);
    expect(() => detectCapabilities()).not.toThrow();
    expect(detectCapabilities().missing.length).toBe(3);
  });
});

describe("renderUnsupportedScreen", () => {
  it("replaces the root content and names exactly what's missing", () => {
    const root = document.createElement("div");
    root.appendChild(document.createElement("span")); // pre-existing content
    const missing = ["WebGL2 (hardware 3D graphics for the viewport)", "IndexedDB (saved projects)"];
    renderUnsupportedScreen(root, missing);
    expect(root.querySelector("span")).toBeNull(); // old content dropped
    expect(root.querySelector('[data-testid="unsupported-browser"]')).not.toBeNull();
    const items = [...root.querySelectorAll('[data-testid="unsupported-missing-item"]')].map(
      (li) => li.textContent,
    );
    expect(items).toEqual(missing);
  });
});
