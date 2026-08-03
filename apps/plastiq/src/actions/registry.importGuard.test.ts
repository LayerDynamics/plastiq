// @vitest-environment jsdom
// Import size guard (Review #13) — a NEW file so it doesn't contend with
// registry.test.ts. A large STEP import must WARN (status line), never block:
// the file is imported all the same, and the warning states the
// recovery-snapshot implication so the user saves promptly.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importIgesFromDisk,
  importStatusMessage,
  importStepFromDisk,
  LARGE_IMPORT_WARN_BYTES,
} from "./registry.js";
import { useCadStore } from "../store/store.js";

afterEach(() => {
  vi.restoreAllMocks();
  useCadStore.getState().reset();
});

describe("importStatusMessage — size-aware status (never a block)", () => {
  it("a small import reports plainly", () => {
    expect(importStatusMessage("bracket.step", 120_000)).toBe("imported bracket.step");
  });

  it("just under the threshold stays plain; at the threshold it warns", () => {
    expect(importStatusMessage("a.step", LARGE_IMPORT_WARN_BYTES - 1)).toBe("imported a.step");
    const warned = importStatusMessage("a.step", LARGE_IMPORT_WARN_BYTES);
    expect(warned).toContain("8.0 MB");
    expect(warned).toContain("large STEP");
  });

  it("the warning states the recovery-snapshot implication and urges a save", () => {
    const msg = importStatusMessage("housing.step", 12 * 1024 * 1024 + 512 * 1024);
    expect(msg).toContain("imported housing.step");
    expect(msg).toContain("12.5 MB");
    expect(msg).toContain("crash-recovery");
    expect(msg).toContain("save your project");
  });
});

describe("importStepFromDisk — the guard warns but never blocks (Review #13)", () => {
  /** Run the real picker flow with a synthetic chosen file. */
  function importFile(name: string, content: string): void {
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    importStepFromDisk();
    const input = created[0]!;
    const file = new File([content], name, { type: "application/step" });
    Object.defineProperty(input, "files", { value: [file] });
    input.onchange!(new Event("change"));
  }

  it("a large STEP is still imported (feature added, full text kept) AND the status warns", async () => {
    const big = `ISO-10303-21;\n${"x".repeat(LARGE_IMPORT_WARN_BYTES)}\nEND-ISO-10303-21;`;
    importFile("big.step", big);

    await vi.waitFor(() => {
      const f = useCadStore.getState().features.find((x) => x.type === "importStep");
      expect(f).toBeDefined();
      expect(f!.data!["step"]).toBe(big); // NOT truncated / blocked
    });
    const status = useCadStore.getState().status;
    expect(status).toContain("imported big.step");
    expect(status).toContain("large STEP");
    expect(status).toContain("save your project");
  });

  it("a small STEP imports with the plain status (no warning noise)", async () => {
    importFile("small.step", "ISO-10303-21; tiny END-ISO-10303-21;");
    await vi.waitFor(() => {
      expect(useCadStore.getState().status).toBe("imported small.step");
    });
  });
});

describe("importIgesFromDisk", () => {
  it("accepts IGES extensions and persists the complete source text", async () => {
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    importIgesFromDisk();
    const input = created[0]!;
    expect(input.accept).toBe(".iges,.igs");
    const text = "IGES source text";
    Object.defineProperty(input, "files", {
      value: [new File([text], "bracket.igs", { type: "application/iges" })],
    });
    input.onchange!(new Event("change"));

    await vi.waitFor(() => {
      const feature = useCadStore.getState().features.find((x) => x.type === "importIges");
      expect(feature?.data?.["iges"]).toBe(text);
      expect(useCadStore.getState().status).toBe("imported bracket.igs");
    });
  });
});
