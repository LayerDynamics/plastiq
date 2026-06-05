// Feature-tree panel (SPEC-5 FR-3/FR-22/FR-27): the editable build history.
// Renders the document's features in rebuild order with a per-type icon,
// click-to-select (synced to the 3D selection), double-click-to-rename, inline
// hover actions, status badges (suppressed / errored), drag-free reorder, and a
// right-click CONTEXT MENU (edit / suppress / roll back / delete — FR-27).

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import type { EditorFeature, FeatureId } from "../store/types.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import type { SketchModel } from "../sketch/model.js";

const ICONS: Record<string, string> = {
  box: "▢",
  sketch: "✎",
  extrude: "⬆",
  cut: "⬇",
  revolve: "⟳",
  fillet: "◜",
  chamfer: "◣",
  shell: "▣",
  draft: "◢",
  boolean: "⊕",
  pattern: "▦",
  linearPattern: "▤",
  circularPattern: "❋",
  mirror: "◫",
  transform: "✥",
  placement: "✥",
  importStep: "⤒",
};

/** Open the sketch editor for a sketch feature (if it carries a model). */
function editSketch(feature: EditorFeature): boolean {
  if (feature.type === "sketch" && feature.data?.["model"] != null) {
    const m = feature.data["model"] as SketchModel;
    useSketchStore.getState().enterSketch(m.plane, feature.id, m);
    return true;
  }
  return false;
}

interface MenuState {
  id: FeatureId;
  index: number;
  x: number;
  y: number;
}

function FeatureRow({
  feature,
  index,
  count,
  editing,
  onBeginEdit,
  onEndEdit,
  onContext,
}: {
  feature: EditorFeature;
  index: number;
  count: number;
  editing: boolean;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onContext: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const errorFeatureId = useCadStore((s) => s.errorFeatureId);
  const rollbackIndex = useCadStore((s) => s.rollbackIndex);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const renameFeature = useCadStore((s) => s.renameFeature);
  const toggleSuppress = useCadStore((s) => s.toggleSuppress);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const reorderFeature = useCadStore((s) => s.reorderFeature);
  const setRollback = useCadStore((s) => s.setRollback);

  const selected = selectedFeatureId === feature.id;
  const errored = errorFeatureId === feature.id;
  const rolledBack = rollbackIndex !== null && index >= rollbackIndex;

  const commit = (value: string): void => {
    const name = value.trim();
    if (name) renameFeature(feature.id, name);
    onEndEdit();
  };

  return (
    <li
      data-testid="feature-row"
      data-feature-id={feature.id}
      data-selected={selected}
      role="treeitem"
      aria-selected={selected}
      aria-label={`${feature.type} ${feature.name ?? feature.id}${feature.suppressed ? " (suppressed)" : ""}`}
      onClick={() => selectFeature(feature.id)}
      onContextMenu={onContext}
      className={`group flex items-center gap-1.5 rounded px-1.5 py-1 text-sm ${
        selected ? "bg-[#1f2a3a] text-[#dfe]" : "text-[#9ab] hover:bg-[#151b25]"
      } ${feature.suppressed || rolledBack ? "opacity-50" : ""}`}
    >
      <span className="w-4 text-center text-[#67809a]" aria-hidden>
        {ICONS[feature.type] ?? "•"}
      </span>
      {editing ? (
        <input
          autoFocus
          defaultValue={feature.name ?? feature.id}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            else if (e.key === "Escape") onEndEdit();
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded border border-[#4ea1ff] bg-[#0e1219] px-1 text-[#cfe] outline-none"
        />
      ) : (
        <span
          className="flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onBeginEdit();
          }}
          title={`${feature.type} (${feature.id})`}
        >
          {feature.name ?? feature.id}
        </span>
      )}

      {errored && (
        <span data-testid="badge-error" title="Rebuild error" className="text-[#ff6b6b]">
          ⚠
        </span>
      )}
      {feature.type === "sketch" && feature.data?.["model"] != null && (
        <button
          type="button"
          title="Edit sketch"
          data-testid="edit-sketch"
          onClick={(e) => {
            e.stopPropagation();
            editSketch(feature);
          }}
          className="invisible rounded px-0.5 text-xs text-[#789] hover:text-[#cfe] group-hover:visible"
        >
          ✎
        </button>
      )}
      {feature.suppressed && (
        <span data-testid="badge-suppressed" className="text-[10px] uppercase text-[#678]">
          off
        </span>
      )}
      <button
        type="button"
        title="Move up"
        disabled={index === 0}
        onClick={(e) => {
          e.stopPropagation();
          reorderFeature(feature.id, index - 1);
        }}
        className="invisible rounded px-0.5 text-xs text-[#789] enabled:hover:text-[#cfe] disabled:opacity-30 group-hover:visible"
      >
        ▲
      </button>
      <button
        type="button"
        title="Move down"
        disabled={index === count - 1}
        onClick={(e) => {
          e.stopPropagation();
          reorderFeature(feature.id, index + 1);
        }}
        className="invisible rounded px-0.5 text-xs text-[#789] enabled:hover:text-[#cfe] disabled:opacity-30 group-hover:visible"
      >
        ▼
      </button>
      <button
        type="button"
        title="Roll back to before this feature"
        onClick={(e) => {
          e.stopPropagation();
          setRollback(index);
        }}
        className="invisible rounded px-0.5 text-xs text-[#789] hover:text-[#ffd34a] group-hover:visible"
      >
        ⏸
      </button>
      <button
        type="button"
        title={feature.suppressed ? "Unsuppress" : "Suppress"}
        onClick={(e) => {
          e.stopPropagation();
          toggleSuppress(feature.id);
        }}
        className="invisible rounded px-1 text-xs text-[#789] hover:text-[#cfe] group-hover:visible"
      >
        {feature.suppressed ? "☐" : "☑"}
      </button>
      <button
        type="button"
        title="Delete feature"
        onClick={(e) => {
          e.stopPropagation();
          removeFeature(feature.id);
        }}
        className="invisible rounded px-1 text-xs text-[#789] hover:text-[#ff6b6b] group-hover:visible"
      >
        ✕
      </button>
    </li>
  );
}

