# SPEC-6 — AI Generation for Plastiq (text→CAD + image→3D)

**Status:** Draft (refined — all open questions resolved)
**Date:** 2026-06-20
**Owner:** LayerDynamics
**Depends on:** SPEC-4 (`@plastiq/cad` kernel), SPEC-5 (`apps/plastiq` editor)
**Supersedes / relates to:** prior plans in `docs/plans/` (independent app, viewport rewrite, fusion workspaces)
**Reference implementation studied:** `ref/CADAM` (open-source text-to-CAD; OpenSCAD-based)

---

## Revision history

- **2026-06-20 (r3, implementation reconciliation):** Two below-the-decisions
  refinements found during R4.1/R4.2 implementation, recorded here for accuracy (the
  24 locked decisions are unchanged — decision 20 "parametric OR mesh" still holds):
  (1) **`MeshBody` + the GLB importer live in the app, not `@plastiq/cad`**, and mesh
  rendering is **main-thread** (`viewport/buildMesh.ts` → `THREE.Mesh`), bypassing the
  OCCT worker / `TransferMesh` (which is B-rep-only) — `three` is an app dep, not a
  kernel dep (decision 24). (2) **A `MeshDoc` stores the model as an inline base64 GLB**
  (`{ kind:"mesh", name?, glb, source }`) and re-derives geometry via `importGltf` on
  load (mirroring how `importStep` re-imports STEP text) — **not** a pre-parsed
  `bodies: MeshBody[]` array plus a separate GLB blob. Reason: `Float32Array`/
  `Uint32Array` do not survive `JSON.stringify`, so a `bodies` array would break the
  FR-39 byte-identical round-trip and the sqlite/recovery JSON paths; an inline,
  self-contained base64 GLB round-trips cleanly and never reaches the localStorage
  recovery snapshot (mesh docs route to `activeMeshDoc`, not the cad store). FR-16,
  FR-16a, §6.5, and §7.2 below are updated to match the shipped code.
- **2026-06-20 (r2):** Resolved all open questions via user decisions. Scope changes
  from r1: vision→parametric moves **into** v1 (user-routed images); a generated mesh
  becomes its **own document kind** (not a body inside a B-rep part — mixing moves out
  of scope); the creative path supports **all three** input modes (text→image→3D,
  image→3D, text→3D); AI can **edit** the open part, not only create; 3D/image
  providers are **multi-selectable with no hard default**; first run shows a **neutral
  provider chooser**; the generation UI is a **side panel + command palette**; cost
  control is **usage display + confirm-before-paid-job**; conversation history is
  **persisted per project**; provider keys are **BYO now, proxy-later**; the model
  picker is a **curated list + custom field with a tool-capability preflight** (model
  research embedded in §6.9 / Appendix A).
- **2026-06-20 (r1):** Initial draft from the deep-code investigation.

---

## 0. One-sentence thesis

Plastiq becomes a **prompt-to-part** CAD editor: you describe (or sketch, or photograph)
a part and an AI authors — or edits — a **real, editable parametric feature history** in
our own OCCT kernel, or generates an organic **mesh body** when B-rep won't do; every
generated dimension is a slider in the existing timeline, and the parametric path still
runs **in the browser with no mandatory server**.

This is fundamentally different from CADAM, which makes the model emit **OpenSCAD text**
and compiles it through a foreign WASM. Plastiq already owns a serializable,
re-evaluatable feature program (`CadDocument`) and a B-rep kernel; here the AI emits
**that document**. CADAM's marquee "parameter sliders without re-calling the AI" is a
feature Plastiq already has natively (the feature timeline + `PropertiesPanel`).

---

## 1. Problem & motivation

### 1.1 Problem

