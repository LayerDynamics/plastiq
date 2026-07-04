// The active workspace's TOOLS, in the left sidebar (FR-4). The per-workspace tabs
// from ribbonConfig are flattened into vertical collapsible groups (Create / Modify
// / Combine / Inspect …); only the first group is expanded by default so the column
// doesn't become a tower. While sketching (Design), only the contextual Sketch group
// shows. Each tool is a full-width row that greys via the registry's `enabled`.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { RIBBON, type RibbonItem } from "./ribbonConfig.js";
import { ActionButton } from "./ActionButton.js";
import { useActionContext } from "./useActionContext.js";
import { SketchLauncher } from "./widgets/SketchLauncher.js";
import { SectionControl } from "./widgets/SectionControl.js";
import { SimReadout } from "./widgets/SimReadout.js";
import { ViewControl } from "./widgets/ViewControl.js";

interface Group {
  key: string;
  title: string;
  items: RibbonItem[];
}

/** Sculpt-mode indicator (ADR-0010): the open voxel document + active tool, live.
 * Subscribing here also keeps the sculpt ActionButtons' enabled/active states fresh
 * — voxel edits change the voxel store, not the cad store the panel otherwise reads. */
function SculptStatus(): React.JSX.Element | null {
  const doc = useVoxelStore((s) => s.doc);
  const tool = useVoxelStore((s) => s.tool);
  if (!doc) {
    return (
      <p data-testid="sculpt-status" className="px-2 py-1 text-[10px] text-[#789]">
        No sculpt open — use New Sculpt.
      </p>
    );
  }
  return (
    <p data-testid="sculpt-status" className="px-2 py-1 text-[10px] text-[#8aa]">
      {doc.name ?? "Voxel sculpt"} · {doc.cells.length} voxel{doc.cells.length === 1 ? "" : "s"} ·{" "}
      {doc.dims.join("×")} @ {(doc.voxelSize * 1000).toFixed(1)} mm · tool: {tool}
    </p>
  );
}

export function WorkspacePanel(): React.JSX.Element {
  const workspace = useCadStore((s) => s.workspace);
  const sketchActive = useSketchStore((s) => s.active);
  const ctx = useActionContext();

  // Sketching (in Design) swaps the panel for the contextual Sketch group only.
  const sketching = sketchActive && workspace === "design";
  const groups: Group[] = [];
  for (const tab of RIBBON[workspace]) {
    const isSketch = tab.contextual === "sketch";
    if (sketching ? !isSketch : isSketch) continue;
    for (const panel of tab.panels) {
      groups.push({ key: `${tab.id}:${panel.title}`, title: panel.title, items: panel.items });
    }
  }

  // All groups are expanded by default — the point is to SHOW the actions; groups
  // stay collapsible for users who want to tidy. Track the collapsed set (empty =
  // all open) and reset it when the workspace / sketch mode changes the group set.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsed(new Set());
  }, [workspace, sketching]);

  const toggle = (k: string): void =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const renderItem = (item: RibbonItem, i: number): React.JSX.Element | null => {
    if (item.kind === "widget") {
      if (item.widget === "sketchLauncher") return <SketchLauncher key="sketchLauncher" />;
      if (item.widget === "simReadout") return <SimReadout key="simReadout" />;
      if (item.widget === "viewControl") return <ViewControl key="viewControl" />;
      return <SectionControl key="sectionControl" />;
    }
    return <ActionButton key={item.id ?? i} id={item.id} ctx={ctx} variant="row" />;
  };

  return (
    <div data-testid="workspace-panel" className="mb-2 flex flex-col gap-1">
      {workspace === "sculpt" && <SculptStatus />}
      {groups.map((g) => {
        const open = !collapsed.has(g.key);
        return (
          <section
            key={g.key}
            data-testid={g.title === "Create" ? "feature-menu" : undefined}
            className="rounded border border-[#1b2230]"
          >
            <button
              type="button"
              onClick={() => toggle(g.key)}
              aria-expanded={open}
              data-testid={`ws-group-${g.key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
              className="flex w-full items-center justify-between rounded-t px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[#8aa] hover:bg-[#1b2230]"
            >
              <span>{g.title}</span>
              <span className="text-[#567]">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <div className="flex flex-col gap-0.5 px-1 pb-1">{g.items.map(renderItem)}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
