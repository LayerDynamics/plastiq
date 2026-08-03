# Plastiq task runner. Run `just` to list recipes.

default:
    @just --list

# Install workspace dependencies.
install:
    pnpm install

# Type-check every package + the app.
typecheck:
    pnpm -r --if-present run typecheck

# Lint the app + packages (e2e is excluded by eslint.config.js).
lint:
    pnpm exec eslint apps packages --max-warnings 0

# Run the full unit/integration test suite (Vitest).
test:
    pnpm exec vitest run

# Run the no-mock browser E2E suite (Playwright, served on :4177).
e2e:
    pnpm exec playwright test

# Production build of the app.
build:
    pnpm --filter @plastiq/app run build

# Dev server.
dev:
    pnpm --filter @plastiq/app run dev

# The symbol list lives in packages/cad/occt.build.yml — see
# packages/cad/scripts/build-occt.md. The image tag MUST match the pinned
# opencascade.js npm version.
#
# The builder's WorkingDir is the /src mount and it writes plastiq-occt.{js,d.ts,
# wasm} there, so it is handed a STAGING dir containing only a copy of the config
# rather than the package itself. Mounting packages/cad directly (as this recipe
# once did) drops the generated artifacts in the package root, where they shadow
# the committed vendor/occt/ copies and get linted — a minified 260 KB bundle is
# ~345 lint errors and a red CI. The build products ARE the vendored kernel, so
# they are copied into vendor/occt/ (committed; loaded by src/oc/init.ts).

# Rebuild the trimmed OCCT wasm for @plastiq/cad (Docker; long: 30–90 min, several GB).
cad-occt:
    mkdir -p "{{justfile_directory()}}/packages/cad/build/occt"
    cp "{{justfile_directory()}}/packages/cad/occt.build.yml" \
        "{{justfile_directory()}}/packages/cad/build/occt/occt.build.yml"
    docker run --rm -v "{{justfile_directory()}}/packages/cad/build/occt:/src" -u "$(id -u):$(id -g)" \
        donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml
    cp "{{justfile_directory()}}/packages/cad/build/occt/plastiq-occt.js" \
        "{{justfile_directory()}}/packages/cad/build/occt/plastiq-occt.d.ts" \
        "{{justfile_directory()}}/packages/cad/build/occt/plastiq-occt.wasm" \
        "{{justfile_directory()}}/packages/cad/vendor/occt/"
    @echo "cad-occt: artifacts copied into packages/cad/vendor/occt/ — commit them, then run 'npx vitest run packages/cad/src/oc/bindings.test.ts' to verify the new trim binds every required symbol."

# --- CADGenBench harness (local/manual — NOT push-CI) -------------------------
# Evaluates our parametric AI generation against the CADGenBench benchmark. Needs
# the `cadgenbench` py3.12 env, the mounted inputs bucket, and a local model. Full
# guide: benchmark/harness/README.md. Setup: see that README's "Setup (once)".

# Mount the input fixtures bucket at ./local (once per session).
bench-mount:
    hf-mount start bucket LayerDynamics/cadgenbench-data-bucket ./local

# Prove the upstream CAD-Score scorer runs + discriminates on the bundled GT fixtures.
bench-fixtures:
    mamba run -n cadgenbench python -m cadbench_harness score-fixtures

# Serve a local OpenAI-compatible model. Usage: just bench-serve mlx-vlm <model> [port]
bench-serve backend model port="8080":
    ./benchmark/harness/serve-model.sh {{backend}} {{model}} {{port}}

# Generate candidates over the fixtures + validate. Usage: just bench-run myrun <model>
bench-run name model:
    mamba run -n cadgenbench python -m cadbench_harness run {{name}} --model {{model}} --base-url http://localhost:8080/v1 --vision
    mamba run -n cadgenbench python -m cadbench_harness validate {{name}}

# Harness unit tests (offline).
bench-test:
    mamba run -n cadgenbench python -m pytest benchmark/harness/tests -q -m "not slow"

# --- Self-host (Docker) --------------------------------------------------------
# Build + serve the production app as a single static-nginx container. Full
# guide (bare-metal path, headers/compression, optional services): docs/deploy.md.

# Build the self-host image (repo-root context, multi-stage pnpm build → nginx).
app-docker-build:
    docker build -f deploy/plastiq-web/Dockerfile -t plastiq-web "{{justfile_directory()}}"

# Run the self-host image on http://localhost:8080.
app-docker-run:
    docker run --rm -p 8080:80 plastiq-web

# --- Python services (local) ---------------------------------------------------
# The five self-hosted services: reconstruct :8000 (mesh→B-rep/STEP), capture :8001
# (point cloud→mesh, MLX), nerf :8002 (posed images→mesh, MLX), nurbs :8003
# (mesh→NURBS surfaces→STEP, MLX), and photogrammetry :8004 (photos→poses+point
# cloud, MLX, SPEC-13 P10.2). Conda envs are created from each service's
# environment.yml on first run. Ctrl-C stops only supervisor-owned processes.

# Start and supervise the services (creates missing envs first).
services:
    ./scripts/dev-services.sh

# Stop every supervisor-owned fleet; healthy unowned listeners are preserved.
services-stop:
    ./scripts/dev-services.sh stop --all
