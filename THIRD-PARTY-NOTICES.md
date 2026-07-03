# Third-Party Notices

This repository's **first-party code** is licensed under the PolyForm
Noncommercial License 1.0.0 (see the root [`LICENSE`](./LICENSE)). That
license applies **only** to first-party code. The third-party components
listed below are shipped with, vendored into, or redistributed by this
project and **remain under their own licenses**, which govern them
regardless of the first-party license.

Versions and license identifiers below were verified against the installed
package metadata and vendored license/provenance files in this repository
(evidence path in the last column).

## Attribution table

| Component | Version | License | Role | Evidence (verified in-repo) |
|---|---|---|---|---|
| [opencascade.js](https://ocjs.org) (OCCT → wasm) | 2.0.0-beta.b5ff984 | LGPL-2.1-only | CAD kernel (B-rep modeling); source of the trimmed wasm in `packages/cad/vendor/occt/` | `apps/plastiq/node_modules/opencascade.js/package.json` (`"license": "LGPL-2.1-only"`); `LICENSE` file is the full LGPL-2.1 text |
| [@salusoft89/planegcs](https://www.npmjs.com/package/@salusoft89/planegcs) (FreeCAD planegcs → wasm) | 1.1.7 | LGPL-2.0-or-later (declared); ships the LGPL-2.1 text | 2D sketch constraint solver | `apps/plastiq/node_modules/@salusoft89/planegcs/package.json` (`"license": "LGPL-2.0-or-later"`); bundled `LICENSE` is the LGPL-2.1 text |
| [MuJoCo](https://github.com/google-deepmind/mujoco) wasm (`@mujoco/mujoco`) | 3.9.0 (vendored) | Apache-2.0 (© Google DeepMind) | Default physics backend for `@plastiq/sim` | `packages/sim/vendor/mujoco/LICENSE` (Apache License 2.0 text) and `packages/sim/vendor/mujoco/PROVENANCE.md` |
| [vhacd-js](https://www.npmjs.com/package/vhacd-js) (V-HACD by Khaled Mamou) | 0.0.1 (vendored) | BSD-3-Clause | Convex decomposition for collision geometry | `packages/cad/vendor/vhacd/LICENSE` (BSD 3-Clause, © 2011 Khaled Mamou) and `packages/cad/vendor/vhacd/PROVENANCE.md` |
| [sql.js](https://sql.js.org) | 1.14.1 | MIT | SQLite (wasm) document persistence | `apps/plastiq/node_modules/sql.js/package.json` (`"license": "MIT"`) |
| [three](https://threejs.org) | 0.184.0 | MIT | 3D rendering | `apps/plastiq/node_modules/three/package.json` (`"license": "MIT"`) |
| [react](https://react.dev) | 19.2.7 | MIT | UI framework | `apps/plastiq/node_modules/react/package.json` (`"license": "MIT"`) |
| [react-dom](https://react.dev) | 19.2.7 | MIT | UI framework (DOM renderer) | `apps/plastiq/node_modules/react-dom/package.json` (`"license": "MIT"`) |
| [zustand](https://www.npmjs.com/package/zustand) | 5.0.14 | MIT | State management | `apps/plastiq/node_modules/zustand/package.json` (`"license": "MIT"`) |
| [@dimforge/rapier3d-compat](https://rapier.rs) | 0.19.3 | Apache-2.0 | Physics backend (Rapier) | `packages/sim/node_modules/@dimforge/rapier3d-compat/package.json` (`"license": "Apache-2.0"`) |
| [ammojs-typed](https://www.npmjs.com/package/ammojs-typed) | 1.0.6 | MIT (wrapper); bundles ammo.js, a port of Bullet Physics, which is zlib licensed | Physics backend (ammo.js/Bullet) | `packages/sim/node_modules/ammojs-typed/package.json` (`"license": "MIT"`); `ammo/ammo.js` header: "a port of Bullet Physics to JavaScript. zlib licensed." |
| [cannon-es](https://www.npmjs.com/package/cannon-es) | 0.20.0 | MIT | Physics backend (cannon-es) | `packages/sim/node_modules/cannon-es/package.json` (`"license": "MIT"`) |
| [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) | 0.105.0 | MIT | Anthropic API client (AI generation) | `apps/plastiq/node_modules/@anthropic-ai/sdk/package.json` (`"license": "MIT"`) |
| [openai](https://www.npmjs.com/package/openai) | 6.44.0 | Apache-2.0 | OpenAI API client (AI generation) | `apps/plastiq/node_modules/openai/package.json` (`"license": "Apache-2.0"`) |

Versions of npm-installed (non-vendored) packages reflect the lockfile state
at the time of writing; the licenses above are the packages' own declared
licenses and continue to apply to whatever version is installed.

## LGPL wasm components

Two shipped WebAssembly components are under the GNU Lesser General Public
License:

1. **OCCT / opencascade.js** (`LGPL-2.1-only`). The trimmed build vendored at
   `packages/cad/vendor/occt/plastiq-occt.{js,wasm,d.ts}` is derived from
   OCCT via `opencascade.js`. The complete LGPL-2.1 text is included at
   [`packages/cad/vendor/occt/LICENSE_LGPL_2_1.txt`](./packages/cad/vendor/occt/LICENSE_LGPL_2_1.txt),
   and the same text ships as `apps/plastiq/node_modules/opencascade.js/LICENSE`.
   Upstream OCCT is published by Open Cascade SAS under LGPL-2.1 with the
   additional "Open CASCADE Exception (version 1.0)". See
   `packages/cad/vendor/occt/PROVENANCE.md` for build provenance and how to
   rebuild the wasm from `packages/cad/occt.build.yml`.
2. **planegcs** (`LGPL-2.0-or-later` declared; the package bundles the
   LGPL-2.1 text). The license text ships inside the npm package at
   `apps/plastiq/node_modules/@salusoft89/planegcs/LICENSE`.

In both cases the LGPL-licensed code is compiled to a **separable,
replaceable wasm module** loaded as a distinct artifact at runtime: the OCCT
wasm can be rebuilt or swapped independently of the application
(`packages/cad/vendor/occt/PROVENANCE.md` documents the rebuild procedure),
and the planegcs wasm is an npm-installed artifact replaceable by version
bump. This is a factual description of how the artifacts are packaged, not
legal advice.

## Vendored components

Components copied into this repository (rather than installed from npm) keep
their upstream license files next to the vendored code:

- `packages/cad/vendor/occt/` — trimmed OCCT wasm; LGPL-2.1
  (`LICENSE_LGPL_2_1.txt`, `PROVENANCE.md`).
- `packages/cad/vendor/vhacd/` — vhacd-js runtime; BSD-3-Clause (`LICENSE`,
  `PROVENANCE.md`).
- `packages/sim/vendor/mujoco/` — official MuJoCo wasm build; Apache-2.0
  (`LICENSE`, `PROVENANCE.md`).
