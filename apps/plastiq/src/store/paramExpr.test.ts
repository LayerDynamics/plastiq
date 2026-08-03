// R6 (§12.R6) — the pure parameter-expression evaluator. Proves arithmetic
// correctness, identifier resolution, the math functions, cyclic-reference
// rejection, and rename-safe topological resolution of a param table.

import { describe, expect, it } from "vitest";
import {
  dependencies,
  evalExpr,
  parameterNameError,
  renameDependency,
  resolveParams,
  RESERVED_NAMES,
} from "./paramExpr.js";

describe("evalExpr — arithmetic", () => {
  it("adds, subtracts, multiplies, divides with correct precedence", () => {
    expect(evalExpr("1 + 2 * 3")).toBe(7);
    expect(evalExpr("(1 + 2) * 3")).toBe(9);
    expect(evalExpr("10 - 4 - 3")).toBe(3); // left-associative
    expect(evalExpr("12 / 4 / 3")).toBe(1); // left-associative
    expect(evalExpr("2 + 3 * 4 - 6 / 2")).toBe(11);
  });

  it("handles unary minus and plus, including nested", () => {
    expect(evalExpr("-5")).toBe(-5);
    expect(evalExpr("-(2 + 3)")).toBe(-5);
    expect(evalExpr("3 * -2")).toBe(-6);
    expect(evalExpr("--4")).toBe(4);
    expect(evalExpr("+7")).toBe(7);
  });

  it("parses decimal, leading-dot, and exponent literals", () => {
    expect(evalExpr("1.5 + 0.25")).toBe(1.75);
    expect(evalExpr(".5 * 4")).toBe(2);
    expect(evalExpr("2e3")).toBe(2000);
    expect(evalExpr("1.5e-3")).toBeCloseTo(0.0015, 10);
  });

  it("ignores whitespace", () => {
    expect(evalExpr("  1   +\t2  ")).toBe(3);
  });
});

describe("evalExpr — identifiers", () => {
  it("resolves identifiers from the params table", () => {
    expect(evalExpr("wall * 2", { wall: 3 })).toBe(6);
    expect(evalExpr("a + b + c", { a: 1, b: 2, c: 3 })).toBe(6);
  });

  it("treats a value of 0 as a valid resolution (not missing)", () => {
    expect(evalExpr("x + 1", { x: 0 })).toBe(1);
  });

  it("throws a clear error for an unknown identifier", () => {
    expect(() => evalExpr("wall * 2", {})).toThrow(/Unknown parameter "wall"/);
  });
});

describe("evalExpr — functions and constants", () => {
  it("evaluates the built-in math functions", () => {
    expect(evalExpr("sqrt(9)")).toBe(3);
    expect(evalExpr("abs(-4)")).toBe(4);
    expect(evalExpr("min(3, 7, 2)")).toBe(2);
    expect(evalExpr("max(3, 7, 2)")).toBe(7);
    expect(evalExpr("sin(0)")).toBe(0);
    expect(evalExpr("cos(0)")).toBe(1);
    expect(evalExpr("tan(0)")).toBe(0);
  });

  it("exposes pi as a constant, not a required param", () => {
    expect(evalExpr("pi")).toBeCloseTo(Math.PI, 12);
    expect(evalExpr("2 * pi * r", { r: 5 })).toBeCloseTo(2 * Math.PI * 5, 10);
  });

  it("composes functions with arithmetic", () => {
    expect(evalExpr("sqrt(a*a + b*b)", { a: 3, b: 4 })).toBe(5);
  });

  it("rejects an unknown function", () => {
    expect(() => evalExpr("floor(1.5)")).toThrow(/Unknown function "floor"/);
  });

  it("rejects wrong argument counts", () => {
    expect(() => evalExpr("sqrt(1, 2)")).toThrow(/sqrt\(\) takes 1 argument/);
    expect(() => evalExpr("min()")).toThrow(/min\(\) takes at least 1/);
  });
});

describe("evalExpr — parse errors", () => {
  it("rejects trailing garbage, unbalanced parens, and stray characters", () => {
    expect(() => evalExpr("1 + 2 3")).toThrow(/Unexpected token/);
    expect(() => evalExpr("(1 + 2")).toThrow(/Expected "\)"/);
    expect(() => evalExpr("1 & 2")).toThrow(/Unexpected character "&"/);
    expect(() => evalExpr("")).toThrow();
  });

  it("never uses eval/Function (pure parser) — a JS expression is not silently run", () => {
    // `**` is valid JS but NOT in this grammar → it must be rejected, proving we
    // do not defer to the JS engine.
    expect(() => evalExpr("2 ** 3")).toThrow();
  });
});

