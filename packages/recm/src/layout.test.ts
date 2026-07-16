import { describe, expect, it } from "vitest";
import { createRecmConfig } from "./config.js";
import { layoutRecmRing, layoutRecmRings } from "./layout.js";
import type { RecmMenuSection } from "./types.js";

describe("recm layout", () => {
  it("places ring items at a stable radius", () => {
    const config = createRecmConfig({ innerRadius: 50, ringGap: 70 });
    const items = layoutRecmRing(["a", "b", "c", "d"], 1, config);
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(Math.round(Math.hypot(item.x, item.y))).toBe(120);
    }
  });

  it("lays out groups and the active group's items", () => {
    const sections: RecmMenuSection<"create" | "modify">[] = [
      { group: "create", items: [{ id: "box", label: "Box", danger: false, enabled: true }] },
      {
        group: "modify",
        items: [{ id: "delete", label: "Delete", danger: true, enabled: true }],
      },
    ];
    const layout = layoutRecmRings(sections, "modify", createRecmConfig());
    expect(layout.groups.map((item) => item.id)).toEqual(["create", "modify"]);
    expect(layout.activeItems.map((item) => item.id)).toEqual(["delete"]);
    expect(layout.items.map((item) => item.id)).toEqual(["delete"]);
  });
});
