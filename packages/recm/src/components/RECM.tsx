import { useEffect, useMemo, useState } from "react";
import { createRecmConfig } from "../config.js";
import { RecmMenuView } from "./RecmMenuView.js";
import { RecmLayout } from "./Layout.js";
import { resolveRecmTree } from "../options.js";
import type {
  RecmConfig,
  RecmContext,
  RecmMenuSection,
  RecmOptionProvider,
  RecmResolvedOption,
  RecmRingLevel,
} from "../types.js";

function sectionToOption<TContext, TGroup extends string>(
  group: TGroup,
  itemCount: number,
): RecmResolvedOption<TContext, TGroup> {
  return {
    id: String(group),
    label: String(group),
    danger: false,
    enabled: true,
    group,
    hasChildren: itemCount > 0,
    option: {
      id: String(group),
      group,
      label: String(group),
    } as RecmResolvedOption<TContext, TGroup>["option"],
  };
}

function sectionsToRings<TContext, TGroup extends string>(
  sections: readonly RecmMenuSection<TGroup>[],
  activePath: readonly string[],
): RecmRingLevel<TContext, TGroup>[] {
  const rootActive = activePath[0] ?? sections[0]?.group ?? null;
  const root: RecmRingLevel<TContext, TGroup> = {
    depth: 0,
    activeId: rootActive,
    options: sections.map((section) => ({
      ...sectionToOption<TContext, TGroup>(section.group, section.items.length),
      label: String(section.group),
    })),
  };
  const active = sections.find((section) => String(section.group) === rootActive) ?? sections[0];
  if (!active) return [root];
  const childActive = activePath[1] ?? active.items[0]?.id ?? null;
  const child: RecmRingLevel<TContext, TGroup> = {
    depth: 1,
    activeId: childActive,
    options: active.items.map((item) => ({
      id: item.id,
      label: item.label,
      danger: item.danger,
      enabled: item.enabled,
      group: active.group,
      hasChildren: false,
      icon: item.icon,
      option: {
        id: item.id,
        group: active.group,
        label: item.label,
      } as RecmResolvedOption<TContext, TGroup>["option"],
    })),
  };
  return [root, child];
}

export function RECM<TApp, TGroup extends string = string>({
  open,
  anchor,
  context,
  providers,
  sections,
  onRun,
  onClose,
  config,
  testid = "canvas-context-menu",
  itemTestId,
}: {
  open: boolean;
  anchor: [number, number, number] | null;
  context?: RecmContext<TApp>;
  providers?: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[];
  sections?: readonly RecmMenuSection<TGroup>[];
  onRun: (id: string) => void;
  onClose?: () => void;
  config?: Partial<RecmConfig<TGroup>>;
  testid?: string;
  itemTestId?: (id: string, depth: number) => string;
}): React.JSX.Element | null {
  const resolvedConfig = useMemo(() => createRecmConfig<TGroup>(config), [config]);
  const [activePath, setActivePath] = useState<readonly string[]>([]);

  useEffect(() => {
    setActivePath([]);
  }, [open, context, sections]);

  if (!open || !anchor) return null;

  const tree = context && providers
    ? resolveRecmTree({ ...context, activePath }, providers, resolvedConfig)
    : { rings: sectionsToRings(sections ?? [], activePath), activePath };

  return (
    <RecmLayout anchor={{ kind: "world", point: anchor }}>
      <RecmMenuView
        rings={tree.rings}
        activePath={tree.activePath}
        onPathChange={setActivePath}
        onRun={onRun}
        onClose={onClose}
        config={resolvedConfig}
        testid={testid}
        {...(itemTestId ? { itemTestId } : {})}
      />
    </RecmLayout>
  );
}
