import type { RecmConfig, RecmTheme } from "./types.js";

export const defaultRecmTheme: RecmTheme = {
  panelBackground: "#0e1219",
  panelBorder: "#2a3444",
  groupBackground: "#151b25",
  groupBackgroundActive: "#223044",
  itemBackground: "#101722",
  itemBackgroundHover: "#1f2a3a",
  text: "#cfe",
  dangerText: "#ff8a8a",
  disabledOpacity: 0.42,
  shadow: "0 10px 28px rgb(0 0 0 / 0.42)",
};

export const DEFAULT_GROUP_ORDER = [
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
] as const;

export function createRecmConfig<TGroup extends string = string>(
  overrides: Partial<RecmConfig<TGroup>> = {},
): RecmConfig<TGroup> {
  return {
    maxDepth: overrides.maxDepth ?? 3,
    groupOrder: overrides.groupOrder ?? ([] as TGroup[]),
    innerRadius: overrides.innerRadius ?? 20,
    ringGap: overrides.ringGap ?? 16,
    ringThickness: overrides.ringThickness ?? 40,
    itemWidth: overrides.itemWidth ?? 112,
    itemHeight: overrides.itemHeight ?? 34,
    centerSize: overrides.centerSize ?? 44,
    testIdPrefix: overrides.testIdPrefix ?? "recm",
    theme: { ...defaultRecmTheme, ...overrides.theme },
  };
}
