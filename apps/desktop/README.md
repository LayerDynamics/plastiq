# Plastiq Desktop

The desktop distribution of **Plastiq**, the parametric CAD editor that lives in
[`apps/plastiq`](../plastiq). This package is a thin [Tauri 2](https://tauri.app)
shell. The window hosts the Plastiq web app, and the shell owns the five local
CAD/ML services for the packaged desktop lifetime.

## How it wires to `apps/plastiq`

Everything is driven by [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json):

- **Dev**: `beforeDevCommand` runs `pnpm -C ../plastiq dev` and the window loads
  `devUrl` `http://localhost:5173`. That command starts the shared service
  supervisor before Vite. If port 5173 is already in use, Vite will pick the
  next free port and the Tauri window will not find it — free the port first.
- **Build**: `beforeBuildCommand` runs `pnpm -C ../plastiq build`, and
  `frontendDist` points at `../../plastiq/dist` (paths in `tauri.conf.json` are
  resolved relative to the `src-tauri/` directory). The bundle also carries the
  supervisor plus all five service applications and environment manifests.
- **Packaged runtime (macOS/Linux)**: release startup launches the bundled
  supervisor with app-local state/logs. An unexpected supervisor exit closes
  the app with an error; normal app exit stops only token-verified processes
  owned by that app instance. Healthy pre-existing services are left running.

## Prerequisites

- The [Rust toolchain](https://www.rust-lang.org/tools/install) (`cargo`) — the
  shell is a Rust crate.
- Node + pnpm with workspace dependencies installed (`pnpm install` at the repo
  root), so `apps/plastiq` can build.
- `micromamba`, `mamba`, or `conda`, plus `curl` and `lsof`, for the local service
  supervisor. Missing service environments are created from the bundled
  `environment.yml` manifests on first start.
- On Linux, Tauri's [system dependencies](https://tauri.app/start/prerequisites/)
  (webkit2gtk etc.). macOS and Windows need no extra system packages.

## Develop

```bash
pnpm -C apps/desktop dev        # = tauri dev
```

Starts and health-checks the five services, starts Vite, and opens the editor in
a native window with hot reload. Service failures are restart-supervised for the
same lifetime as Vite.

## Build

```bash
pnpm -C apps/desktop build      # = tauri build
```

Type-checks and builds `apps/plastiq`, compiles the Rust shell in release mode,
and produces platform installers/bundles under
`src-tauri/target/release/bundle/`.

## Notes

- `src-tauri/icons/` contains the branded desktop icon set generated from the
  authoritative Plastiq mark at the repository root. The source aspect ratio is
  preserved and the mark is centered on each platform's square icon canvas.
- The editor remains a web app and exposes no custom frontend Tauri commands;
  `src-tauri/src/lib.rs` is responsible for packaged service lifecycle only.
- The bundled Bash supervisor is enabled for macOS/Linux desktop releases. The
  ML service environments themselves are primarily supported on Apple Silicon;
  Windows currently builds the editor shell without the Unix service launcher.