describe("dependencies", () => {
  it("returns referenced params in first-seen order without duplicates", () => {
    expect(dependencies("a + b * a - c")).toEqual(["a", "b", "c"]);
  });

  it("excludes constants and function names", () => {
    expect(dependencies("sqrt(r) * pi + h")).toEqual(["r", "h"]);
  });

  it("returns an empty list for a constant expression", () => {
    expect(dependencies("1 + 2 * 3")).toEqual([]);
  });
});

describe("renameDependency", () => {
  it("renames only the exact identifier and preserves formatting", () => {
    expect(renameDependency("wall * 2 + firewall + sqrt(wall)", "wall", "thickness")).toBe(
      "thickness * 2 + firewall + sqrt(thickness)",
    );
  });

  it("leaves the expression byte-for-byte unchanged when the dependency is absent", () => {
    const expression = "width  *  2 + pi";
    expect(renameDependency(expression, "height", "depth")).toBe(expression);
  });

  it("rejects malformed source instead of rewriting untrusted text", () => {
    expect(() => renameDependency("wall + )", "wall", "thickness")).toThrow();
  });
});

describe("parameterNameError", () => {
  it("accepts identifiers and rejects reserved, malformed, and duplicate names", () => {
    expect(parameterNameError("wall", [])).toBeNull();
    expect(parameterNameError("wall_2", [])).toBeNull();
    expect(parameterNameError("2wall", [])).toMatch(/not starting/);
    expect(parameterNameError("sqrt", [])).toMatch(/reserved/);
    expect(parameterNameError("wall", ["wall"])).toMatch(/already exists/);
    expect(parameterNameError("wall", ["wall"], "wall")).toBeNull();
  });
});

describe("resolveParams — topological resolution", () => {
  it("resolves numeric params unchanged", () => {
    expect(resolveParams({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("resolves expression params over other params regardless of key order", () => {
    // `total` is declared BEFORE its dependencies — resolution is by dependency
    // order, not insertion order (rename-safe / order-independent).
    const out = resolveParams({ total: "w + 2 * gap", gap: "2", w: "10" });
    expect(out).toEqual({ total: 14, gap: 2, w: 10 });
  });

  it("resolves a deep chain (a → b → c)", () => {
    const out = resolveParams({ a: "b + 1", b: "c * 2", c: "3" });
    expect(out).toEqual({ a: 7, b: 6, c: 3 });
  });

  it("is rename-safe: references bind by current name", () => {
    // Rename `w`→`width` and update the reference — resolution still works with
    // no dependence on declaration order.
    const out = resolveParams({ area: "width * height", height: "4", width: "5" });
    expect(out.area).toBe(20);
  });

  it("mixes numbers, expressions, functions, and pi", () => {
    const out = resolveParams({ r: 2, circ: "2 * pi * r", d: "r * 2" });
    expect(out.d).toBe(4);
    expect(out.circ).toBeCloseTo(2 * Math.PI * 2, 10);
  });
});

describe("resolveParams — cycle detection", () => {
  it("rejects a direct self-reference", () => {
    expect(() => resolveParams({ a: "a + 1" })).toThrow(/Cyclic parameter reference/);
  });

  it("rejects a two-node cycle", () => {
    expect(() => resolveParams({ a: "b", b: "a" })).toThrow(/Cyclic parameter reference/);
  });

  it("rejects a longer cycle and names the path", () => {
    expect(() => resolveParams({ a: "b + 1", b: "c + 1", c: "a + 1" })).toThrow(
      /Cyclic parameter reference: a → b → c → a/,
    );
  });

  it("rejects a reference to an entirely unknown param", () => {
    expect(() => resolveParams({ a: "nope + 1" })).toThrow(/Unknown parameter "nope"/);
  });
});

describe("RESERVED_NAMES", () => {
  it("covers the math functions and pi so params cannot shadow them", () => {
    for (const name of ["sin", "cos", "tan", "sqrt", "abs", "min", "max", "pi"]) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
    }
    expect(RESERVED_NAMES.has("wall")).toBe(false);
  });
});
