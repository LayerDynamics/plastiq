import {
  createRecmConfig,
  createRecmManager,
  type RecmAnchor,
  type RecmConfig,
  type RecmContext,
  type RecmManager,
  type RecmOptionProvider,
  type RecmRenderedMenu,
  type RecmRenderedObject,
} from "@plastiq/recm";
import { CONTEXT_ACTIONS, runContextAction, type ActionGroup, type ContextAction } from "./config.js";
import type { ContextTarget } from "./contextSelection.js";

export interface PlastiqRecmAppContext {
  target: ContextTarget;
  source: "canvas" | "sketch";
}

interface ViewportGlobal {
  builtPart?: unknown;
  meshBodyCount?: number;
  instanceGroups?: Array<{ userData?: { instanceId?: string } }>;
  gizmos?: Record<string, boolean>;
}

function viewportGlobal(): ViewportGlobal {
  return ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {});
}

function humanizeGroup(group: ActionGroup): string {
  return group.charAt(0).toUpperCase() + group.slice(1);
}

/** Root-ring category order, shared by both context-menu components + the RECM
 *  config below (single source of truth). */
export const ACTION_GROUP_ORDER: ActionGroup[] = [
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

function actionVisible(action: ContextAction, ctx: RecmContext<PlastiqRecmAppContext>): boolean {
  return action.visible(ctx.app!.target);
}

function actionEnabled(action: ContextAction, ctx: RecmContext<PlastiqRecmAppContext>): boolean {
  return action.enabled(ctx.app!.target);
}

export function buildPlastiqRenderedObjects(): RecmRenderedObject[] {
  const vp = viewportGlobal();
  const out: RecmRenderedObject[] = [];
  if (vp.builtPart) out.push({ id: "built-part", kind: "part", label: "Built part" });
  if ((vp.meshBodyCount ?? 0) > 0) {
    out.push({ id: "mesh-bodies", kind: "mesh-document", label: `${vp.meshBodyCount} mesh bodies` });
  }
  for (const group of vp.instanceGroups ?? []) {
    const id = group.userData?.instanceId;
    if (id) out.push({ id: `instance:${id}`, kind: "assembly-instance", label: id });
  }
  return out;
}

export function buildPlastiqRenderedMenus(
  open: boolean,
  depth: number,
  label = "context-menu",
): RecmRenderedMenu[] {
  return open ? [{ id: label, kind: "ring", depth }] : [];
}

export function buildPlastiqRecmContext(input: {
  target: ContextTarget;
  source: "canvas" | "sketch";
  origin: RecmAnchor;
  openMenus?: boolean;
  menuDepth?: number;
}): RecmContext<PlastiqRecmAppContext> {
  return {
    origin: input.origin,
    selection: input.target.picks.map((pick) => ({
      id: `${pick.kind}:${pick.id}`,
      kind: pick.kind,
      value: pick,
    })),
    renderedObjects: buildPlastiqRenderedObjects(),
    renderedMenus: buildPlastiqRenderedMenus(input.openMenus ?? false, input.menuDepth ?? 0),
    activePath: [],
    depth: 0,
    app: { target: input.target, source: input.source },
  };
}

function uniqueGroups(ctx: RecmContext<PlastiqRecmAppContext>): ActionGroup[] {
  const groups = new Set<ActionGroup>();
  for (const action of CONTEXT_ACTIONS) {
    if (actionVisible(action, ctx)) groups.add(action.group);
  }
  return ACTION_GROUP_ORDER.filter((group) => groups.has(group));
}

function actionsForGroup(group: ActionGroup, ctx: RecmContext<PlastiqRecmAppContext>): ContextAction[] {
  return CONTEXT_ACTIONS.filter((action) => action.group === group && actionVisible(action, ctx));
}

export function buildPlastiqRecmProviders(): readonly RecmOptionProvider<
  RecmContext<PlastiqRecmAppContext>,
  ActionGroup
>[] {
  return [
    (ctx) =>
      uniqueGroups(ctx).map((group) => ({
        id: group,
        group,
        label: `${humanizeGroup(group)} (${actionsForGroup(group, ctx).length})`,
        enabled: () => true,
        visible: () => true,
        children: (childCtx) =>
          actionsForGroup(group, childCtx).map((action) => ({
            id: action.id,
            group,
            label: action.label(childCtx.app!.target),
            danger: action.danger ?? false,
            visible: () => true,
            enabled: () => actionEnabled(action, childCtx),
            run: () => action.run(childCtx.app!.target),
          })),
      })),
  ];
}

/** The single RECM config the canvas + sketch menus share (category order + depth
 *  cap). One source of truth instead of a group-order array per component. */
export const plastiqRecmConfig: RecmConfig<ActionGroup> = createRecmConfig<ActionGroup>({
  groupOrder: ACTION_GROUP_ORDER,
  maxDepth: 3,
});

/** The framework-agnostic RECM manager bound to Plastiq's action catalog. Both
 *  menu components drive it (buildContext → modifier pipeline, expand → rings,
 *  run → dispatch); `runOption` routes every terminal run through the same
 *  `runContextAction` the store/sketcher already use, so there is one dispatch
 *  path for the whole app. Providers read the live catalog + target at call time,
 *  so a single shared instance stays correct across selections. */
export const plastiqRecmManager: RecmManager<PlastiqRecmAppContext, ActionGroup> =
  createRecmManager<PlastiqRecmAppContext, ActionGroup>({
    config: plastiqRecmConfig,
    providers: buildPlastiqRecmProviders(),
    runOption: (id, ctx) => runContextAction(id, ctx.app!.target),
  });

/** A compact, serializable view of the context that reached the menu + the menu
 *  it produced. What lands on `globalThis.__plastiqRecmContext`. */
export interface RecmMenuSeam {
  source: "canvas" | "sketch";
  targetKind: ContextTarget["kind"];
  /** The live 3D selection carried into the RecmContext (from target.picks). */
  selection: { id: string; kind: string }[];
  /** The live scene inventory carried into the RecmContext. */
  renderedObjects: { id: string; kind: string }[];
  /** The open menus/rings carried into the RecmContext. */
  renderedMenus: { id: string; depth: number }[];
  /** The root-ring categories the context resolved to. */
  categories: ActionGroup[];
  /** The auto-expanded first category's child action ids. */
  activeChildren: string[];
}

/**
 * Verification / E2E seam: publish a compact view of the RecmContext that reached
 * the menu (selection + rendered scene) AND the rings it resolved to, so a test
 * can prove the live context actually drives the menu. Mirrors the existing
 * `__plastiqContextMenu` seam. Pass `null` to clear it (menu closed).
 */
export function publishRecmMenuSeam(context: RecmContext<PlastiqRecmAppContext> | null): void {
  const holder = globalThis as { __plastiqRecmContext?: RecmMenuSeam | null };
  if (!context) {
    holder.__plastiqRecmContext = null;
    return;
  }
  const { tree } = plastiqRecmManager.expand(context, context.activePath);
  holder.__plastiqRecmContext = {
    source: context.app!.source,
    targetKind: context.app!.target.kind,
    selection: context.selection.map((s) => ({ id: s.id, kind: s.kind })),
    renderedObjects: context.renderedObjects.map((o) => ({ id: o.id, kind: o.kind })),
    renderedMenus: context.renderedMenus.map((m) => ({ id: m.id, depth: m.depth })),
    categories: (tree.rings[0]?.options.map((o) => o.id) ?? []) as ActionGroup[],
    activeChildren: tree.rings[1]?.options.map((o) => o.id) ?? [],
  };
}
