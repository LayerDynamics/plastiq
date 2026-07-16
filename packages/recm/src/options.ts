import { orderGroups } from "./config/options.js";
import type {
  RecmConfig,
  RecmMenuItem,
  RecmMenuSection,
  RecmContext,
  RecmResolvedOption,
  RecmRingLevel,
  RecmTree,
  RecmOption,
  RecmOptionProvider,
} from "./types.js";

function labelFor<TContext, TGroup extends string>(
  option: RecmOption<TContext, TGroup>,
  context: TContext,
): string {
  return typeof option.label === "function" ? option.label(context) : option.label;
}

export function resolveRecmOptions<TContext, TGroup extends string = string>(
  context: TContext,
  providers: readonly RecmOptionProvider<TContext, TGroup>[],
): RecmOption<TContext, TGroup>[] {
  return providers
    .flatMap((provider) => [...provider(context)])
    .filter((option) => option.visible?.(context) ?? true)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
}

export function buildRecmSections<TContext, TGroup extends string = string>(
  context: TContext,
  options: readonly RecmOption<TContext, TGroup>[],
  groupOrder: readonly TGroup[] = [],
): RecmMenuSection<TGroup>[] {
  const groups = new Set<TGroup>();
  for (const option of options) groups.add(option.group);
  const orderedGroups = orderGroups(groups, groupOrder);

  return orderedGroups
    .map((group) => {
      const items: RecmMenuItem[] = options
        .filter((option) => option.group === group)
        .map((option) => ({
          id: option.id,
          label: labelFor(option, context),
          danger: option.danger ?? false,
          enabled: option.enabled?.(context) ?? true,
          icon: option.icon,
        }));
      return { group, items };
    })
    .filter((section) => section.items.length > 0);
}

export function resolveRecmSections<TContext, TGroup extends string = string>(
  context: TContext,
  providers: readonly RecmOptionProvider<TContext, TGroup>[],
  config: Pick<RecmConfig<TGroup>, "groupOrder">,
): RecmMenuSection<TGroup>[] {
  return buildRecmSections(context, resolveRecmOptions(context, providers), config.groupOrder);
}

function childProviders<TContext, TGroup extends string>(
  option: RecmOption<TContext, TGroup>,
): readonly RecmOptionProvider<TContext, TGroup>[] | null {
  if (!option.children) return null;
  if (Array.isArray(option.children)) {
    return [(() => option.children) as RecmOptionProvider<TContext, TGroup>];
  }
  return [option.children as RecmOptionProvider<TContext, TGroup>];
}

function resolveRingOptions<TContext, TGroup extends string>(
  context: TContext,
  options: readonly RecmOption<TContext, TGroup>[],
): RecmResolvedOption<TContext, TGroup>[] {
  return options.map((option) => ({
    id: option.id,
    label: labelFor(option, context),
    danger: option.danger ?? false,
    enabled: option.enabled?.(context) ?? true,
    icon: option.icon,
    group: option.group,
    hasChildren: option.children != null,
    option,
  }));
}

function extendContext<TApp>(
  context: RecmContext<TApp>,
  activePath: readonly string[],
  depth: number,
): RecmContext<TApp> {
  return {
    ...context,
    activePath,
    depth,
  };
}

export function resolveRecmTree<TApp, TGroup extends string = string>(
  context: RecmContext<TApp>,
  providers: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[],
  config: Pick<RecmConfig<TGroup>, "groupOrder" | "maxDepth">,
): RecmTree<RecmContext<TApp>, TGroup> {
  const rings: RecmRingLevel<RecmContext<TApp>, TGroup>[] = [];
  let currentProviders = providers;
  let currentContext = context;
  let activePath = [...context.activePath];

  for (let depth = 0; depth < config.maxDepth; depth += 1) {
    const options = resolveRecmOptions(currentContext, currentProviders);
    if (options.length === 0) break;

    const resolved = resolveRingOptions(currentContext, options);
    const activeId = activePath[depth] ?? resolved[0]!.id;
    rings.push({ depth, options: resolved, activeId });

    const active = options.find((option) => option.id === activeId) ?? options[0]!;
    const nextProviders = childProviders(active);
    if (!nextProviders) break;

    activePath = [...activePath.slice(0, depth), active.id];
    currentContext = extendContext(currentContext, activePath, depth + 1);
    currentProviders = nextProviders as readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[];
  }

  return { rings, activePath };
}

export function treeToSections<TApp, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
): RecmMenuSection<TGroup>[] {
  const level = tree.rings[0];
  if (!level) return [];
  return buildRecmSections(
    { ...({} as RecmContext<TApp>), activePath: tree.activePath, depth: 0 } as RecmContext<TApp>,
    level.options.map((option) => option.option),
    [] as TGroup[],
  );
}

export function recmItemIds<TGroup extends string>(
  sections: readonly RecmMenuSection<TGroup>[],
): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.id));
}

export function optionProviderFromList<TContext, TGroup extends string = string>(
  options: readonly RecmOption<TContext, TGroup>[],
): RecmOptionProvider<TContext, TGroup> {
  return () => options;
}
