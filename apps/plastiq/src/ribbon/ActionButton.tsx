// One action button, resolved from the shared registry. Two variants:
//  • "row"  — full-width icon + label, for the left sidebar tool groups.
//  • "chip" — compact text button, for the slim top strip (selection mode, etc.).
// Greys via `enabled`, highlights via `active`, carries the toolbar data-testid.

import { ACTIONS, runAction } from "../actions/registry.js";
import { RIBBON_ICONS, RIBBON_LABELS, RIBBON_TESTIDS } from "./ribbonConfig.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";

export function ActionButton({
  id,
  ctx,
  variant = "row",
}: {
  id: string;
  ctx: ContextTarget;
  variant?: "row" | "chip";
}): React.JSX.Element | null {
  const def = ACTIONS[id];
  if (!def) {
    // An unknown id is a wiring bug (a ribbon/workspace config naming an action
    // the registry doesn't define) — surface it in dev builds instead of the
    // button silently vanishing. Production still just renders nothing.
    if (import.meta.env.DEV) console.warn(`[ribbon] unknown action id: "${id}"`);
    return null;
  }
  const enabled = def.enabled(ctx);
  const active = def.active?.(ctx) ?? false;
  const label = RIBBON_LABELS[id] ?? def.label(ctx);
  const icon = def.icon ?? RIBBON_ICONS[id];
  const testid = RIBBON_TESTIDS[id] ?? `act-${id}`;
  const common =
    "rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  if (variant === "chip") {
    return (
      <button
        type="button"
        data-testid={testid}
        disabled={!enabled}
        onClick={() => runAction(id, ctx)}
        title={label}
        className={`${common} px-2 py-1 text-xs ${
          active ? "bg-[#ffa23a] text-black" : "text-[#9ab] enabled:hover:bg-[#1b2230]"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid={testid}
      disabled={!enabled}
      onClick={() => runAction(id, ctx)}
      title={label}
      className={`${common} flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
        active ? "bg-[#ffa23a] text-black" : "text-[#cfe] enabled:hover:bg-[#1b2230]"
      }`}
    >
      <span aria-hidden className="w-4 shrink-0 text-center text-sm leading-none">
        {icon ?? "•"}
      </span>
      <span className="leading-none">{label}</span>
    </button>
  );
}
