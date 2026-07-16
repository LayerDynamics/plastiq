// @vitest-environment jsdom
// Declarative `.assy` import/export actions (M4.5, finding 9-H1) — a NEW file (jsdom
// for the file-picker + download DOM) so it doesn't contend with registry.test.ts.
// Import drives the REAL picker flow (createElement spy + a synthetic chosen file):
// parseAssy → realizeAssembly → the live useCadStore assembly, with parse/validation
// errors surfaced on the status line and the store left untouched. Export round-trips
// the real store's assembly through assemblyToAssy back into the import path.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAssy, realizeAssembly } from "../assembly/assy.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { MeshDoc } from "../store/types.js";
import { ACTIONS, exportAssyFromStore, importAssyFromDisk, importAssyText } from "./registry.js";

// jsdom has no URL.createObjectURL/revokeObjectURL — install capturing stands-ins once
// for the whole file (the deferred revoke in exportAssyFromStore may fire after a test).
const createdBlobs: Blob[] = [];
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (b: Blob): string => {
      createdBlobs.push(b);
      return `blob:test-${createdBlobs.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (): void => {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCadStore.getState().reset();
  useProjectsStore.setState({ activeMeshDoc: null });
  createdBlobs.length = 0;
});

/** Run the real picker flow with a synthetic chosen file (importGuard.test.ts pattern). */
function importFile(name: string, content: string): void {
  const created: HTMLInputElement[] = [];
  const orig = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = orig(tag);
    if (tag === "input") created.push(el as HTMLInputElement);
    return el;
  });
  importAssyFromDisk();
  const input = created[0]!;
  expect(input.accept).toBe(".assy,.json");
  const file = new File([content], name, { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file] });
  input.onchange!(new Event("change"));
}

const NESTED_DOC = {
  name: "widget",
  links: [{ part: "plate" }, { part: "sub", location: { position: [0, 0, 10] } }],
  subAssemblies: { sub: { links: [{ part: "bolt", location: { position: [1, 0, 0] } }] } },
};

describe("import-assy — a valid document lands in the live assembly store", () => {
  it("realizes instances with composed world poses, reports on the status line, and is undoable", async () => {
    // Seed one interactive instance so undo has a distinct prior assembly to restore.
    useCadStore.getState().addInstance();
    importFile("widget.assy", JSON.stringify(NESTED_DOC));

    await vi.waitFor(() => {
      expect(useCadStore.getState().assembly.instances).toHaveLength(2);
    });
    const { assembly, status } = useCadStore.getState();
    // Import REPLACES the interactive assembly (fresh mates/joints).
    expect(assembly.instances.map((i) => i.part)).toEqual(["plate", "bolt"]);
    expect(assembly.instances[0]!.pose.position).toEqual([0, 0, 0]);
    // Sub-assembly placement [0,0,10] composed with the child's [1,0,0].
    expect(assembly.instances[1]!.pose.position).toEqual([1, 0, 10]);
    expect(assembly.mates).toEqual([]);
    expect(assembly.joints).toEqual([]);
    expect(status).toBe("imported widget.assy: 2 instance(s)");

    // One history snapshot was pushed: undo restores the pre-import assembly.
    useCadStore.getState().undo();
    const restored = useCadStore.getState().assembly.instances;
    expect(restored).toHaveLength(1);
    expect(restored[0]!.name).toBe("Part 1");
  });

  it("the registry action def opens the picker (enabled always outside mesh/voxel mode)", () => {
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    ACTIONS["import-assy"]!.run(undefined as never); // run() ignores the ctx
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("file");
  });
});

describe("import-assy — an invalid document surfaces the error and leaves the store untouched", () => {
  it("schema violation: status reports the parse error, assembly + history unchanged", async () => {
    const id = useCadStore.getState().addInstance();
    const pastBefore = useCadStore.getState().past.length;
    importFile("bad.assy", JSON.stringify({ notLinks: true }));

    await vi.waitFor(() => {
      expect(useCadStore.getState().status).toMatch(/^import failed: assy: document requires/);
    });
    const s = useCadStore.getState();
    expect(s.assembly.instances.map((i) => i.id)).toEqual([id]);
    expect(s.past).toHaveLength(pastBefore); // no history snapshot on failure
  });

  it("malformed JSON: status reports the JSON error, assembly unchanged", () => {
    const id = useCadStore.getState().addInstance();
    importAssyText("garbage.assy", "{not json");
    const s = useCadStore.getState();
    expect(s.status).toMatch(/^import failed: /);
    expect(s.assembly.instances.map((i) => i.id)).toEqual([id]);
  });

  it("sub-assembly cycle: rejected by parseAssy, surfaced on the status line", () => {
    importAssyText(
      "cyclic.assy",
      JSON.stringify({
        links: [{ part: "a" }],
        subAssemblies: { a: { links: [{ part: "a" }] } },
      }),
    );
    const s = useCadStore.getState();
    expect(s.status).toBe("import failed: assy: sub-assembly cycle: a -> a");
    expect(s.assembly.instances).toHaveLength(0);
  });
});

describe("export-assy — round-trip through the real store", () => {
  it("downloads assembly.assy whose realization matches the live instances, and re-imports", async () => {
    const anchors: HTMLAnchorElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "a") {
        (el as HTMLAnchorElement).click = vi.fn(); // no jsdom navigation
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });

    // Real interactive assembly: Part 1 anchored at the origin, Part 2 offset +X.
    useCadStore.getState().addInstance();
    useCadStore.getState().addInstance();
    const live = useCadStore.getState().assembly;

    exportAssyFromStore();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.download).toBe("assembly.assy");
    expect(anchors[0]!.click).toHaveBeenCalledOnce();
    expect(useCadStore.getState().status).toBe("exported assembly.assy");

    // The downloaded JSON parses as a valid .assy doc and realizes to the same layout.
    const text = await createdBlobs[0]!.text();
    const realized = realizeAssembly(parseAssy(JSON.parse(text)));
    expect(realized.instances.map((i) => i.name)).toEqual(live.instances.map((i) => i.name));
    expect(realized.instances.map((i) => i.pose.position)).toEqual(
      live.instances.map((i) => i.pose.position),
    );

    // Full loop: importing the exported text reproduces the layout in the store.
    importAssyText("assembly.assy", text);
    const round = useCadStore.getState().assembly.instances;
    expect(round.map((i) => i.name)).toEqual(["Part 1", "Part 2"]);
    expect(round.map((i) => i.pose.position)).toEqual([
      [0, 0, 0],
      [0.08, 0, 0],
    ]);
  });

  it("is gated on having instances (nothing to export), and mesh mode disables both actions", () => {
    const ctx = undefined as never; // these predicates don't read the ctx
    expect(ACTIONS["export-assy"]!.enabled(ctx)).toBe(false);
    useCadStore.getState().addInstance();
    expect(ACTIONS["export-assy"]!.enabled(ctx)).toBe(true);

    const meshDoc: MeshDoc = {
      kind: "mesh",
      name: "Generated",
      glb: "Z2xURg==",
      source: { mode: "text3d", providerId: "fal:tripo" },
    };
    useProjectsStore.setState({ activeMeshDoc: meshDoc });
    expect(ACTIONS["export-assy"]!.enabled(ctx)).toBe(false);
    expect(ACTIONS["import-assy"]!.enabled(ctx)).toBe(false);
  });
});
