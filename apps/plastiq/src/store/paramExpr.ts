// R6 (§12.R6) — the pure, dependency-free arithmetic expression evaluator that
// makes global parameters (`doc.params`) live. A feature param's expression in
// `EditorFeature.exprs` and a global param whose value is authored as an expression
// over OTHER params both resolve through here. It is a REAL recursive-descent parser +
// tree-walking evaluator — no `eval`, no `Function`, no regex "calculator" — so it
// runs identically in the worker (rebuild entry, §12.R6) and the main thread
// (the Parameters panel) with no globals to leak into.
//
// Grammar (standard precedence, left-associative):
//   expr    := term   (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := ('-' | '+') factor | primary
//   primary := number | ident | ident '(' args? ')' | '(' expr ')'
//   args    := expr (',' expr)*
//
// Identifiers resolve from the supplied `params` table; the reserved constant
// `pi` and the math functions below are recognised instead of looked up.

/** The math functions an expression may call. Kept small and side-effect-free. */
const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sin: (a) => Math.sin(a[0]!),
  cos: (a) => Math.cos(a[0]!),
  tan: (a) => Math.tan(a[0]!),
  sqrt: (a) => Math.sqrt(a[0]!),
  abs: (a) => Math.abs(a[0]!),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
};

/** Allowed argument-count range per function ([min, max]; Infinity = variadic). */
const ARITY: Record<string, [number, number]> = {
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  sqrt: [1, 1],
  abs: [1, 1],
  min: [1, Infinity],
  max: [1, Infinity],
};

/** Built-in constants resolved before the `params` table (not a dependency). */
const CONSTANTS: Record<string, number> = { pi: Math.PI };

/**
 * Names an expression can use that are NOT parameter references — the math
 * functions and constants. A parameter must not shadow one of these, so the
 * Parameters panel imports this set for name validation (single source of truth).
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(FUNCTIONS),
  ...Object.keys(CONSTANTS),
]);

const PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a proposed global-parameter name is invalid, or null when valid. */
export function parameterNameError(
  name: string,
  existing: readonly string[] = [],
  self?: string,
): string | null {
  if (name.length === 0) return "name required";
  if (!PARAMETER_NAME_RE.test(name)) {
    return "letters, digits, _ (not starting with a digit)";
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" is a reserved function/constant`;
  if (name !== self && existing.includes(name)) {
    return "a parameter with that name already exists";
  }
  return null;
}

// --- AST -------------------------------------------------------------------

type Node =
  | { k: "num"; value: number }
  | { k: "var"; name: string }
  | { k: "neg"; operand: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { k: "call"; name: string; args: Node[] };

interface Tok {
  t: "num" | "id" | "op";
  v: string;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

/** Lexer: number / identifier / single-char operator tokens; whitespace skipped. */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Number: digits, optional fraction, optional exponent (1, 1.5, .5, 2e3, 1.5e-3).
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && isDigit(src[j]!)) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && isDigit(src[j]!)) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (isDigit(src[k] ?? "")) {
          k++;
          while (k < src.length && isDigit(src[k]!)) k++;
          j = k;
        }
      }
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdPart(src[j]!)) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" in expression`);
  }
  return toks;
}

/** Parse a source string into an AST, rejecting trailing/garbled tokens. */
function parse(src: string): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok | undefined => toks[pos++];
  const expect = (v: string): void => {
    const t = next();
    if (!t || t.v !== v) throw new Error(`Expected "${v}" in expression`);
  };

  function parseExpr(): Node {
    let left = parseTerm();
    let t = peek();
    while (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
      next();
      const right = parseTerm();
      left = { k: "bin", op: t.v as "+" | "-", left, right };
      t = peek();
    }
    return left;
  }
  function parseTerm(): Node {
    let left = parseFactor();
    let t = peek();
    while (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
      next();
      const right = parseFactor();
      left = { k: "bin", op: t.v as "*" | "/", left, right };
      t = peek();
    }
    return left;
  }
  function parseFactor(): Node {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      next();
      const operand = parseFactor();
      return t.v === "-" ? { k: "neg", operand } : operand;
    }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = next();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.t === "num") {
      const value = Number(t.v);
      if (!Number.isFinite(value)) throw new Error(`Invalid number "${t.v}" in expression`);
      return { k: "num", value };
    }
    if (t.t === "id") {
      const nxt = peek();
      if (nxt && nxt.t === "op" && nxt.v === "(") {
        next(); // consume "("
        const args: Node[] = [];
        if (!(peek()?.t === "op" && peek()?.v === ")")) {
          args.push(parseExpr());
          while (peek()?.t === "op" && peek()?.v === ",") {
            next();
            args.push(parseExpr());
          }
        }
        expect(")");
        return { k: "call", name: t.v, args };
      }
      return { k: "var", name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = parseExpr();
      expect(")");
      return e;
    }
    throw new Error(`Unexpected token "${t.v}" in expression`);
  }

  const node = parseExpr();
  const leftover = peek();
  if (leftover) throw new Error(`Unexpected token "${leftover.v}" in expression`);
  return node;
}

/** Evaluate a parsed AST against a numeric parameter table. */
function evalNode(n: Node, params: Record<string, number>): number {
  switch (n.k) {
    case "num":
      return n.value;
    case "var": {
      if (n.name in CONSTANTS) return CONSTANTS[n.name]!;
      const v = params[n.name];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`Unknown parameter "${n.name}"`);
      }
      return v;
    }
    case "neg":
      return -evalNode(n.operand, params);
    case "bin": {
      const a = evalNode(n.left, params);
      const b = evalNode(n.right, params);
      if (n.op === "+") return a + b;
      if (n.op === "-") return a - b;
      if (n.op === "*") return a * b;
      return a / b;
    }
    case "call": {
      const fn = FUNCTIONS[n.name];
      if (!fn) throw new Error(`Unknown function "${n.name}"`);
      const [lo, hi] = ARITY[n.name]!;
      if (n.args.length < lo || n.args.length > hi) {
        const want = hi === Infinity ? `at least ${lo}` : lo === hi ? `${lo}` : `${lo}–${hi}`;
        throw new Error(`${n.name}() takes ${want} argument(s), got ${n.args.length}`);
      }
      return fn(n.args.map((a) => evalNode(a, params)));
    }
  }
}

/** Collect the parameter identifiers a node references (excludes constants/funcs). */
function collectVars(n: Node, out: string[]): void {
  switch (n.k) {
    case "var":
      if (!(n.name in CONSTANTS) && !out.includes(n.name)) out.push(n.name);
      return;
    case "neg":
      collectVars(n.operand, out);
      return;
    case "bin":
      collectVars(n.left, out);
      collectVars(n.right, out);
      return;
    case "call":
      for (const a of n.args) collectVars(a, out);
      return;
    case "num":
      return;
  }
}

// --- public API ------------------------------------------------------------

/**
 * Evaluate `expr` against `params`. Identifiers resolve from `params` (missing →
 * a thrown `Unknown parameter` error); `pi` and the math functions are built in.
 * Pure — no globals, no `eval`.
 */
export function evalExpr(expr: string, params: Record<string, number> = {}): number {
  return evalNode(parse(expr), params);
}

/** The parameter identifiers `expr` references, in first-seen order (no dupes). */
export function dependencies(expr: string): string[] {
  const out: string[] = [];
  collectVars(parse(expr), out);
  return out;
}

/**
 * Rename one parameter reference while preserving the expression's formatting.
 *
 * The expression grammar has no strings or property access, so identifier-token
 * replacement is exact: `w` changes in `w * 2`, but not in `wall` or `sqrt`.
 * Parsing before and after makes this safe for persisted/untrusted expressions
 * and guarantees the result remains accepted by the evaluator.
 */
export function renameDependency(expr: string, from: string, to: string): string {
  parse(expr);
  if (from === to) return expr;
  const renamed = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (identifier) =>
    identifier === from ? to : identifier,
  );
  parse(renamed);
  return renamed;
}

/**
 * Resolve a raw parameter table whose values may be numbers OR expression strings
 * over OTHER params, in dependency (topological) order — so references are
 * rename-safe (evaluated by name, independent of table insertion order). Cyclic
 * references are DETECTED via DFS and rejected with a path in the message. A
 * reference to a name that is neither another param nor a built-in throws
 * `Unknown parameter`.
 */
export function resolveParams(raw: Record<string, string | number>): Record<string, number> {
  const resolved: Record<string, number> = {};
  const done = new Set<string>();
  const onStack = new Set<string>();

  const resolveOne = (name: string, stack: string[]): number => {
    if (done.has(name)) return resolved[name]!;
    if (onStack.has(name)) {
      throw new Error(`Cyclic parameter reference: ${[...stack, name].join(" → ")}`);
    }
    if (!(name in raw)) throw new Error(`Unknown parameter "${name}"`);
    onStack.add(name);
    const rawVal = raw[name]!;
    let value: number;
    if (typeof rawVal === "number") {
      value = rawVal;
    } else {
      // Resolve every dependency that is itself a param first; anything left
      // (an unknown identifier) surfaces at eval time as `Unknown parameter`.
      const scope: Record<string, number> = {};
      for (const dep of dependencies(rawVal)) {
        if (dep in raw) scope[dep] = resolveOne(dep, [...stack, name]);
      }
      value = evalExpr(rawVal, scope);
    }
    onStack.delete(name);
    done.add(name);
    resolved[name] = value;
    return value;
  };

  for (const name of Object.keys(raw)) resolveOne(name, []);
  return resolved;
}
