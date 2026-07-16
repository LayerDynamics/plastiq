// Recovery-snapshot robustness at the store level (Review #13) — a NEW file so
// it doesn't contend with projectsStore.test.ts:
//   • a quota-failed debounced recovery write surfaces on the status line
//     (projectsStore → StatusBar), quota distinguished from other failures;
//   • init() hydrates a compacted snapshot (externalized importStep payload)
//     so recover() loads a document that rebuilds identically.
// The heavy sql.js-backed projectStore() and the aiStore are mocked; everything
// else — the autosave subscription, the debounce, writeRecovery/hydrateRecovery,
// the cad store — is the real code path.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { clearRecovery, writeRecovery } from "./recovery.js";
import { pruneRecoveryPayloads } from "./recoveryPayloads.js";
import type { CadDocument } from "../store/types.js";
import type { ProjectStore } from "./types.js";

vi.mock("./index.js", () => ({
  projectStore: async (): Promise<ProjectStore> => ({
    list: async () => [],
    load: async () => null,
    create: async (name: string) => ({
      id: "p1",
      name,
      units: "mm",
      created: 1,
      updated: 1,
      thumbnail: null,
    }),
    save: async () => {},
    rename: async () => {},
    delete: async () => {},
  }),
}));

vi.mock("../ai/aiStore.js", () => ({
  useAiStore: {
    getState: () => ({
      openConversation: async () => {},
      deleteConversation: async () => {},
    }),
  },
}));

function stubThrowingLocalStorage(err: () => Error): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {
      throw err();
    },
    removeItem: () => {},
  };
}

afterEach(async () => {
  // Flush any pending debounced recovery write before tearing the stubs down.
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
  delete (globalThis as { localStorage?: unknown }).localStorage;
  useProjectsStore.setState({
    store: null,
    currentId: null,
    currentName: "Untitled",
    status: "",
    recoverable: null,
    busy: false,
  });
  useCadStore.getState().reset();
  clearRecovery();
  await pruneRecoveryPayloads();
});

describe("projectsStore — recovery write failures surface on the status line (Review #13)", () => {
  it("quota exhaustion during the debounced snapshot → 'storage full' status", async () => {
    vi.useFakeTimers();
    stubThrowingLocalStorage(
      () => new DOMException("the quota has been exceeded", "QuotaExceededError"),
    );
    await useProjectsStore.getState().init(); // wires autosave + recovery

    // A real edit: the cad-store subscription schedules the 500ms dirty snapshot.
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } });
    await vi.advanceTimersByTimeAsync(600);

    expect(useProjectsStore.getState().status).toBe(
      "recovery snapshot failed (storage full) — save your work",
    );
  });

  it("a non-quota storage failure surfaces its message (distinguished from quota)", async () => {
    vi.useFakeTimers();
    stubThrowingLocalStorage(() => new Error("backing store detached"));
    await useProjectsStore.getState().init();

    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } });
    await vi.advanceTimersByTimeAsync(600);

    const status = useProjectsStore.getState().status;
    expect(status).toContain("recovery snapshot failed — save your work");
    expect(status).toContain("backing store detached");
    expect(status).not.toContain("storage full");
  });

  it("a successful snapshot write leaves the status line alone", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();
    useProjectsStore.setState({ status: "" });

    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } });
    await vi.advanceTimersByTimeAsync(600);

    expect(useProjectsStore.getState().status).toBe("");
  });
});

describe("projectsStore — init() hydrates a compacted snapshot before recover() (Review #13)", () => {
  it("recover() restores the full importStep payload from a compacted crash snapshot", async () => {
    vi.useFakeTimers();
    const stepText = `ISO-10303-21;\n${"#1=CARTESIAN_POINT(''); ".repeat(2000)}END-ISO-10303-21;`;
    const importDoc: CadDocument = {
      features: [{ id: "f1", type: "importStep", name: "part.step", data: { step: stepText } }],
      params: {},
    };
    // A prior session crashed after externalizing the payload (compacted write).
    const w = await writeRecovery(
      { doc: importDoc, name: "Part A", currentId: null, dirty: true, savedAt: 1 },
      { compactMinBytes: 1024 },
    );
    expect(w).toEqual({ ok: true });

    await useProjectsStore.getState().init();

    // init() hydrated the snapshot: the prompt-able document is complete again.
    const rec = useProjectsStore.getState().recoverable!;
    expect(rec).toBeTruthy();
    expect(rec.doc.features[0]!.data!["step"]).toBe(stepText);
    expect(rec.doc.features[0]!.data!["stepRef"]).toBeUndefined();

    // ...and recover() loads that identical document into the editor.
    useProjectsStore.getState().recover();
    const live = useCadStore.getState();
    expect(live.features[0]!.type).toBe("importStep");
    expect(live.features[0]!.data!["step"]).toBe(stepText);
    expect(useProjectsStore.getState().recoverable).toBeNull();
  });
});