Plastiq is a capable parametric CAD editor but every part must be built by hand
(sketch → extrude → fillet …). There is no way to go from intent ("a knurled knob,
40mm, M3 set screw") to geometry, nor from a reference photo to a part. CADAM proves the
demand and the UX, but bolts AI onto OpenSCAD because it has no native parametric model.
Plastiq has the better substrate and should expose it.

### 1.2 Why now / why us

- The generation target already exists and is verified: `CadDocument`
  (`apps/plastiq/src/store/types.ts:37-41`) is an ordered, JSON-serializable feature
  program that the worker already replays into B-rep geometry
  (`apps/plastiq/src/worker/rebuild.ts:125` `rebuildDocument`).
- The render/edit/persist loop is already reactive: `Viewport.tsx:213` subscribes to
  `store.features`/`store.params` and rebuilds; programmatic `loadDocument()` /
  `addFeature()` (`store.ts:688` / `store.ts:310`) trigger it. **AI-injected documents
  auto-render with zero new plumbing.**
- A browser can call the Anthropic API directly (`dangerouslyAllowBrowser: true`;
  the API honors the CORS opt-in), and local **Ollama** needs no key at all — so the
  "no server" identity survives for the parametric path.
- A command surface already exists to drive programmatically: `actions/registry.ts`
  (`runAction(id, ctx)`), which a command palette and the agent's tool handlers can both
  reuse.

### 1.3 Goals

1. **Parametric generation & editing:** natural-language (or image) → a validated
   `CadDocument` that builds in our kernel, appears in the timeline, and is editable via
   the existing parameter UI. The AI can **edit the open part** (receives it as context)
   or create a new one.
2. **Creative generation:** text and/or image → a 3D **mesh body** (GLB) as its own
   document, for organic shapes the B-rep path can't author. Three input modes:
   text→image→3D, image→3D, and direct text→3D.
3. **Vision:** an attached image can drive **either** path — a parametric reference
   ("model this bracket") or a creative mesh — chosen by the user.
4. **Provider-agnostic AI:** Anthropic (BYO-key, direct), local **Ollama**, other
   OpenAI-compatible endpoints, and a drop-in hosted proxy — selectable at runtime,
   no rework to add the proxy.
5. **Reliable selection:** the AI can target faces/edges for dress-up features
   (fillet/chamfer/shell/sketch-on-face) despite those refs being geometry-derived.
6. **Local-first & honest:** parametric stays no-server (Ollama or BYO direct); the
   creative path and vision-on-cloud-models use external services and say so.
7. **No regressions; no mocks in E2E** — per repo conventions.

### 1.4 Non-goals (v1)

- No multi-user / cloud sync / accounts (Plastiq is local-first).
- No fine-tuning or hosting our own LLM; we integrate existing providers.
- No automatic assembly/mate generation by AI (single-part focus; assemblies remain
  manual). Generated parts can still be instanced into assemblies by hand.
- **No mixing mesh bodies and B-rep in one document.** A generated mesh is a **separate
  document kind**; combining a parametric base with a mesh add-on in one part is future
  work (§13).
- The hosted proxy's auth/billing service is **designed for but not built** in v1
  (the client is proxy-ready; the proxy itself is a follow-on).
- In-browser/local **image→3D** generation. The creative path requires external 3D-gen
  (and, for text→image, image-gen) services (see §6.5 and Risk R-1); it is explicitly
  *not* no-server.

---

## 2. Locked decisions

| # | Decision | Detail / rationale |
|---|----------|--------------------|
| 1 | **Generation target = `CadDocument`, not OpenSCAD text** | The AI emits our native feature program; the worker already builds it. Real B-rep, real parametrics, STEP/glTF export for free. |
| 2 | **The browser is the compiler** | Like CADAM, the generation tool has **no server-side execute**. The AI emits a document; the client validates + builds it in the existing worker. |
| 3 | **Provider-agnostic AI behind one interface** | Adapters: (a) **Anthropic direct** BYO-key (`dangerouslyAllowBrowser`); (b) **OpenAI-compatible** covering **Ollama** (local, no key), OpenAI, and others via base-URL; (c) **proxy** = an OpenAI/Anthropic-compatible base-URL with the secret held server-side (drop-in, no code change). |
| 4 | **Scope = both paths** | Parametric (`build_part`) **and** creative image→3D (`create_mesh`). Creative requires new kernel work (§6.5). |
| 5 | **New kernel capability: mesh bodies** | `@plastiq/cad` gains a `MeshBody` (triangle soup + normals + optional material) alongside `Solid`, plus a **GLB/glTF importer**. |
| 6 | **3D + image providers are pluggable, multi-selectable, NO hard default** | `MeshGenProvider` + `ImageGenProvider` interfaces; ship 2–3 each (fal.ai: Tripo / Meshy v6 / Hunyuan3D). User picks per job; no baked default. Honest constraint: needs network + account; not no-server. |
| 7 | **Selection = both strategies** | (a) **Structured-ref feedback loop**: AI builds, app returns enumerated faces/edges as text, AI picks real refs; (b) **selector-predicate layer**: named selectors (`topFace`, `edgesParallelTo`, `largestPlanarFace`, …) resolved at rebuild time, surviving parameter changes. |
| 8 | **Authoring units = mm/deg; storage stays SI** | The AI authoring schema is human/CADAM-friendly **mm/degrees**; ingestion converts to the kernel's SI (`metres`/`radians`) — the `CadDocument` format does **not** fork. (`unit/index.ts` already provides `mm`/`deg`.) |
| 9 | **Untrusted AI output is validated** | Add `zod`; a `cadDocumentSchema` validates every tool result before `loadDocument`. Validation errors feed back to the model for self-correction. |
| 10 | **Reuse, don't reinvent the editor** | Generated features land in the existing timeline (`FeatureTree.tsx`) and parameter editor (`PropertiesPanel.tsx`); persistence uses the existing `projectsStore`. No parallel render/edit/save path. |
| 11 | **No-stub, no-mock-E2E** | Per global + repo CLAUDE.md. Deterministic pipeline E2E always runs; the LLM boundary is E2E'd against a **real local Ollama** (a legitimate realistic stand-in), with an opt-in keyed Anthropic E2E. |
| 12 | **git: branch off `main`, commit per milestone, no push without ask** | Matches repo convention. |
| 13 | **Edit-or-create (resolves FR-6 ambiguity)** | When a part is open, the AI receives the current document (as a mm/deg authoring doc) and may modify it; with nothing open it creates fresh. `build_part` always emits the **whole** updated document (no diff/patch protocol) — simplest + deterministic. |
| 14 | **History persisted per project (OQ-1)** | The AI conversation + generation trace are saved with the project (IndexedDB, separate store) and reloaded with it, enabling resumable iterative editing. |
| 15 | **Creative input = all three modes** | `create_mesh` supports text→image→3D (generate an image, then 3D), image→3D (user image), and direct text→3D where a provider supports it. Requires an `ImageGenProvider` for the text→image stage. |
| 16 | **Vision is user-routed (OQ-3 → in v1)** | An attached image can drive the **parametric** path (vision→`build_part`) or the **creative** path (`create_mesh`), chosen by the user. Parametric-vision needs a vision-capable model (Claude; most local Ollama tool-models are not vision-capable — see R-9). |
| 17 | **First run = neutral provider chooser** | No default provider/model; first use presents a picker. Avoids silently steering users to a paid key or assuming Ollama is installed. |
| 18 | **Generation UI = side panel + command palette** | A dockable AI panel in the Design workspace (primary), **and** a command-palette/modal entry for quick prompts. Both drive the same `agentRunner`. The palette reuses `actions/registry.ts`. |
| 19 | **Cost = usage display + confirm paid jobs** | Show running token/job usage; require one-click confirmation before each **paid** 3D/image-gen job; parametric LLM calls (BYO/Ollama) run freely; an agent step cap is always on. |
| 20 | **Mesh = separate document kind (Body-model fork)** | A generated mesh is persisted as a distinct document kind (`kind: "mesh"`), **not** an `importMesh` feature inside a B-rep `CadDocument`. A project is parametric **or** mesh, not mixed. Simpler kernel; isolates the mesh path. |
| 21 | **Provider keys = BYO now, proxy-later** | All third-party keys (Anthropic, fal, image-gen) are entered by the user and stored client-side now; the client is structured so the future proxy can hold them instead, with no call-site rework. |
| 22 | **Model picker = curated list + custom + tool-capability preflight** | Per-provider suggested models (researched — Appendix A) plus a free-text override; before first use the app preflights that the chosen model advertises tool calling and warns otherwise. |
| 23 | **Impl: OpenAI-compatible adapter uses the official `openai` SDK** | One `openai` client with a configurable `baseURL` covers Ollama, OpenAI, and the proxy (robust SSE + tool-call assembly). Anthropic uses `@anthropic-ai/sdk`. |
| 24 | **Impl: GLB/glTF import via three.js `GLTFLoader`, in the app** | `three` is an **app** dependency (not `@plastiq/cad`, whose only deps are `opencascade.js` + `planegcs`). `MeshBody` + `importGltf` live under `apps/plastiq/src/mesh/` and run **main-thread**, so the kernel stays three-free and mesh rendering needs no worker/OCCT round-trip. |

---

## 3. Background — what exists vs. what's needed (verified)

### 3.1 What we reuse (already in the codebase)

| Capability | Where (verified) |
|---|---|
| Serializable feature program | `apps/plastiq/src/store/types.ts:19-41` (`EditorFeature`, `CadDocument`) |
| Feature → solid evaluator | `apps/plastiq/src/worker/rebuild.ts:125` (`rebuildDocument`) |
| Kernel verbs (≈18 features) | `packages/cad/src/index.ts`; `packages/cad/src/action/*` |
| Sketch profile (AI-emittable) | `apps/plastiq/src/sketch/profile.ts:22` |
| Tagged mesh w/ persistent refs | `packages/cad/src/mesh/tagged.ts:21-58` (`FaceRef`, `EdgeRef`, `FaceGroup`, `TaggedEdge`) |
| Worker RPC + transfer mesh | `apps/plastiq/src/worker/{protocol,bridge,geometry.worker.core}.ts` |
| Reactive rebuild on doc change | `apps/plastiq/src/three/Viewport.tsx:213` |
| Programmatic doc injection | `apps/plastiq/src/store/store.ts:688` (`loadDocument`), `:310` (`addFeature`) |
| Command registry (palette substrate) | `apps/plastiq/src/actions/registry.ts` (`runAction(id, ctx)`) |
| Timeline + parameter sliders | `apps/plastiq/src/app/{FeatureTree,PropertiesPanel}.tsx`, `three/gizmos/featureEdit.gizmo.tsx` |
| Units helpers (mm/deg ↔ SI) | `packages/cad/src/unit/index.ts` (`mm`, `deg`, `toMm`, `toDeg`) |
| Persistence + autosave + recovery | `apps/plastiq/src/persistence/{projectsStore,sqlite,idb,recovery}.ts` |
| glTF **export**; three.js | `packages/cad/src/io/index.ts` (`exportGltf`); `three` in `apps/plastiq/package.json` |

### 3.2 What must be built (gaps confirmed)

| Gap | Evidence it's missing |
|---|---|
| Any AI / LLM / network / secret layer | `apps/plastiq/package.json` has zero AI deps; grep finds no `fetch`/`process.env`/`.env` in app/kernel. |
| `CadDocument` runtime validator | No `zod` dependency; no `isCadDocument`/schema anywhere. |
| Mesh-body type | `Solid` (`packages/cad/src/solid/solid.ts`) is the only body class — B-rep only. |
| GLB/glTF **import** | `io/index.ts` exports glTF + STEP but imports **only** STEP (`importStep`); `io.test.ts` notes no glTF/IGES import. |
| **Mesh document kind** | persistence (`persistence/types.ts`) models one shape: `Project = { meta, doc: CadDocument }`. A `kind`-discriminated doc is new. |
| Selector-predicate resolution | dress-up features today require concrete `FaceRef[]`/`EdgeRef[]` in `data`. |
| Image-gen + 3D-gen provider clients | none. |
| Vision input plumbing | the parametric path has no image-input route. |
| Chat / generation UI, command palette, settings, cost UI | none (the command *registry* exists; no palette UI). |

---

## 4. Functional requirements

> Numbered `FR-N` to match SPEC-4/5 convention. Each is testable.

### Provider layer

- **FR-1** A `ChatProvider` interface exposes a streaming, tool-calling completion call
  independent of vendor. At least three adapters ship: `anthropic`, `openai-compatible`
  (covers Ollama + OpenAI + others, via the official `openai` SDK + `baseURL`), and
  `proxy`.
- **FR-2** Anthropic adapter calls the API directly from the browser with
  `dangerouslyAllowBrowser: true`, adaptive thinking (`thinking: { type: "adaptive" }`),
  streaming, tool use, and **image input** (for vision→parametric).
- **FR-3** Ollama works against `http://localhost:11434/v1` with **no API key**, a
  user-selectable local model, and tool calling. The app surfaces the `OLLAMA_ORIGINS`
  CORS requirement and a tool-capable-model requirement in-product.
- **FR-4** Provider, model, base-URL, and keys are user-configurable in a Settings panel
  and persisted locally (IndexedDB). Keys are never sent anywhere except the configured
  endpoint, and are structured so a proxy can hold them later without call-site changes.
- **FR-5** Pointing any adapter at a hosted proxy base-URL requires **no code change**.
- **FR-5a** First run shows a **neutral provider chooser** (no default provider/model).
- **FR-5b** Model selection is a **curated list + free-text override**; the app
  **preflights** that the selected model advertises tool calling and warns if not
  (Appendix A lists the curated entries).

### Parametric generation & editing (`build_part`)

- **FR-6** A `build_part` tool accepts an authoring document (mm/deg) and, after
  client-side validation + conversion to SI, replaces the current `CadDocument` via
  `loadDocument()`, triggering the existing rebuild+render.
- **FR-6a** **Edit mode:** when a part is open, the agent receives the current document
  (serialized SI→mm/deg as an authoring doc) in context and may modify it; `build_part`
  always emits the **whole** updated document (no diff protocol). With nothing open it
  creates fresh.
- **FR-7** All AI-authored documents are validated against `cadDocumentSchema` (zod)
  before injection. Structural failures and per-feature build errors are returned to the
  model as a tool result so it can self-correct (bounded retry loop).
- **FR-8** The model can author all currently-supported feature types (box, sketch,
  extrude, revolve, loft, sweep, cut, transform, mirror, linear/circular pattern,
  boolean) **blind** from dimensions; dress-up features use §6.4 selection.
- **FR-9** Generated features appear in the timeline and are editable through the
  existing parameter UI with no AI re-call (native "smart update").
- **FR-9a** **Known display gap (verified):** the generic feature editor renders raw
  param values (`PropertiesPanel.tsx:108`, `value={val}`) — only `PlacementEditor`
  converts to mm/deg (`/M_PER_MM`). So an authored `40 mm` length, stored SI as `0.04`,
  currently *displays* as `0.04`. R2 must add per-param unit display (length→mm,
  angle→deg) to the generic editor. Display-only; storage round-trips losslessly (FR-10).
- **FR-10** Authoring units are mm/degrees; ingestion converts to the kernel's SI.
  Round-tripping an unedited generated part is loss-free.

### Vision

- **FR-10a** An attached image can be routed by the user to the **parametric** path
  (sent to a vision-capable `ChatProvider` to inform `build_part`) or the **creative**
  path (`create_mesh`). The route is a user choice on the attachment.
- **FR-10b** If the selected model is not vision-capable, the parametric-image route is
  disabled with a clear message (no silent drop); the creative route remains available.

### Selection

- **FR-11** An `inspect_geometry` tool returns the current part's enumerated faces and
  edges (index, normal, centroid/midpoint, area/length, planar/cylindrical hint) as
  structured text from the freshly built `TaggedMesh` — no rendered image required.
- **FR-12** The AI references inspected faces/edges by index; the client maps indices to
  concrete `FaceRef`/`EdgeRef` before writing them into the dress-up feature's `data`.
- **FR-13** A **selector-predicate** form is supported in feature `data` (e.g.
  `{ kind: "topFace" }`, `{ kind: "edgesParallelTo", axis }`,
  `{ kind: "largestPlanarFace" }`, `{ kind: "allEdges" }`). `rebuildDocument` resolves
  predicates against the freshly tessellated solid into concrete refs at build time.
- **FR-14** Predicate-selected dress-ups survive parameter changes that move/rescale
  geometry (the predicate re-resolves), where index/ref selection may not.

### Creative generation (`create_mesh`) — separate mesh document kind

- **FR-15** A `create_mesh` tool produces a mesh from one of three inputs —
  text→image→3D, image→3D, or text→3D — via a user-selected `MeshGenProvider`
  (and `ImageGenProvider` for the text→image stage), and ingests the resulting GLB.
- **FR-16** The **app** (`apps/plastiq/src/mesh/`, not `@plastiq/cad`) gains a `MeshBody`
  representation and a GLB/glTF importer (three.js `GLTFLoader`); a mesh document renders
  **main-thread** (`viewport/buildMesh.ts` → `THREE.Mesh`), bypassing the OCCT worker and
  `TransferMesh` (which is B-rep-only). See r3 reconciliation note.
- **FR-16a** A generated mesh is persisted as a **distinct document kind**
  (`kind: "mesh"`) via `projectsStore`, holding the source GLB **inline as base64** plus
  generation metadata; geometry is re-derived via `importGltf` on load. It is **not** a
  feature inside a B-rep `CadDocument`, and **not** a pre-parsed `bodies[]` array (r3
  note: typed arrays don't survive `JSON.stringify`).
- **FR-17** The product clearly communicates that creative generation (and cloud vision)
  uses an external service (network + account/key) and is not offline/no-server.
- **FR-18** Mesh documents are export-capable (GLB at least). B-rep feature operations
  are unavailable on a mesh document; the UI reflects this rather than offering a no-op.

### Cost & control

- **FR-18a** A usage meter shows tokens (per turn/session) and paid-job counts. Before
  each **paid** 3D/image-gen job the user must confirm (one click). Parametric LLM calls
  on BYO/Ollama run without confirmation. An agent **step cap** is always enforced.

### Chat / UX / persistence

- **FR-19** The generation UI is available as a **dockable side panel** in the Design
  workspace **and** via a **command palette/modal**; both provide prompt input, image
  attach + route choice, streaming response, a visible tool-call/build trace, and an
  error surface, driving the same `agentRunner`.
- **FR-20** Generation writes into the active project; the existing autosave + crash
  recovery persist the resulting document unchanged. The **conversation + generation
  trace are persisted per project** (FR/decision 14) and reloaded with it.
- **FR-21** A generation in progress can be cancelled; a failed/garbled generation never
  corrupts the existing document (atomic apply or no-op).

---

## 5. Architecture overview

```text
┌──────────────────────── apps/plastiq (browser; parametric path = no server) ───────────────────┐
│                                                                                                  │
│  GenerationPanel (Design side panel)   +   Command palette (reuses actions/registry)             │
│        │  prompt / image + route(parametric|creative) / cancel                                   │
│        ▼                                                                                          │
│  aiStore (zustand) ── conversation, status, settings, usage ──► persistence (IndexedDB)          │
│        │                                                                                          │
│        ▼                                                                                          │
│  agentRunner  ── tool loop, step cap, validation-retry, cancel ──┐                               │
│        │                                                          │ tool calls                    │
│        ▼                                                          ▼                               │
│  ChatProvider (interface)                       Tool handlers (client-side; browser is compiler)  │
│   ├ AnthropicAdapter (+vision) ────────►          • build_part(doc[,editContext]) → zod+mm→SI → loadDocument
│   ├ OpenAICompatAdapter (openai SDK) ──►          • inspect_geometry → GeometryClient.build → TaggedMesh→text
│   │    (Ollama / OpenAI / proxy)                  • create_mesh(mode, providerId) → mesh document
│   └ (proxy = baseURL re-point)                    • answer_user(text)                              │
│                                                                                                  │
│  loadDocument() ─► useCadStore ─► Viewport subscribe (rebuild) ─► GeometryClient ─┐               │
│                                                                                   ▼               │
│                         Web Worker:  rebuildDocument(oc, doc) [OCCT WASM]                          │
│                             + selector-predicate resolution + tessellateTagged                    │
│                                                                                                  │
│  MeshDocument (kind:"mesh") ─► importGltf (GLTFLoader) ─► MeshBody ─► viewport render              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
   │ parametric: Anthropic direct / Ollama local        │ creative + cloud-vision (external; paid)
   ▼                                                     ▼
 api.anthropic.com / localhost:11434       ImageGenProvider + MeshGenProvider (fal.ai: Tripo/Meshy/Hunyuan)
```

### 5.1 New modules (proposed layout)

```text
apps/plastiq/src/ai/
  providers/
    types.ts             # ChatProvider, ChatMessage(+image), ToolDef, StreamEvent
    anthropic.ts         # AnthropicAdapter (@anthropic-ai/sdk, dangerouslyAllowBrowser, vision)
    openaiCompatible.ts  # openai SDK + baseURL → Ollama / OpenAI / proxy
    registry.ts          # construct adapter + model from settings; tool-capability preflight
    models.ts            # curated model catalog per provider (Appendix A)
  tools/
    buildPart.ts         # validate + mm→SI + atomic loadDocument; edit-context assembly
    inspectGeometry.ts   # build + enumerate faces/edges as text
    createMesh.ts        # image-gen? → 3D-gen → GLB → mesh document
    schema.ts            # zod authoring schema (mm/deg) + ↔ CadDocument (SI) mappers
  meshgen/
    types.ts             # MeshGenProvider + ImageGenProvider interfaces
    fal.ts               # fal.ai client: Tripo / Meshy v6 / Hunyuan3D (selectable)
  agentRunner.ts         # tool loop, retry-on-validation-error, step cap, cancellation
  prompt.ts              # system prompts (parametric + creative)
  usage.ts               # token/job accounting + paid-job confirmation gate
  aiStore.ts             # conversation, status, settings, usage (persisted per project)
  GenerationPanel.tsx    # side-panel UI
  CommandPalette.tsx     # quick-prompt + action search (reuses actions/registry)
  settings.ts            # provider/key storage (IndexedDB), proxy-ready indirection
  visionRoute.ts         # attachment routing: parametric (vision) vs creative (FR-10a/b)

apps/plastiq/src/mesh/   # top-level, NOT under ai/ (used by viewport + persistence too)
  meshBody.ts            # MeshBody type + helpers (in the APP — three is an app dep)
  importGltf.ts          # GLB/glTF → MeshBody via three.js GLTFLoader (main-thread)

apps/plastiq/src/viewport/
  buildMesh.ts           # buildMeshBody: MeshBody → THREE.Mesh (main-thread render)

packages/cad/src/
  select/predicates.ts   # selector-predicate resolution (topFace, edgesParallelTo, …)
```

### 5.2 The provider interface (contract sketch)

```ts
// apps/plastiq/src/ai/providers/types.ts
export interface ToolDef { name: string; description: string; parameters: JsonSchema; }
export interface ChatProvider {
  readonly id: "anthropic" | "openai-compatible";
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;          // set after preflight (FR-5b)
  stream(req: {
    system: string;
    messages: ChatMessage[];                // text + optional image parts
    tools: ToolDef[];
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent>;            // text deltas, tool_call, done, usage
}
```

- **AnthropicAdapter** wraps `@anthropic-ai/sdk` (`new Anthropic({ apiKey,
  dangerouslyAllowBrowser: true })`), adaptive thinking, streaming, tools, image blocks.
- **OpenAICompatAdapter** uses the official `openai` SDK with a configurable `baseURL`
  (Ollama `http://localhost:11434/v1`, OpenAI, or the proxy) and `tools`/`tool_calls`.
- **Proxy** is any adapter pointed at a proxy base-URL (key held server-side) — a
  settings change, satisfying FR-5.

### 5.3 Why the tool loop, not one shot

Mirrors CADAM's agentic write→inspect→revise loop but cheaper: the model calls
`build_part`, the browser builds and (on request) returns `inspect_geometry` **text**,
the model fixes selections or dimensions, and finishes with `answer_user`. Bounded by a
step cap. Because our inspection is structured text (faces/edges with normals), we do
**not** need CADAM's render-and-look vision round-trip.

---

## 6. Detailed design

### 6.1 Authoring schema & units (FR-6, FR-7, FR-10)

- A zod **authoring** schema describes a document in **mm/degrees** with a discriminated
  union per feature `type`, mirroring the cases in `rebuild.ts` but human-friendly.
- `toCadDocument(authoring)` converts lengths `mm→m` and angles `deg→rad` (`unit/index.ts`
  `mm`/`deg`), producing the SI `CadDocument`. `toAuthoringDoc(cad)` is the inverse
  (`toMm`/`toDeg`), used to hand the model the current part for **edit mode** (FR-6a).
- Validation runs **before** `loadDocument`. On failure, the structured zod error is the
  `build_part` tool result; the agent retries (cap: default 4, tunable).
- Apply is **atomic**: the new document is validated and built off to the side
  (`GeometryClient.build`) before it replaces the live store, so a bad generation never
  corrupts the current part (FR-21).

### 6.2 `build_part` flow (create + edit)

1. If a part is open and the user's intent is an edit, `agentRunner` injects
   `toAuthoringDoc(currentDoc)` into the system/context so the model edits from the
   real current state (FR-6a).
2. Model emits `build_part({ document })` (the whole updated authoring doc).
3. `schema.ts` validates + converts to SI.
4. `GeometryClient.build(doc)` confirms it compiles; on throw, the per-feature error
   string from `rebuild.ts` (e.g. `feature 'f3' (extrude): …`) is returned to the model.
5. On success → `loadDocument(doc)` → `Viewport` rebuilds and renders; autosave persists.
6. Model may call `inspect_geometry`, issue a follow-up `build_part` (dress-ups), or
   finish with `answer_user`.

### 6.3 Selection — structured-ref feedback loop (FR-11, FR-12)

- `inspect_geometry` builds the current doc and serializes the `TaggedMesh`:
  - faces: `{ index, normal:[x,y,z], centroid:[x,y,z], area, kind:"planar"|"cylindrical"|… }`
  - edges: `{ index, faceNormals:[[..],[..]], midpoint:[x,y,z], length, straight? }`
  (all derived from `FaceGroup`/`TaggedEdge` — `mesh/tagged.ts`).
- The model picks indices; the client resolves index → `FaceRef`/`EdgeRef` and writes
  them into the dress-up feature `data` (`edges`/`faces`/`face`), exactly the shape
  `rebuild.ts` already consumes (`resolveFaceRef`/`resolveEdgeRef`).

### 6.4 Selection — selector-predicate layer (FR-13, FR-14)

- Extend feature `data` to accept a `selector` instead of (or alongside) concrete refs:

  ```ts
  type Selector =
    | { kind: "allEdges" } | { kind: "allFaces" }
    | { kind: "topFace" } | { kind: "bottomFace" }
    | { kind: "largestPlanarFace" }
    | { kind: "edgesParallelTo"; axis: [number, number, number] }
    | { kind: "verticalEdges" }
    | { kind: "faceByNormal"; normal: [number, number, number]; tol?: number };
  ```

- `packages/cad/src/select/predicates.ts` resolves a `Selector` against a freshly
  tessellated `Solid` → `FaceRef[]`/`EdgeRef[]`. `rebuildDocument` resolves any dress-up
  whose `data` carries a `selector`, **before** invoking `fillet`/`chamfer`/`shell`/
  `draft`. Because it re-resolves on every rebuild, predicate selections track parameter
  changes (FR-14).
- The two strategies compose: the feedback loop is how the AI *discovers* geometry when
  a predicate doesn't fit; the predicate is the *durable authored form* preferred when it
  does (e.g. "fillet all top edges").

### 6.5 Creative path — mesh documents (FR-15…FR-18, decisions 15/20)

- **App (not kernel):** `MeshBody` = `{ positions: Float32Array, indices: Uint32Array,
  normals?: Float32Array, material?: {...} }`. `apps/plastiq/src/mesh/importGltf.ts`
  parses GLB/glTF (three.js `GLTFLoader`) into one or more `MeshBody`. This lives in the
  app because `three` is an app dep, not a kernel dep (decision 24).
- **Document kind:** persistence becomes `kind`-discriminated —
  `ParametricDoc (CadDocument)` | `MeshDoc { kind:"mesh", name?, glb /* base64 GLB */,
  source: { mode, providerId, prompt?, imageId? } }`. A generated mesh is a **new
  mesh document** (decision 20), not a feature in a B-rep part. The GLB persists **inline
  as base64** in the document (self-contained, JSON-safe) and geometry is re-derived via
  `importGltf` on load, so the doc reloads reproducibly. (Touches all store backends —
  `persistence/{types,projectsStore,idb,sqlite,memory}.ts`; back-compat: a doc with no
  `kind` loads as parametric.)
- **Rendering is main-thread (no worker round-trip):** mesh bodies do **not** go through
  the OCCT worker or `TransferMesh` (which is B-rep-only). `viewport/buildMesh.ts` +
  `three/Scene.tsx` gain a branch that builds a `THREE.Mesh`/`Group` directly from a mesh
  document; `worker/protocol.ts` is untouched.
- **Three input modes (decision 15):**
  - *text→image→3D*: `ImageGenProvider.generate(prompt)` → image → `MeshGenProvider`.
  - *image→3D*: user image → `MeshGenProvider`.
  - *text→3D*: providers that support direct text→3D.
- **Providers (decision 6, multi-selectable, no default):** `fal.ts` exposes Tripo
  (fast), Meshy v6 (quality/PBR), Hunyuan3D (open); the user selects per job. Each job
  is a paid call and goes through the confirmation gate (FR-18a). `submit → poll` (no
  webhook — Plastiq has no server; fal supports client polling). A webhook-only provider
  would need the proxy (documented, opt-in).

### 6.6 Vision routing (FR-10a, FR-10b)

- The prompt input accepts an image attachment with a **route toggle**: *Parametric
  reference* or *Generate mesh*.
- *Parametric*: the image is sent as an image content block to a **vision-capable**
  `ChatProvider` (Claude) to inform `build_part`. If the active model isn't vision-capable
  (most local Ollama tool-models — R-9), the parametric route is disabled with guidance.
- *Creative*: the image feeds `create_mesh` (image→3D), no LLM vision required.

### 6.7 Prompts (parametric + creative)

- A parametric system prompt teaches the model: emit `build_part` with the authoring
  document; units are mm/deg; when editing, modify the supplied current document; expose
  editable dimensions as named params; prefer predicates for dress-ups, else
  `inspect_geometry`; finish with `answer_user`; never claim a build it didn't make. It
  enumerates the exact feature types + the authoring schema.
- A creative system prompt steers `create_mesh` usage (and recommends the parametric path
  for precise mechanical parts).
- Prompts live in `ai/prompt.ts`, are versioned, and unit-tested for invariants (mentions
  every supported feature type; states mm/deg).

### 6.8 Settings, secrets, first run, cost (FR-4, FR-5a, FR-18a, decisions 17/19/21)

- **First run** shows a neutral chooser (no default). Options: detect-and-use local
  Ollama, or enter a key for Anthropic/OpenAI/other, or set a proxy URL.
- **Settings** stores provider + model + base-URL + keys in IndexedDB (never in
  documents/logs), behind a `keyResolver` indirection so a proxy can supply them later
  with no call-site change (decision 21).
- **Cost:** `usage.ts` accumulates tokens + paid-job counts; the panel shows them; paid
  3D/image jobs pop a one-click confirm; the agent loop has an always-on step cap.

### 6.9 Model catalog & preflight (FR-5b, decision 22)

- `ai/providers/models.ts` holds a curated catalog (Appendix A) per provider with a
  `supportsTools`/`supportsVision` hint; the Settings UI offers the list + a free-text
  field. On selection, `registry.ts` **preflights** tool capability (a cheap tools-enabled
  probe, or the provider's model metadata) and warns if the model can't do tool calling
  (which would break `build_part`).

---

## 7. Data contracts

### 7.1 Tool surface (mirrors CADAM's `build_parametric_model`/`create_mesh`)

| Tool | Input (authoring) | Output | Notes |
|---|---|---|---|
| `build_part` | `{ document: AuthoringDoc /*mm,deg*/ }` | `{ status, message, errors? }` | No server execute; client builds. Edit context supplied via system prompt (FR-6a). |
| `inspect_geometry` | `{}` | `{ faces:[…], edges:[…] }` (text) | From `TaggedMesh`; no image. |
| `create_mesh` | `{ mode:"text2img3d"\|"img3d"\|"text3d", prompt?, imageId?, providerId, quality? }` | `{ meshDocId, status }` | Async; client polls; paid-job confirm gate. |
| `answer_user` | `{ message }` | echoed | Final user-facing text. |

### 7.2 Persisted additions

- `aiStore` settings (global) + **per-project conversation + generation trace** in
  IndexedDB (separate store from `projects`) — decision 14.
- Parametric parts persist as ordinary `CadDocument` via `projectsStore` — **no schema
  change** for the parametric path.
- A `kind`-discriminator is added to the persisted document so **mesh documents**
  (`kind:"mesh"`, inline base64 GLB + generation `source`) persist alongside parametric
  ones (decision 20).

### 7.3 Data-shape transform (parametric, incl. edit)

```text
[edit] currentDoc(SI) → toAuthoringDoc → mm/deg context ─┐
prompt (+image route=parametric) ────────────────────────┤
  → model emits AuthoringDoc(mm,deg)          [zod-validated]
  → toCadDocument()                           [mm→m, deg→rad]
  → CadDocument(SI) → loadDocument            [atomic: build off-thread first]
  → rebuildDocument(oc,doc) → Solid           [worker; selectors → FaceRef/EdgeRef]
  → tessellateTagged → TransferMesh → render
  → IndexedDB (autosave + per-project conversation)
```

---

## 8. Boundaries & failure modes

| Boundary | Mechanism | Auth | Failure handling |
|---|---|---|---|
| Browser → Anthropic | HTTPS + `dangerouslyAllowBrowser` | BYO key (browser) | typed SDK errors surfaced in panel; retry/backoff |
| Browser → Ollama | HTTP `localhost:11434` (openai SDK) | none | CORS hint if blocked; tool/vision-capability warning |
| Browser → proxy | HTTPS base-URL | server-side | same wire; no code change |
| App → image-gen / 3D-gen (fal) | HTTPS submit + **poll** | provider key (BYO→proxy) | paid-job confirm first; timeout/job-failed/GLB-fetch error → user-visible, no doc corruption |
| Main → worker | existing RPC (`bridge.ts`) | n/a | per-feature build error → returned to model |
| AI output → store | zod validate + off-thread build, then atomic apply | n/a | invalid/garbled → returned to model; live doc untouched |

**Silent-failure guardrails:** every catch surfaces to the panel or back to the model;
no swallowed errors; a failed generation is a no-op on the live document.

---

## 9. Milestones

> `R`-series to match house style. Each milestone is independently testable and ends in a
> commit (branch off `main`). No milestone is "done" with stubs.

### R0 — Foundations

- **R0.1** Add deps: `zod`, `@anthropic-ai/sdk`, `openai`. Confirm resolve + browser build.
- **R0.2** `cadDocumentSchema` + authoring schema (mm/deg) + `toCadDocument` / `toAuthoringDoc`. Unit tests round-trip every feature type. **Closes the "no validator" gap.**

### R1 — Provider layer

- **R1.1** `ChatProvider` interface + `StreamEvent`/`ToolDef` types + `usage.ts`.
- **R1.2** `OpenAICompatAdapter` (openai SDK + baseURL) — real call to a local Ollama, tool round-trip.
- **R1.3** `AnthropicAdapter` (`dangerouslyAllowBrowser`, adaptive thinking, streaming, tools, vision).
- **R1.4** `registry.ts` + `models.ts` curated catalog (Appendix A) + tool-capability preflight (FR-5b); Settings panel + IndexedDB key storage behind `keyResolver` (FR-4, decision 21); neutral first-run chooser (FR-5a); proxy = base-URL re-point (FR-5).

### R2 — Parametric generation & editing (the headline)

- **R2.1** `build_part` tool + handler: validate → SI → off-thread build → atomic `loadDocument` (FR-6, FR-7, FR-21).
- **R2.2** Edit mode: `toAuthoringDoc(currentDoc)` context injection (FR-6a).
- **R2.3** `agentRunner` tool loop with step cap + bounded validation-retry + cancellation (FR-18a step cap).
- **R2.4** Parametric system prompt (`prompt.ts`) + `GenerationPanel` side panel + `CommandPalette` (FR-19) + usage meter.
- **R2.5** End-to-end blind authoring + edit of non-dress-up features; verify timeline + slider editing (FR-8, FR-9).
- **R2.6** Per-param unit display (length→mm, angle→deg) in the generic `PropertiesPanel` editor (FR-9a).

### R3 — Selection

- **R3.1** `inspect_geometry` tool: `TaggedMesh` → structured face/edge text (FR-11); index→ref mapping (FR-12).
- **R3.2** Selector-predicate layer in `packages/cad/src/select/predicates.ts` + rebuild integration (FR-13, FR-14).
- **R3.3** AI dress-ups via both paths (fillet/chamfer/shell/sketch-on-face).

### R4 — Creative path (mesh documents) + vision

- **R4.1** `MeshBody` type + `importGltf` (GLTFLoader) in `@plastiq/cad`.
- **R4.2** `kind`-discriminated persistence + **mesh document kind**; worker/transfer/viewport rendering of mesh bodies; B-rep-op-unavailable UX (FR-16, FR-16a, FR-18, decision 20).
- **R4.3** `ImageGenProvider` + `MeshGenProvider` (`fal.ts`: Tripo/Meshy/Hunyuan, selectable) + `create_mesh` (3 modes) + paid-job confirm gate (FR-15, FR-17, FR-18a).
- **R4.4** Vision routing: image attach + route toggle; vision→`build_part` on capable models; disable + guide otherwise (FR-10a, FR-10b).

### R5 — Persistence, hardening & tests

- **R5.1** Per-project conversation/trace persistence (FR-20, decision 14).
- **R5.2** Full deterministic E2E (validation, build, edit, selectors, GLB import, mm→SI, atomic apply, mesh doc). Always-on.
- **R5.3** LLM-boundary E2E against local Ollama (CI) + opt-in keyed Anthropic.
- **R5.4** Docs: README section, in-product help, this spec kept in sync.

---

## 10. Testing requirements

Per repo CLAUDE.md, **E2E must be real** (no mocked components). Strategy:

- **Unit (vitest):** schema validation + mm↔SI conversion (every feature type, both
  directions for edit); selector-predicate resolution against real OCCT solids;
  `importGltf` against real GLB fixtures; model-catalog/preflight logic; prompt invariants.
- **Integration (vitest, real OCCT):** `build_part` handler → `rebuildDocument` →
  tessellation, incl. per-feature error feedback and edit-from-context; `inspect_geometry`
  enumeration; atomic-apply (bad doc leaves live doc intact); mesh-document load/render.
- **E2E (Playwright, no mocks):**
  - *Deterministic pipeline* (always-on): drive the app with **fixed known-good** tool
    inputs through the real handlers (not the LLM) — create, edit, dress-up via predicate,
    and mesh-document import from a real GLB fixture → real worker build → assert rendered
    geometry + timeline + autosave. Exercises every real component except the model.
  - *LLM boundary* (real model, realistic stand-in): run against a **real local Ollama**
    with a tool-capable model in CI — a legitimate no-mock E2E of prompt→tool→document. An
    **opt-in** keyed Anthropic E2E covers the hosted + vision paths (not default CI;
    nondeterministic, costs money, needs a secret).
  - *Creative + cloud-gen path*: E2E against a real fal sandbox/account is **opt-in/manual**
    (external + paid); the deterministic mesh-import/render path is covered always-on with
    real GLB fixtures.
- **Regression rule:** zero regressions to the existing suite; new code ships with its own
  tests; security/validation fixes ship with a regression test (per CLAUDE.md).

> Honesty note: a "replayed/recorded provider" is a mock and must **not** be labeled E2E.
> The model-in-the-loop E2E is the local-Ollama run; everything else at the LLM boundary
> is integration.

---

## 11. Risks (open questions resolved → decisions)

| # | Risk | Mitigation / owner |
|---|---|---|
| R-1 | **Creative/vision-cloud is not no-server.** 3D/image providers need network + account; some webhook-only. | Default to poll-capable providers (fal client polling); document the dependency; opt-in + visually distinct + paid-job confirm. Proxy only for webhook-only providers. |
| R-2 | **Local models author worse CAD.** Small Ollama models emit invalid/poor docs or weak tool use. | zod-validate + bounded self-correction; curated ≥14B suggestions + tool-capability preflight; set expectations in-product. |
| R-3 | **Ollama CORS / tool support.** Browser→localhost needs `OLLAMA_ORIGINS`; not all models do tools. | Detect + actionable guidance; preflight; fail loudly. |
| R-4 | **Key exposure (BYO direct).** Anthropic/fal keys sit in the browser. | User's own keys (documented-acceptable case); IndexedDB only; never log; proxy-later + Ollama for those who won't. |
| R-5 | **Selection brittleness.** Index/ref selection drifts on param change; predicates can't cover every intent. | Ship both; predicates re-resolve each rebuild. |
| R-6 | **Mesh bodies are second-class.** B-rep features can't operate on them. | Separate document kind (decision 20); B-rep ops simply unavailable in the mesh UI; for organic/print/export. |
| R-7 | **Units mismatch.** SI kernel vs. mm authoring → 1000× errors. | Single conversion choke-point (`toCadDocument`/`toAuthoringDoc`); round-trip tests both ways. |
| R-8 | **Cost / runaway loops.** Agentic loop + paid APIs. | Step cap always on; usage meter; confirm-before-paid-job (FR-18a). |
| R-9 | **Vision + tools rarely coexist on local models.** Most Ollama tool-models aren't vision-capable. | Vision→parametric is effectively Anthropic(/cloud)-only; FR-10b disables the route + guides on incapable models; creative image→3D needs no LLM vision. |
| R-10 | **No default provider/model (decision 17) → first-run friction.** | Neutral chooser with researched suggestions (Appendix A) + Ollama auto-detect option; one-time. |
| R-11 | **Three creative modes + no default provider → more surface/keys.** | Providers behind one interface; modes share the pipeline; paid-job confirm bounds spend. |
| R-12 | **Mesh-as-separate-kind blocks mixing** a parametric base with a mesh add-on in one part. | Accepted v1 tradeoff (decision 20); mixing is future work (§13). |

**Resolved open questions:** OQ-1 (history) → decision 14 (per-project). OQ-2 (3D
provider) → decision 6 (multi-selectable, no default; Appendix A). OQ-3 (vision) →
decision 16 / FR-10a (user-routed, in v1).

---

## 12. Security & privacy

- Keys stored client-side (IndexedDB) behind a `keyResolver` indirection, never in
  documents/logs, sent only to the configured endpoint (proxy-later moves them off the
  client).
- AI output is **untrusted**: validated by zod and built off-thread before touching the
  live document; a malicious/garbled document cannot corrupt state or execute anything
  (it's data the worker interprets, not code).
- Creative/cloud-vision paths upload prompt/image to an external service — disclosed
  in-product before first use, behind the paid-job confirm.
- No telemetry of prompts/keys.

---

## 13. Out of scope (v1) / future

- Hosted proxy with auth + billing (client is proxy-ready; service is a follow-on).
- **Mixing mesh bodies and B-rep in one document** (separate kinds in v1 — decision 20).
- AI-driven assemblies/mates; multi-part scenes from one prompt.
- Mesh→B-rep reconstruction (so mesh bodies could feed B-rep features).
- Diff/patch edit protocol (v1 re-emits the whole document on edit — FR-6a).
- Conversation branching à la CADAM message tree (v1 persists a linear per-project trace).

---

## 14. Acceptance criteria (definition of done for SPEC-6 v1)

1. From a text prompt, the app produces a valid `CadDocument` that builds, renders, and
   appears in the timeline with editable parameters — via a user-chosen provider
   (Anthropic BYO key **and** local Ollama both verified). (FR-1…FR-10, FR-5a/5b)
2. With a part open, a prompt **edits** it correctly (the AI worked from the current
   document). (FR-6a)
3. The AI applies a fillet/chamfer/shell to the right edges/faces using both the
   inspection loop and a selector predicate, and the predicate survives a parameter
   change. (FR-11…FR-14)
4. An attached image, routed to parametric, informs a build on a vision-capable model;
   routed to creative, produces a mesh. (FR-10a/10b)
5. The creative path produces a GLB **mesh document** (via text→image→3D, image→3D, and
   text→3D) that renders and exports, behind a paid-job confirm, with the external-service
   dependency disclosed. (FR-15…FR-18a)
6. Invalid AI output never corrupts the live document; errors round-trip to the model.
   (FR-7, FR-21)
7. Conversation/trace persists per project and reloads. (FR-20)
8. Deterministic-pipeline E2E is green and always-on; the local-Ollama LLM-boundary E2E
   is green in CI; zero regressions to the existing suite. (§10)

---

## Appendix A — Researched model catalog (curated defaults; decision 22)

> The picker is **curated list + free-text override**, with a tool-capability preflight.
> Lists are seeded from June 2026 research and are data in `ai/providers/models.ts`
> (editable without code changes elsewhere).

### Chat / parametric (tool-calling required; vision where noted)

| Provider | Curated models | Notes |
|---|---|---|
| Anthropic | `claude-opus-4-8` (quality), `claude-sonnet-4-6` (balanced), `claude-haiku-4-5` (fast) | All support tools + **vision**. Adaptive thinking. |
| Ollama (local) | `qwen3`/`qwen2.5` (14B–32B+), `llama3.3:70b`, `gpt-oss`, `deepseek-r1:32b`, `glm-4.x`, `llama3.1:8b` (fast/dev) | Tool calling native (Ollama ≥0.4). **≥14B recommended** for reliable tool selection; most are **not** vision-capable (R-9). |
| OpenAI / other OpenAI-compatible | free-text (e.g. current GPT tool-models) | Via `openai` SDK + `baseURL`; preflight tools. |

### 3D generation (multi-selectable, no default — decision 6)

| Provider (via fal.ai) | Profile |
|---|---|
| Tripo | Fast, low-cost image→3D (~$0.07/gen); GLB, no PBR. Good everyday option. |
| Meshy v6 | Balanced; text-to-3D + image-to-3D, PBR texturing, broad export. Higher cost/latency. |
| Hunyuan3D | Open model; strong geometry/texture; cost-effective. |

### Image generation (for text→image→3D — decision 15)

Pluggable `ImageGenProvider` (e.g. a fal image model); selectable, BYO key (proxy-later).
Exact default deferred to R4.3 (provider is pluggable, so not load-bearing).

**Research sources:** Ollama tool support / model lists
([Ollama blog](https://ollama.com/blog/tool-support),
[Clawdbook 2026](https://clawdbook.org/blog/openclaw-best-ollama-models-2026));
3D-gen comparison
([3DAI Studio](https://www.3daistudio.com/blog/best-3d-model-generation-apis-2026),
[buildmvpfast June 2026](https://www.buildmvpfast.com/articles/best-llms-2026-guide/3d-modeling-ai)).
