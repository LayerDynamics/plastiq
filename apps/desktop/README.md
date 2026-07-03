# Plastiq Desktop

The desktop distribution of **Plastiq**, the parametric CAD editor that lives in
[`apps/plastiq`](../plastiq). This package is a thin [Tauri 2](https://tauri.app)
shell: it contains no frontend code of its own — the window simply hosts the
Plastiq web app.

## How it wires to `apps/plastiq`

Everything is driven by [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json):

- **Dev**: `beforeDevCommand` runs `pnpm -C ../plastiq dev` and the window loads
  `devUrl` `http://localhost:5173` (Vite's default port; `apps/plastiq` does not
  override it). If port 5173 is already in use, Vite will pick the next free
  port and the Tauri window will not find the dev server — free the port first.
- **Build**: `beforeBuildCommand` runs `pnpm -C ../plastiq build`, and
  `frontendDist` points at `../../plastiq/dist` (paths in `tauri.conf.json` are
  resolved relative to the `src-tauri/` directory), so the bundle ships the
  production build of the editor.

## Prerequisites

- The [Rust toolchain](https://www.rust-lang.org/tools/install) (`cargo`) — the
  shell is a Rust crate.
- Node + pnpm with workspace dependencies installed (`pnpm install` at the repo
  root), so `apps/plastiq` can build.
- On Linux, Tauri's [system dependencies](https://tauri.app/start/prerequisites/)
  (webkit2gtk etc.). macOS and Windows need no extra system packages.

## Develop

```bash
pnpm -C apps/desktop dev        # = tauri dev
```

Starts the Plastiq Vite dev server and opens it in a native window with hot
reload.

## Build

```bash
pnpm -C apps/desktop build      # = tauri build
```

Type-checks and builds `apps/plastiq`, compiles the Rust shell in release mode,
and produces platform installers/bundles under
`src-tauri/target/release/bundle/`.

## Notes

- `src-tauri/icons/` still contains the stock Tauri icon set; replacing it with
  branded Plastiq icons is a follow-up asset task.
- There are no custom Tauri commands yet (`src-tauri/src/lib.rs` only boots the
  webview); the editor runs entirely as a web app.
