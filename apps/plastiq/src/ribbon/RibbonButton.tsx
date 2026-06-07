// One ribbon action button: resolves its registry def, renders icon + label, greys
// via `enabled`, highlights via `active`, and runs the action on click. The label is
// in its own element so the E2E suite's getByText(exact) matches it. data-testid is
// the carried-forward toolbar id where one exists, else `ribbon-<id>`.

import { ACTIONS, runAction } from "../actions/registry.js";
import { RIBBON_ICONS, RIBBON_LABELS, RIBBON_TESTIDS } from "./ribbonConfig.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";

export function RibbonButton({
  id,
  ctx,
}: {
  id: string;
  ctx: ContextTarget;
}): React.JSX.Element | null {
  const def = ACTIONS[id];
  if (!def) return null;
  const enabled = def.enabled(ctx);
  const active = def.active?.(ctx) ?? false;
  const label = RIBBON_LABELS[id] ?? def.label(ctx);
  const icon = def.icon ?? RIBBON_ICONS[id];
  const testid = RIBBON_TESTIDS[id] ?? `ribbon-${id}`;
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={!enabled}
      onClick={() => runAction(id, ctx)}
      title={label}
      className={`flex min-w-[3.25rem] flex-col items-center gap-0.5 rounded px-2 py-1 text-[11px] transition-colors ${
        active ? "bg-[#ffa23a] text-black" : "text-[#cfe] enabled:hover:bg-[#1b2230]"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {icon ? (
        <span aria-hidden className="text-sm leading-none">
          {icon}
        </span>
      ) : null}
      <span className="leading-none">{label}</span>
    </button>
  );
}