/** Right-click context menu for a feature (FR-27). */
function FeatureContextMenu({
  menu,
  onBeginEdit,
  onClose,
}: {
  menu: MenuState;
  onBeginEdit: (id: FeatureId) => void;
  onClose: () => void;
}): React.JSX.Element {
  const features = useCadStore((s) => s.features);
  const toggleSuppress = useCadStore((s) => s.toggleSuppress);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const setRollback = useCadStore((s) => s.setRollback);
  const feature = features.find((f) => f.id === menu.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!feature) return <></>;
  const item =
    "block w-full px-3 py-1 text-left text-xs text-[#cfe] hover:bg-[#1f2a3a] disabled:opacity-40";
  const run = (fn: () => void) => (): void => {
    fn();
    onClose();
  };

  return (
    <>
      {/* Backdrop swallows the next click to dismiss the menu. */}
      <div
        data-testid="ctx-backdrop"
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        data-testid="feature-context-menu"
        role="menu"
        className="fixed z-50 min-w-32 rounded border border-[#2a3444] bg-[#0e1219] py-1 shadow-lg"
        style={{ left: menu.x, top: menu.y }}
      >
        <button
          type="button"
          data-testid="ctx-edit"
          className={item}
          onClick={run(() => {
            if (!editSketch(feature)) onBeginEdit(feature.id);
          })}
        >
          {feature.type === "sketch" && feature.data?.["model"] != null ? "Edit sketch" : "Rename"}
        </button>
        <button
          type="button"
          data-testid="ctx-suppress"
          className={item}
          onClick={run(() => toggleSuppress(feature.id))}
        >
          {feature.suppressed ? "Unsuppress" : "Suppress"}
        </button>
        <button
          type="button"
          data-testid="ctx-rollback"
          className={item}
          onClick={run(() => setRollback(menu.index))}
        >
          Roll back to here
        </button>
        <div className="my-1 border-t border-[#2a3444]" />
        <button
          type="button"
          data-testid="ctx-delete"
          className="block w-full px-3 py-1 text-left text-xs text-[#ff8a8a] hover:bg-[#2a1717]"
          onClick={run(() => removeFeature(feature.id))}
        >
          Delete
        </button>
      </div>
    </>
  );
}

export function FeatureTree(): React.JSX.Element {
  const features = useCadStore((s) => s.features);
  const rollbackIndex = useCadStore((s) => s.rollbackIndex);
  const setRollback = useCadStore((s) => s.setRollback);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const selectFeature = useCadStore((s) => s.selectFeature);
  const removeFeature = useCadStore((s) => s.removeFeature);
  const [editingId, setEditingId] = useState<FeatureId | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Keyboard navigation (NFR-5): ↑/↓ move selection, Delete removes, F2/Enter
  // rename. Active only when not inline-editing a name.
  const onTreeKeyDown = (e: React.KeyboardEvent): void => {
    if (editingId) return;
    const idx = features.findIndex((f) => f.id === selectedFeatureId);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = features[Math.min(features.length - 1, idx < 0 ? 0 : idx + 1)];
      if (next) selectFeature(next.id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = features[Math.max(0, idx < 0 ? 0 : idx - 1)];
      if (prev) selectFeature(prev.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && idx >= 0) {
      e.preventDefault();
      removeFeature(features[idx]!.id);
    } else if ((e.key === "F2" || e.key === "Enter") && idx >= 0) {
      e.preventDefault();
      setEditingId(features[idx]!.id);
    }
  };

  if (features.length === 0) {
    return <p className="px-1.5 text-sm opacity-60">No features yet.</p>;
  }
  return (
    <div>
      {rollbackIndex !== null && (
        <button
          type="button"
          data-testid="rollback-resume"
          onClick={() => setRollback(null)}
          className="mb-1 w-full rounded border border-[#3a3420] bg-[#21200f] px-2 py-1 text-left text-[11px] text-[#ffd34a] hover:bg-[#2a2814]"
        >
          ⏵ Rolled back at {rollbackIndex}/{features.length} — resume
        </button>
      )}
      <ul
        data-testid="feature-tree"
        role="tree"
        aria-label="Feature tree"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        className="space-y-0.5 outline-none"
      >
        {features.map((f: EditorFeature, i: number) => (
          <FeatureRow
            key={f.id as FeatureId}
            feature={f}
            index={i}
            count={features.length}
            editing={editingId === f.id}
            onBeginEdit={() => setEditingId(f.id)}
            onEndEdit={() => setEditingId(null)}
            onContext={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ id: f.id, index: i, x: e.clientX, y: e.clientY });
            }}
          />
        ))}
      </ul>
      {menu && (
        <FeatureContextMenu
          menu={menu}
          onBeginEdit={(id) => setEditingId(id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
