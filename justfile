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

# Build the TRIMMED opencascade.js for @plastiq/cad (Docker; long: 30–90 min,
# several GB). The symbol list lives in packages/cad/occt.build.yml. Deferred /
# optional — see packages/cad/scripts/build-occt.md. The image tag MUST match the
# pinned opencascade.js npm version.
cad-occt:
    docker run --rm -v "{{justfile_directory()}}/packages/cad:/src" -u "$(id -u):$(id -g)" \
        donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml

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
