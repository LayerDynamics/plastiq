# @plastiq/app

The **Plastiq** CAD editor front end — an interactive, parametric, in-browser CAD
editor (React + Zustand + Tailwind + three.js) on the
[`@plastiq/cad`](../../packages/cad) kernel, with the
[`@plastiq/sim`](../../packages/sim) physics layer for in-editor simulation.

See the [repository README](../../README.md) for the architecture overview.

## What it does

- **Modelling** — sketch → extrude (blind / two-sided / up-to-a-picked-face /
  along a picked edge) / revolve / cut; loft through stacked sections and sweep
  along a path; fillet / chamfer / shell / draft on picked edges/faces (persisted
  as kernel `EdgeRef`/`FaceRef` so they survive rebuilds); boolean against a
  modelled body; pattern / mirror / baked transform; an ordered, editable feature
  tree with reorder, rollback, suppress, and per-feature error badges.
- **Sketcher** — a 2D overlay on a datum plane with the full constraint + dimension
  set wired to the kernel's planegcs-backed variational solver, with a live DOF
  counter and three-state (under/well/over-constrained) feedback.
- **Typed 3D interaction** — hover/click selection of faces/edges/vertices (ray
  picking with a GPU colour-id fallback), rubber-band box select, transform gizmos
  that write back a parametric placement, a clickable view cube, and a measure tool.
- **Assemblies** — insert component instances, mate them (the kernel 3D mate
  solver positions them), articulated joints with a live motion-preview drive.
- **Persistence** — an in-browser SQLite project store (sql.js → IndexedDB) with
  new/open/save/save-as/rename/delete, debounced autosave, byte-identical reload,
  and crash recovery of unsaved work.
- **Simulate & interchange** — drop/run the model in the real `@plastiq/sim`
  physics engine, plus glTF / STEP / IGES export and STEP import.
- **AI generation (SPEC-6)** — describe a part in natural language and a model
  authors it: a streaming agent loop calls `build_part` (validated mm/deg authoring
  document → SI → the kernel) and `inspect_geometry`, can **edit** the open part, and
  selects faces/edges by name or geometry. Reachable from the **Generate (AI)** side
  panel and a **⌘/Ctrl-K command palette** (which also runs any editor action by name).
  Providers are BYO and pluggable — **local Ollama** (no key, offline) or **Anthropic
  Claude** (vision); keys are stored in the browser and structured for a future hosted
  proxy. A creative path (`create_mesh`) turns text/image prompts into a GLB **mesh
  document** via cloud 3D-gen (fal.ai Tripo / Meshy / Hunyuan3D); paid jobs require an
  explicit one-click confirm and show running token/job usage.
- **Mesh → editable CAD** — a generated/imported mesh document can be reconstructed
  into a real B-rep STEP solid via the optional reconstruction service
  ([`services/reconstruct`](../../services/reconstruct)) — the "Convert to CAD (STEP)"
  action imports the result back as an editable `CadDocument`.

## AI generation

The AI features live in [`src/ai`](src/ai). The agent surface (`build_part`,
`inspect_geometry`, `create_mesh`, `answer_user`) is wired once in
[`agentTurn.ts`](src/ai/agentTurn.ts) and shared by both entry points (the
`GenerationPanel` and the `CommandPalette`), so they behave identically.

- **Providers** are BYO: pick **local Ollama** (default `qwen2.5`/`qwen3.6`, no key) or
  **Anthropic** (paste a key) on first run. Keys never leave the browser except to the
  endpoint you configured; the resolver is swappable for a future hosted proxy.
- **Creative mesh-gen (fal.ai)** needs a fal key (set it in the panel's "Creative
  mesh-gen" section) **or** a proxy base URL. Honest constraint: a *direct* browser→fal
  call needs fal CORS, so in practice the creative path runs through a proxy or a
  CORS-enabled key — without either, `create_mesh` fails cleanly rather than silently.
- **Cost control:** every paid 3D/image-gen job is gated behind a one-click confirm; LLM
  calls (Ollama / your own key) run freely; an agent step cap is always on.

## Scripts

```bash
pnpm -C apps/plastiq run dev      # five-service supervisor + Vite
pnpm -C apps/plastiq run dev:ui   # Vite only (tests or an externally managed fleet)
pnpm -C apps/plastiq run build    # tsc --noEmit + production build
pnpm exec vitest run              # unit/integration suite (from the repo root)
pnpm exec playwright test         # no-mock E2E (served on :4177)
```

The development wrapper creates missing conda environments, requires every `/health` gate,
restarts an owned service after sustained health loss, and shuts the fleet down with Vite. A
healthy process already on a service port is adopted but never killed. Service logs and
owner-scoped PID/token records live under the platform state directory (`~/.local/state/plastiq/services`
unless `XDG_STATE_HOME` is set).

### AI / reconstruction E2E

The AI and reconstruction E2E specs are real (no mocks) and self-skip when their
dependency isn't reachable, so the default suite stays green offline:

```sh
pnpm e2e --grep "real pipeline without a model"   # model-free pipeline (always runs)
pnpm e2e --grep "real local model"                # AI in the loop — needs local Ollama
pnpm e2e --grep reconstruct                        # mesh→CAD — needs services/reconstruct up
```

- The Ollama spec needs a running Ollama with a tool-capable model
  (`OLLAMA_URL`/`OLLAMA_MODEL`, default `qwen3.6:35b-mlx`).
- The reconstruct spec needs the service running (`RECONSTRUCT_URL`, default
  `http://127.0.0.1:8000`) — see [`services/reconstruct`](../../services/reconstruct).
