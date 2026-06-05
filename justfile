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
    pnpm --filter @plastiq/cad-studio run build

# Dev server.
dev:
    pnpm --filter @plastiq/cad-studio run dev

# Build the TRIMMED opencascade.js for @plastiq/cad (Docker; long: 30–90 min,
# several GB). The symbol list lives in packages/cad/occt.build.yml. Deferred /
# optional — see packages/cad/scripts/build-occt.md. The image tag MUST match the
# pinned opencascade.js npm version.
cad-occt:
    docker run --rm -v "{{justfile_directory()}}/packages/cad:/src" -u "$(id -u):$(id -g)" \
        donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml
