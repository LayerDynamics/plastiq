# Vendored: MuJoCo (DeepMind) WebAssembly

`mujoco.{js,wasm,d.ts}` is the **official, unmodified** single-thread WebAssembly
build of [MuJoCo](https://github.com/google-deepmind/mujoco) published by Google
DeepMind as the npm package
[`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco).

- **Version:** `@mujoco/mujoco@3.9.0`
- **License:** Apache-2.0 (© Google DeepMind) — see [`LICENSE`](./LICENSE).
- **Files:** `mujoco.js` (emscripten ESM loader), `mujoco.wasm` (~9.1 MB raw /
  ~2.3 MB gzip), `mujoco.d.ts` (TypeScript bindings). These are the package's `.`
  (single-thread) export; the `./mt` multithreaded build and the `*.wasm.map`
  sourcemap are intentionally **not** vendored — the backend uses neither.

## Why vendored

The same reason `@plastiq/cad` vendors its OCCT and V-HACD wasm (see
`packages/cad/vendor/*/PROVENANCE.md`): `@plastiq/sim` must keep building and
testing from a **self-contained tree**, immune to an upstream package being
unpublished, retagged, or going offline. The `@mujoco/mujoco` npm package is
**not** a dependency — `src/backends/mujoco.ts` imports these files directly:

```ts
import loadMujoco from "../../vendor/mujoco/mujoco.js";
```

`mujoco.js` resolves its wasm with `new URL('mujoco.wasm', import.meta.url)`, so
the `.js` and `.wasm` must stay co-located here (Node reads the sibling file;
Vite emits it as a hashed asset and rewrites the URL).

## How it was obtained / how to update

```sh
# from a clean checkout with the package temporarily installed:
pnpm --filter @plastiq/sim add @mujoco/mujoco@<version>
cp node_modules/.pnpm/@mujoco+mujoco@<version>/node_modules/@mujoco/mujoco/{mujoco.js,mujoco.wasm,mujoco.d.ts} \
   packages/sim/vendor/mujoco/
pnpm --filter @plastiq/sim remove @mujoco/mujoco   # vendored, not a dependency
```

Then re-run the sim suite (`pnpm exec vitest run packages/sim`) — the
backend/constraint-frame tests fail loud on any API or behavioural drift — plus
`pnpm typecheck` and `pnpm build`.

## Why MuJoCo at all

MuJoCo is a **reduced-coordinate** engine: bodies live in a kinematic tree and
joints _are_ the degrees of freedom. That is exactly why it expresses a world-axis
hinge between differently-oriented bodies — the case rapier-compat's single-axis
`JointData.revolute` cannot (see the `LIMITATION` note in
`src/backends/rapier.ts`). It is a non-default 4th backend alongside
rapier/ammo/cannon; the constraint-frame acceptance suite runs MuJoCo through the
rotated-fixed **and** rotated-hinge gates.
