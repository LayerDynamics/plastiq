// Declarative ribbon layout: Workspace → tabs → panels → items. An item is either
// an action button (by registry id) or a "widget" (a special non-button control the
// E2E suite depends on — the sketch launcher's plane/offset selects, the section
// axis/offset). The Ribbon component renders RIBBON[workspace]; the active tab's
// panels show their items, greyed via each action's `enabled`.

import type { Workspace } from "../store/types.js";

/** Special controls that aren't single action buttons. */
export type WidgetKey = "sketchLauncher" | "sectionControl" | "simReadout" | "viewControl";

export type RibbonItem = { kind: "action"; id: string } | { kind: "widget"; widget: WidgetKey };

export interface RibbonPanel {
  title: string;
  items: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  title: string;
  panels: RibbonPanel[];
  /** When set, the tab is only present + auto-selected while that contextual env is
   * active (e.g. "sketch" → while the sketcher is open). */
  contextual?: "sketch";
}

const a = (id: string): RibbonItem => ({ kind: "action", id });
const w = (widget: WidgetKey): RibbonItem => ({ kind: "widget", widget });

export const RIBBON: Record<Workspace, RibbonTab[]> = {
  design: [
    {
      id: "solid",
      title: "Solid",
      panels: [
        {
          title: "Create",
          items: [
            w("sketchLauncher"),
            a("sketch-rect"),
            a("extrude"),
            a("cut"),
            a("revolve"),
            a("loft"),
            a("sweep"),
          ],
        },
        {
          title: "Modify",
          items: [
            a("fillet"),
            a("chamfer"),
            a("shell"),
            a("draft"),
            a("extrude-to-face"),
            a("extrude-along-edge"),
            a("pad"),
          ],
        },
        {
          title: "Combine",
          items: [
            a("mirror"),
            a("linearPattern"),
            a("circularPattern"),
            a("boolean"),
            a("booleanBody"),
            a("transform"),
          ],
        },
        {
          title: "Inspect",
          items: [a("measure"), w("sectionControl"), a("fit-view"), w("viewControl")],
        },
      ],
    },
    {
      // Contextual SKETCH tab — present + auto-selected only while the sketcher is
      // open. Kept thin (Finish, the prominent Fusion verb): the Sketcher overlay
      // owns the draw tools + constraint/dimension palette + its own Cancel button
      // next to the 2D canvas (not duplicated here), and the right-click menu offers
      // the applicable constraints + Cancel.
      id: "sketch",
      title: "Sketch",
      contextual: "sketch",
      panels: [{ title: "Sketch", items: [a("sk-finish")] }],
    },
    {
      id: "utilities",
      title: "Utilities",
      panels: [
        {
          title: "Interchange",
          items: [a("import-step"), a("export-gltf"), a("export-step"), a("export-iges")],
        },
        { title: "Edit", items: [a("undo"), a("redo")] },
      ],
    },
  ],
  assemble: [
    {
      id: "assemble",
      title: "Assemble",
      panels: [
        { title: "Components", items: [a("insert-instance")] },
        // Mate authoring itself (pick two faces → apply) lives in AssemblyTree; this
        // button just enters/leaves that mode.
        { title: "Relationships", items: [a("mate-mode")] },
        { title: "Position", items: [a("explode")] },
        {
          title: "Inspect",
          items: [a("interference"), a("measure"), w("sectionControl"), w("viewControl")],
        },
      ],
    },
  ],
  simulate: [
    {
      id: "simulate",
      title: "Simulate",
      panels: [
        {
          title: "Playback",
          items: [a("sim-pause"), a("sim-step"), a("sim-rewind"), w("simReadout")],
        },
        { title: "Inspect", items: [a("measure")] },
      ],
    },
  ],
};

/** Short display labels for the ribbon (the catalog labels are sentence-style for
 * the context menu, e.g. "Extrude profile"). These also keep the labels the E2E
 * suite matches via getByText exact ("Extrude") stable. Falls back to the action's
 * own label when absent. Dynamic-label actions (e.g. sim-pause) are left out. */
export const RIBBON_LABELS: Record<string, string> = {
  extrude: "Extrude",
  cut: "Cut",
  revolve: "Revolve",
  "extrude-to-face": "To Face",
  "extrude-along-edge": "Along Edge",
  "fit-view": "Fit",
};

/** Carry-forward data-testids so the existing E2E suite keeps targeting the same
 * controls after the toolbar is replaced by the ribbon. Falls back to `ribbon-<id>`. */
export const RIBBON_TESTIDS: Record<string, string> = {
  extrude: "add-extrude",
  cut: "add-cut",
  revolve: "add-revolve",
};

/** Glyphs for ribbon action buttons that don't carry an icon in the registry
 * (the context-menu-derived actions). Mirrors the feature-tree icon set. */
export const RIBBON_ICONS: Record<string, string> = {
  "sketch-on-face": "✎",
  extrude: "⬆",
  cut: "⬇",
  revolve: "⟳",
  fillet: "◜",
  chamfer: "◣",
  shell: "▣",
  draft: "◢",
  pad: "⇕",
  "extrude-to-face": "⤒",
  "extrude-along-edge": "↗",
  measure: "📐",
  "fit-view": "⤢",
  explode: "✸",
  interference: "⚠",
  "sim-pause": "❚❚",
  "sim-step": "⏭",
  "sim-rewind": "⏮",
  "sk-finish": "✔",
};
