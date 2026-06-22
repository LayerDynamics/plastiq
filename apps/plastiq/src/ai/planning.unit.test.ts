// M5 — decomposition-graph planning IR (Graph-CAD idea; our own schema). validatePlan enforces
// schema + referential integrity (parent/relation refs exist) + acyclic hierarchy. See docs/adr/0005.

import { describe, expect, it } from "vitest";

import { validatePlan } from "./planning.js";

describe("validatePlan", () => {
  it("accepts a well-formed decomposition graph", () => {
    const r = validatePlan({
      nodes: [
        { id: "body", part: "the main housing" },
        { id: "lid", part: "the top lid", parent: "body" },
        { id: "hole", part: "a mounting hole", parent: "body" },
      ],
      relations: [{ from: "lid", to: "body", kind: "attached" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.nodes).toHaveLength(3);
      expect(r.plan.relations).toHaveLength(1);
    }
  });

  it("defaults relations to an empty array", () => {
    const r = validatePlan({ nodes: [{ id: "a", part: "a" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.relations).toEqual([]);
  });

  it("rejects an empty node list", () => {
    const r = validatePlan({ nodes: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects a dangling parent reference", () => {
    const r = validatePlan({ nodes: [{ id: "a", part: "a", parent: "ghost" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ghost|parent/i);
  });

  it("rejects a relation that references an unknown node", () => {
    const r = validatePlan({
      nodes: [{ id: "a", part: "a" }],
      relations: [{ from: "a", to: "missing", kind: "aligned" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing|relation/i);
  });

  it("rejects a cycle in the parent hierarchy", () => {
    const r = validatePlan({
      nodes: [
        { id: "a", part: "a", parent: "b" },
        { id: "b", part: "b", parent: "a" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cycle/i);
  });

  it("rejects duplicate node ids", () => {
    const r = validatePlan({
      nodes: [
        { id: "a", part: "first" },
        { id: "a", part: "second" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate|id/i);
  });

  it("rejects an unknown relation kind", () => {
    const r = validatePlan({
      nodes: [{ id: "a", part: "a" }, { id: "b", part: "b" }],
      relations: [{ from: "a", to: "b", kind: "teleports" }],
    });
    expect(r.ok).toBe(false);
  });
});
