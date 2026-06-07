// The workspace ribbon (FR-4, Fusion-style): a top-left switcher + a global
// selection-mode cluster + the active workspace's tabs, each tab a row of grouped
// panels of tools. Replaces the old horizontally-scrolling Toolbar — content is
// scoped by workspace + tab, so it fits without scrolling. Each action button greys
// via the registry's `enabled`, evaluated against a context target built from the
// current selection/state (the same ContextTarget the right-click menu uses).

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { resolveContextTarget } from "../three/contextmenu/contextSelection.js";
import { RIBBON, type RibbonItem } from "./ribbonConfig.js";
import { RibbonButton } from "./RibbonButton.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { SketchLauncher } from "./widgets/SketchLauncher.js";
import { SectionControl } from "./widgets/SectionControl.js";
import { ProjectsMenu } from "../app/ProjectsMenu.js";

const SELMODES = ["selmode-face", "selmode-edge", "selmode-vertex", "selmode-body"];
const GIZMO_MODES = ["gizmo-translate", "gizmo-rotate"];

export function Ribbon(): React.JSX.Element {
  // Subscribe to the slices that affect enabled/active so the ribbon recomputes on
  // change — but NOT simTicks (would re-render every frame while simulating).
  const workspace = useCadStore((s) => s.workspace);
  const picks = useCadStore((s) => s.picks);
  const selMode = useCadStore((s) => s.selMode);
  const selectionRefs = useCadStore((s) => s.selectionRefs);
  const features = useCadStore((s) => s.features);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const mateMode = useCadStore((s) => s.mateMode);
  const matePicks = useCadStore((s) => s.matePicks);
  const simulating = useCadStore((s) => s.simulating);
  const simPaused = useCadStore((s) => s.simPaused);
  const section = useCadStore((s) => s.section);
  const measuring = useCadStore((s) => s.measuring);
  const explodeFactor = useCadStore((s) => s.explodeFactor);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const sketchActive = useSketchStore((s) => s.active);
  const sketchSelection = useSketchStore((s) => s.selection);
  const solverReady = useSketchStore((s) => s.solverReady);
  const sketchModel = useSketchStore((s) => s.model);

  const ctx = resolveContextTarget({
    cad: {
      picks,
      selMode,
      selectionRefs,
      features,
      selectedFeatureId,
      mateMode,
      matePicks,
      simulating,
      simPaused,
      section,
      measuring,
      explodeFactor,
      gizmoMode,
    },
    sketch: { active: sketchActive, selection: sketchSelection, solverReady, model: sketchModel },
    hit: null,
    worldPoint: [0, 0, 0],
  });

  // Tabs for the workspace; the contextual SKETCH tab is present only while sketching.
  const tabs = RIBBON[workspace].filter(
    (t) => !t.contextual || (t.contextual === "sketch" && sketchActive),
  );
  const [activeId, setActiveId] = useState<string>(tabs[0]?.id ?? "");
  useEffect(() => {
    // Jump to the sketch tab when a sketch opens; otherwise keep a valid tab.
    if (sketchActive && workspace === "design") {
      setActiveId("sketch");
      return;
    }
    setActiveId((cur) => {
      const valid = RIBBON[workspace].some(
        (t) => t.id === cur && (!t.contextual || sketchActive),
      );
      return valid ? cur : (RIBBON[workspace][0]?.id ?? "");
    });
  }, [workspace, sketchActive]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const renderItem = (item: RibbonItem, i: number): React.JSX.Element | null => {
    if (item.kind === "widget") {
      return item.widget === "sketchLauncher" ? (
        <SketchLauncher key="sketchLauncher" />
      ) : (
        <SectionControl key="sectionControl" />
      );
    }
    return <RibbonButton key={item.id ?? i} id={item.id} ctx={ctx} />;
  };

  return (
    <div
      data-testid="ribbon"
      role="toolbar"
      aria-label="Editor toolbar"
      className="flex flex-col border-b border-[#222a36] bg-black/40"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-1">
        <span className="text-sm font-bold text-[#dfe]">Plastiq</span>
        <WorkspaceSwitcher />
        <ProjectsMenu />
        <div className="mx-1 h-4 w-px bg-[#2a3444]" />
        <div
          role="group"
          aria-label="Selection mode"
          data-testid="selmode"
          className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
        >
          {SELMODES.map((id) => (
            <RibbonButton key={id} id={id} ctx={ctx} />
          ))}
        </div>
        <div
          role="group"
          aria-label="Transform mode"
          data-testid="gizmomode"
          className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
        >
          {GIZMO_MODES.map((id) => (
            <RibbonButton key={id} id={id} ctx={ctx} />
          ))}
        </div>
        <div className="mx-1 h-4 w-px bg-[#2a3444]" />
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`ribbon-tab-${t.id}`}
              aria-pressed={t.id === activeTab?.id}
              onClick={() => setActiveId(t.id)}
              className={`rounded px-2.5 py-1 text-xs ${
                t.id === activeTab?.id
                  ? "bg-[#1b2230] text-[#dfe]"
                  : "text-[#9ab] hover:bg-[#1b2230]"
              }`}
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-stretch gap-3 border-t border-[#222a36] px-3 py-1">
        {activeTab?.panels.map((panel) => (
          <div
            key={panel.title}
            data-testid={panel.title === "Create" ? "feature-menu" : undefined}
            className="flex flex-col rounded border border-[#222a36] px-1.5 py-0.5"
          >
            <div className="flex flex-1 items-center gap-0.5">
              {panel.items.map((item, i) => renderItem(item, i))}
            </div>
            <div className="mt-0.5 text-center text-[9px] uppercase tracking-wide text-[#567]">
              {panel.title}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
