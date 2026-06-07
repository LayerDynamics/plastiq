// Pure menu builder: turn a ContextTarget + the action catalog into the ordered,
// grouped, context-filtered list the gizmo renders. No store/DOM access, so the
// "which options for this selection" logic unit-tests in Node.

import { CONTEXT_ACTIONS, type ActionGroup, type ContextAction } from "./config.js";
import type { ContextTarget } from "./contextSelection.js";

export interface MenuItem {
  id: string;
  label: string;
  danger: boolean;
  enabled: boolean;
}

export interface MenuSection {
  group: ActionGroup;
  items: MenuItem[];
}

/** Top-to-bottom group order; dividers fall between non-empty groups. */
const GROUP_ORDER: ActionGroup[] = [
  "create",
  "modify",
  "sketch",
  "assembly",
  "mate",
  "sim",
  "view",
  "selection",
  "feature",
  "danger",
];

/** Filter the catalog by visibility, resolve labels/enabled, group + order. */
export function buildMenuSections(
  ctx: ContextTarget,
  catalog: readonly ContextAction[] = CONTEXT_ACTIONS,
): MenuSection[] {
  const visible = catalog.filter((a) => a.visible(ctx));
  const sections: MenuSection[] = [];
  for (const group of GROUP_ORDER) {
    const items: MenuItem[] = visible
      .filter((a) => a.group === group)
      .map((a) => ({
        id: a.id,
        label: a.label(ctx),
        danger: a.danger ?? false,
        enabled: a.enabled(ctx),
      }));
    if (items.length > 0) sections.push({ group, items });
  }
  return sections;
}

/** Flatten to action ids — convenient for tests + the E2E seam. */
export function menuItemIds(ctx: ContextTarget, catalog?: readonly ContextAction[]): string[] {
  return buildMenuSections(ctx, catalog).flatMap((s) => s.items.map((i) => i.id));
}
