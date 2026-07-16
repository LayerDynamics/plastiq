import { useEffect, useMemo, useState } from "react";
import { RecmMenuView, RECM, type RecmContext } from "@plastiq/recm";
import {
  buildPlastiqRecmContext,
  plastiqRecmManager,
  publishRecmMenuSeam,
  type PlastiqRecmAppContext,
} from "./recmContext.js";
import type { ContextTarget } from "./contextSelection.js";
import { runContextAction, type ActionGroup } from "./config.js";

/** Per-item testid: `ctx-{action-id}` — matches the FeatureTree menu + the e2e
 *  contract, so the whole app addresses menu items by one convention. */
const ctxItemTestId = (id: string): string => `ctx-${id}`;

export function PlastiqWorldContextMenu({
  open,
  anchor,
  target,
  onClose,
}: {
  open: boolean;
  anchor: [number, number, number] | null;
  target: ContextTarget | null;
  onClose?: () => void;
}): React.JSX.Element | null {
  const context = useMemo(
    () =>
      target && anchor
        ? plastiqRecmManager.buildContext(
            buildPlastiqRecmContext({
              target,
              source: "canvas",
              origin: { kind: "world", point: anchor },
              openMenus: open,
              menuDepth: 1,
            }),
          )
        : null,
    [anchor, open, target],
  );
  // Verification seam: publish the context that reached the menu (+ the rings it
  // resolved to) while open; clear it when closed.
  useEffect(() => {
    publishRecmMenuSeam(context);
    return () => publishRecmMenuSeam(null);
  }, [context]);
  if (!target || !anchor || !open || !context) return null;
  return (
    <RECM
      open={open}
      anchor={anchor}
      context={context}
      providers={plastiqRecmManager.providers}
      config={plastiqRecmManager.config}
      onRun={(id) => {
        // Run the catalog action, then dismiss — running a terminal option closes
        // the menu (the sketch overlay does the same via setCtxMenu(null)).
        runContextAction(id, target);
        onClose?.();
      }}
      onClose={onClose}
      itemTestId={ctxItemTestId}
    />
  );
}

export function PlastiqScreenContextMenu({
  open,
  anchor,
  target,
  onRun,
  onClose,
}: {
  open: boolean;
  anchor: { x: number; y: number } | null;
  target: ContextTarget | null;
  onRun: (id: string) => void;
  onClose?: () => void;
}): React.JSX.Element | null {
  const [activePath, setActivePath] = useState<readonly string[]>([]);
  const context = useMemo(
    () =>
      target && anchor
        ? plastiqRecmManager.buildContext(
            buildPlastiqRecmContext({
              target,
              source: "sketch",
              origin: { kind: "screen", x: anchor.x, y: anchor.y },
              openMenus: open,
              menuDepth: 1,
            }),
          )
        : null,
    [anchor, open, target],
  );
  useEffect(() => {
    publishRecmMenuSeam(context);
    return () => publishRecmMenuSeam(null);
  }, [context]);
  if (!context || !anchor || !open) return null;
  const { tree } = plastiqRecmManager.expand(context, activePath);
  return (
    <div
      className="fixed z-50"
      style={{ left: anchor.x, top: anchor.y, transform: "translate(-50%, -50%)" }}
    >
      <RecmMenuView<RecmContext<PlastiqRecmAppContext>, ActionGroup>
        rings={tree.rings}
        activePath={activePath}
        onPathChange={setActivePath}
        onRun={onRun}
        onClose={onClose}
        config={plastiqRecmManager.config}
        testid="sketch-context-menu"
        itemTestId={ctxItemTestId}
      />
    </div>
  );
}
