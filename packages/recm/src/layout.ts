import type { RecmConfig, RecmLayoutItem, RecmMenuItem, RecmMenuSection } from "./types.js";

export function layoutRecmRing(
  ids: readonly string[],
  ring: number,
  config: Pick<RecmConfig, "innerRadius" | "ringGap">,
): RecmLayoutItem[] {
  if (ids.length === 0) return [];
  const radius = config.innerRadius + ring * config.ringGap;
  const start = -Math.PI / 2;
  const step = (Math.PI * 2) / ids.length;
  return ids.map((id, index) => {
    const angle = start + step * index;
    return {
      id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      angle,
      ring,
    };
  });
}

export function layoutRecmRings<TGroup extends string>(
  sections: readonly RecmMenuSection<TGroup>[],
  activeGroup: TGroup | null,
  config: Pick<RecmConfig, "innerRadius" | "ringGap">,
): { groups: RecmLayoutItem[]; items: RecmLayoutItem[]; activeItems: RecmMenuItem[] } {
  const groups = layoutRecmRing(
    sections.map((section) => section.group),
    0,
    config,
  );
  const active = sections.find((section) => section.group === activeGroup) ?? sections[0];
  const activeItems = active?.items ?? [];
  return {
    groups,
    activeItems,
    items: layoutRecmRing(
      activeItems.map((item) => item.id),
      1,
      config,
    ),
  };
}
