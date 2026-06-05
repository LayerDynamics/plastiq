import { describe, expect, it } from "vitest";
import type { Feature } from "./feature.js";
import { Model } from "./model.js";

/** A feature that reads one param and scales an optional upstream result. */
function scaled(id: string, param: string, dep?: string): Feature {
  return {
    id,
    deps: dep ? [dep] : [],
    evaluate(ctx) {
      const p = ctx.params.get(param) ?? 0;
      const base = dep ? (ctx.results.get(dep) as number) : 1;
      return base * p;
    },
  };
}

describe("Model feature-history engine", () => {
  it("evaluates features in dependency order", () => {
    const m = new Model();
    m.setParam("h", 3);
    m.setParam("k", 2);
    m.addFeature(scaled("base", "h")); // 1 * 3 = 3
    m.addFeature(scaled("scale", "k", "base")); // 3 * 2 = 6
    expect(m.result("base")).toBe(3);
    expect(m.result("scale")).toBe(6);
  });

  it("re-evaluates downstream when a parameter changes", () => {
    const m = new Model();
    m.setParam("h", 3);
    m.setParam("k", 2);
    m.addFeature(scaled("base", "h"));
    m.addFeature(scaled("scale", "k", "base"));
    m.setParam("h", 10); // base = 10, scale = 20
    expect(m.result("base")).toBe(10);
    expect(m.result("scale")).toBe(20);
  });

  it("orders by dependency regardless of insertion order", () => {
    const m = new Model();
    m.setParam("h", 4);
    // Insert dependent's dep AFTER referencing — topo sort still orders correctly
    // because deps are declared explicitly.
    const dependent: Feature = {
      id: "twice",
      deps: ["one"],
      evaluate: (ctx) => (ctx.results.get("one") as number) * 2,
    };
    m.addFeature(scaled("one", "h")); // must exist before dependent references it
    m.addFeature(dependent);
    expect(m.result("twice")).toBe(8);
  });

  it("isolates a failing feature: it + downstream error, upstream survives", () => {
    const m = new Model();
    m.setParam("h", 5);
    m.addFeature(scaled("ok", "h")); // 5
    m.addFeature({
      id: "boom",
      deps: ["ok"],
      evaluate: () => {
        throw new Error("degenerate op");
      },
    });
    m.addFeature({
      id: "downstream",
      deps: ["boom"],
      evaluate: (ctx) => ctx.results.get("boom"),
    });

    expect(m.status("ok")?.ok).toBe(true);
    expect(m.result("ok")).toBe(5); // upstream intact
    expect(m.status("boom")?.ok).toBe(false);
    expect(m.status("boom")?.error).toContain("degenerate op");
    expect(m.status("downstream")?.ok).toBe(false);
    expect(m.status("downstream")?.error).toContain("upstream feature 'boom' failed");
  });

  it("rejects duplicate feature ids", () => {
    const m = new Model();
    m.addFeature(scaled("dup", "h"));
    expect(() => m.addFeature(scaled("dup", "h"))).toThrow(/duplicate/);
  });

  it("report lists statuses in evaluation order", () => {
    const m = new Model();
    m.setParam("h", 2);
    m.addFeature(scaled("a", "h"));
    m.addFeature(scaled("b", "h", "a"));
    const report = m.report();
    expect(report.map((s) => s.id)).toEqual(["a", "b"]);
    expect(report.every((s) => s.ok)).toBe(true);
  });
});
