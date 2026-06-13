# Deep Code Investigation — The Geometry Rebuild Pipeline

**Date:** 2026-06-08
**Scope:** How a feature/parameter change becomes a rendered solid in Plastiq, end to end.
**Method:** Spine traced and verified by direct reads (Viewport, bridge, protocol, worker, buildMesh, extrude); worker-internals, OCCT kernel, and test coverage fanned out to three read-only sub-agents and spot-verified. Every claim below carries a `file:line`. Verification depth is marked: **[read]** = I read the cited lines; **[agent]** = sub-agent finding I did not line-verify.

---

> **UPDATE — 2026-06-13 (commit 184ea2e): every risk area below is now RESOLVED or
> dispositioned.** R1/R2 (OCCT-heap leaks on error paths) now free their handles in
> `try/finally`; R3 (the coalescing state machine) was extracted to a unit-tested
> `three/coalesce.ts`; R4 (`dispose()`) now rejects in-flight requests; R5 (the
> bridge `{ok:false}` error path) is now tested. R6 (whole-doc clone per RPC) and
> R7 (late response after `terminate()`) are by-design / benign and left as-is.
> Per-item status is annotated inline in §7. *File:line references below reflect
> the 2026-06-08 layout — the worker `facePlane` handler has since moved to
> `worker/geometry.worker.core.ts`.*

## 1. Executive Summary

Plastiq is a parametric CAD app: a document is an ordered **feature history**, and the "truth" of the model is recomputed from scratch (OCCT B-rep kernel, in WebAssembly) every time the history changes. This pipeline is that recompute. It runs entirely off the main thread in a Web Worker, returns a **tagged tessellation** (faces/edges/vertices carry normal-based signatures so selections survive rebuilds — FR-16), and the main thread turns that into a three.js group.

**The architecture is sound and the kernel layer is heavily unit-tested.** The most important findings are not bugs in the happy path but **robustness gaps on the seams**: (1) the main-thread rebuild **coalescing state machine** (`building`/`pending`/`cancelled`/`lastSig`) — the thing that keeps rapid gizmo drags from saturating the worker — has **zero test coverage**; (2) two **narrow WASM-heap leaks** on OCCT error paths (`extrudeToFace`, `facePlane`); (3) `GeometryClient.dispose()` doesn't settle in-flight promises; (4) the worker **error path** (the `{ok:false}` branch) is essentially untested at the bridge layer. *(All four were RESOLVED on 2026-06-13 — see the UPDATE banner above and the per-item status in §7.)*

---

## 2. Entry Points

| # | Entry | Trigger | File:line | Verify |
|---|-------|---------|-----------|--------|
| 1 (primary) | `useCadStore.subscribe` → `rebuild()` | any change to `features` / `params` / `rollbackIndex` whose geometry signature differs from the last build | `Viewport.tsx:211-221` | [read] |
| 2 | initial `void rebuild()` | component mount | `Viewport.tsx:210` | [read] |
| 3 | `client.lower(doc)` via `__plastiqLower` | Simulate / assembly lowering (M4.5) | `Viewport.tsx:136-137`, `bridge.ts:78` | [read] |
| 4 | `client.exportFile(doc, fmt)` via `__plastiqExport` | STEP/IGES/glTF export | `Viewport.tsx:138-141`, `bridge.ts:85` | [read] |
| 5 | `client.facePlane(doc, face)` | on-face sketch camera frame | `Viewport.tsx:~233`, `bridge.ts:93` | [read] |

The recent **feature-edit gizmo** reaches entry #1 through `updateParams` — every drag/scrub/type tick mutates `features`, which is exactly what makes coalescing (Risk R3 below) load-bearing.

---

## 3. Execution Trace (primary build path)

1. **Store mutation** — e.g. `updateParams(id, {height})` returns a new `features` array. `Viewport.tsx:211` subscription fires. **[read]**
2. **Skip filter** — `Viewport.tsx:212-219`: bail if `features`/`params`/`rollbackIndex` are reference-identical, then bail if `geometrySignature(state) === lastSig` (a pure placement/pose change doesn't rebuild geometry). `geometrySignature` = `JSON.stringify(buildFeatures(s).filter(f => f.type !== PLACEMENT_TYPE))` (`Viewport.tsx:111-116`). **[read]**
3. **Coalescing gate** — `rebuild()` (`Viewport.tsx:157-208`): if `building`, set `pending=true` and return; else `building=true`, `setStatus("building")`, snapshot `lastSig` (line 167). **[read]**
4. **Doc assembly** — `buildFeatures(state)` slices to `rollbackIndex` (`Viewport.tsx:101-107`); doc = `{features, params}`. **[read]**
5. **RPC send** — `client.build(doc, deflection=0.0005)` → `send({op:"build", doc, deflection})` → `++seq` id, `pending.set(id, …)`, `postMessage` + 120 s timeout (`bridge.ts:57-69, 72-75`). **[read]**
6. **Worker receive** — `geometry.worker.ts:52-56`: `await getOc()` (lazy, cached OCCT — `:28-29`); `op==="build"` is the **default fallback** after the lower/export/facePlane branches (`:145`). **[read]**
7. **Kernel rebuild** — `rebuildTaggedWithProps(oc, doc, {linearDeflection})` (`geometry.worker.ts:145`) → `rebuildDocument` walks the feature list, `replace()`-ing the current `solid` per feature (`rebuild.ts:125-431`, `replace` at `:132-135`), then `tessellateTagged` + `solid.volume()`/`centreOfMass()`, `solid.delete()` in `finally` (`rebuild.ts:~451-456`). **[agent, spine-consistent]**
8. **Transfer build** — `toTransfer` copies into fresh `Float32Array`/`Uint32Array` (`geometry.worker.ts:31-50`); transfer list = vertices/indices/vertexPositions/edge-positions buffers (`:147-154`); `postMessage({ok:true, op:"build", mesh}, transfer)` (`:155`). **[read]**
9. **Bridge resolve** — `onmessage` matches `res.id` in `pending`, clears timer, resolves (`bridge.ts:39-47`). **[read]**
10. **Apply** — back in `rebuild()`, guarded by `if (!cancelled)`: `setMesh`, `meshRef.current`, `setStatus("ready"/"empty")`, `setErrorFeature(null)`, rebuild `SelectionRefs` from `faceGroups`/`edges` (`Viewport.tsx:170-187`), `setMassProps` (`:188-192`). **[read]**
11. **Render** — `<Viewport3D mesh>` → `<Scene mesh>` → `buildPart(transfer)` builds one `BufferGeometry` with a render group per face + a `LineSegments` per edge + a `Points` cloud, tagging `userData.faceIds/edgeId/vertexIds` for picking (`buildMesh.ts:47-112`). Prior part freed via `disposePart` (`buildMesh.ts:115-126`). **[read]**
12. **finally** — `building=false`; if `pending`, clear it and re-enter `rebuild()` (reads the *latest* store state) (`Viewport.tsx:201-207`). **[read]**

---

## 4. Data-Flow / Shape Transformation

```
CadStore.features (EditorFeature[])           Viewport.tsx:164-166
  ↓ buildFeatures() — slice to rollbackIndex
CadDocument {features, params}                Viewport.tsx:166      [read]
  ↓ structured-clone across postMessage (whole doc copied every call — no transfer)  protocol.ts:34 / geometry.worker.ts  [read]
  ↓ rebuildDocument() — feature loop, OCCT B-rep
Solid (TopoDS_Shape, WASM heap)               rebuild.ts:126        [agent]
  ↓ tessellateTagged()
TaggedMesh {vertices:number[], indices:number[], faceGroups, edges, vertexPoints}   [agent]
  ↓ toTransfer() — number[] → typed arrays (FRESH buffers)
TransferMesh {Float32Array vertices, Uint32Array indices, faceGroups[], edges[], vertexIds[], vertexPositions, volume?, com?}   protocol.ts:13-29 / geometry.worker.ts:31-50   [read]
  ↓ postMessage(…, transfer[]) — buffers DETACHED to main thread     geometry.worker.ts:147-155   [read]
  ↓ buildPart()
BuiltPart {group, mesh(per-face groups), edges[LineSegments], vertexPoints}   buildMesh.ts:21-32,47-112   [read]
  → rendered; faceGroups.normal & edges.faceNormals become SelectionRefs   Viewport.tsx:177-184   [read]
  → {volume, com} → store.massProps   Viewport.tsx:188-192   [read]
```

**Lossy / notable:** face/edge **IDs are NOT stable across rebuilds** — they're assigned by tessellation iteration order each time; persistence is carried by the *normal signatures* (`FaceRef.normal`, `EdgeRef.faceNormals`) which re-resolve within a dot-product tolerance (`FACE_DOT_TOL ≈ 0.999`, ~2.6°). A large topology change can rotate a face normal past tolerance → the persistent ref returns `null` → the dependent feature throws (`feature '<id>' …`). **[agent]**

---

## 5. Boundary Analysis

| # | From → To | Mechanism | Correlation | Error handling | Timeout | Data contract |
|---|-----------|-----------|-------------|----------------|---------|---------------|
| 1 | Store → Viewport | `zustand.subscribe` | n/a (sync) | none (pure read) | n/a | `{features, params, rollbackIndex}` `Viewport.tsx:211` [read] |
| 2 | Main → Worker | `postMessage` (structured clone; **no** transferables outbound) | `++seq` id, `pending` Map | `onerror` rejects **all** pending (`bridge.ts:48-54`); per-req 120 s timeout (`:61-65`) | 120 s | `WorkerRequest` union `protocol.ts:73` [read] |
| 3 | Worker → Main | `postMessage` + transfer list | echoes `req.id` (`geometry.worker.ts:155,91,108,119,…`) | single try/catch → `{ok:false,error:string}` (`:156-162`) | n/a (main side) | `WorkerResponse` union `protocol.ts:75-87` [read] |
| 4 | JS → OCCT (WASM) | `opencascade.js` calls | sync | throws `Error` (message preserved); error-path leaks fixed 2026-06-13 (R1/R2) | n/a | `Occt` typed surface [read/agent] |

**Contract checks:**
- Sender/receiver shapes match: `bridge.build()` narrows on `res.ok && res.op==="build"` (`bridge.ts:74`); other ops throw "unexpected worker response" on mismatch (`:80,87,95`). **[read]**
- Error string is preserved verbatim across the boundary (`geometry.worker.ts:160` → `bridge.ts:46`), so the main thread's `/feature '([^']+)'/` extraction works (`Viewport.tsx:198`). **[read]**
- Unknown response id is silently dropped (`bridge.ts:42`) — safe given sequential ids. **[read]**
- **No OCCT re-entrancy:** `rebuildTaggedWithProps`/`rebuildDocument` are synchronous; once a worker IIFE passes `await getOc()`, the kernel work runs to completion without yielding, so concurrent build/lower/facePlane messages serialize naturally even though the worker doesn't queue them explicitly. **[read]**

---

## 6. Dependency Graph

**This pipeline depends on:** `@plastiq/cad` (OCCT kernel ops + tessellation + io + faceFrame + resolveFaceRef), `./rebuild.js`, `./lower.js`, the OCCT `.wasm` (`?url` import, ~50 MB, `bridge.ts:19`), `useCadStore` (state + `setStatus`/`setMassProps`/`setSelectionRefs`/`setErrorFeature`), `useProjectsStore` (thumbnail provider), three.js (`buildMesh`).

**Depends on this pipeline:** `Scene`/`Part`/`Assembly` (render the mesh), `Picking` (reads `userData.faceIds`/`edgeId`/`vertexIds`), the **feature-edit gizmo** (live preview via `massProps` + the rebuild), `PropertiesPanel` (`massProps`), the section/measure tools, export & simulate flows.

---

## 7. Risk Areas

**R1 — WASM-heap leak in `extrudeToFace` on error path. [read, confirmed]**
`packages/cad/src/action/extrude.ts:91-97`: `resolveFaceRef` → `face`, then `SurfaceProperties_1`/`CentreOfMass` with no `try/finally`. If any throws, `face` (and `props`/`com` before their `.delete()`) leak. Narrow (only when surface-props fails on a resolved face), single face per failure, not in a loop.
**✅ RESOLVED 2026-06-13 (184ea2e):** `extrudeToFace` now frees `face` + the GProp props in a `try/finally` on every exit. (The throw branch isn't deterministically reproducible without mocking OCCT; the fix is structural and the happy path is tested.)

**R2 — Same pattern in the worker's `facePlane`. [read, confirmed]**
`apps/plastiq/src/worker/geometry.worker.ts:123-142`: `face = resolveFaceRef(…)`, `faceDatumPlane(oc, face)` (line 128), `face.delete()` (line 129); the `finally` (140-142) frees only `solid`. If `faceDatumPlane` throws, `face` leaks.
**✅ RESOLVED 2026-06-13 (184ea2e):** the `facePlane` handler (now in `worker/geometry.worker.core.ts`) frees `face` in a `finally`; `faceDatumPlane` (`mesh/faceFrame.ts`) also frees its own GProp props on throw.

**R3 — Rebuild coalescing state machine is untested. [read + agent]**
`Viewport.tsx:152-221`. The `building`/`pending`/`cancelled`/`lastSig` logic is the core of the architecture (it collapses a burst of gizmo ticks into the latest single rebuild) and has **no** unit or integration test. Logic review found no concrete defect, but its untested status is the single highest-value gap given how much now drives it (every gizmo drag).
**✅ RESOLVED 2026-06-13 (184ea2e):** the `building`/`pending`/`cancelled` machine was extracted to `three/coalesce.ts` (`createCoalescer`) and unit-tested in `coalesce.test.ts` (idle run; a burst collapses to exactly ONE trailing run; cancelled suppresses the trailing run; non-overlapping calls each run). `Viewport` now uses it; behavior preserved (65 E2E pass).

**R4 — `GeometryClient.dispose()` doesn't settle in-flight promises. [read, confirmed]**
`bridge.ts:100-104` clears timers + the `pending` map and terminates the worker, but never `reject`s outstanding promises. An `await client.build()` in flight at unmount **hangs forever**; harmless to the user (`cancelled` guards the `.then`), but the suspended async closure is retained. (Contrast `onerror`, which *does* reject all pending — `:48-54`.)
**✅ RESOLVED 2026-06-13 (184ea2e):** `dispose()` now rejects each in-flight request (`new Error("geometry worker disposed")`) before terminating; tested in `bridge.test.ts`.

**R5 — Worker error path undertested at the bridge. [agent, spot-verified]**
`bridge.test.ts` covers only the timeout path; the `{ok:false, error}` reject branch (`bridge.ts:46`) and the worker's catch-all (`geometry.worker.ts:156-162`) have no direct test. The *kernel* error messages are well tested in `rebuild.test.ts`, and one E2E (`extrude-guard.spec.ts`) *prevents* errors rather than exercising the handler — so the user-visible `setStatus('rebuild failed…')` + `setErrorFeature()` path (`Viewport.tsx:194-200`) is not asserted anywhere.
**✅ RESOLVED 2026-06-13 (184ea2e):** `bridge.test.ts` now asserts the `{ok:false}` reply rejects `build()` with the worker's error message (and that `dispose()` rejects pending requests). The worker's catch-all is also exercised via `geometry.worker.core.test.ts` (e.g. lower/export with no geometry → error response).

**R6 — Whole `CadDocument` is structured-cloned on every RPC. [read]**
`protocol.ts:34` / `geometry.worker.ts`: no delta or buffer reuse outbound. Fine today; a perf/GC concern for very large feature trees under rapid edits.
**Disposition — by design, not changed:** sending the document to the worker is intrinsic to the RPC; there is no defect. A future delta/transfer optimisation remains possible but is not warranted now.

**R7 — Worker termination/unmount race. [agent]**
A worker response arriving between `terminate()` and thread teardown is dropped; combined with R4 this is benign but means late results vanish silently rather than being cancelled explicitly.
**Disposition — benign, now moot:** with R4's fix `dispose()` rejects all pending entries, so there are no in-flight requests left for a late response to race against. Left as-is.

---

## 8. Open Questions (need runtime data / human knowledge)

1. **Actual WASM-heap trend over a long editing session** — the kernel `.delete()` audit looks clean except R1/R2, but nothing measures real `HEAP` growth across thousands of rebuilds. Only runtime profiling answers this.
2. **Coalescing under real gizmo-drag cadence** — does a fast drag actually collapse to ~1 rebuild per frame, or does the worker still queue a backlog? Needs a perf trace, not code reading.
3. **FaceRef/EdgeRef tolerance in practice** — how often does a legitimate edit rotate a normal past `FACE_DOT_TOL` and orphan a downstream fillet/sketch? Needs telemetry on real models.
4. **First-build wasm load (~50 MB)** — real cold-start time and whether the 120 s timeout is ever approached on slow connections.

---

## Appendix — verification ledger

- **Read directly:** `Viewport.tsx:100-230` (rebuild loop, signatures), `bridge.ts:1-105` (full), `protocol.ts:1-88` (full), `geometry.worker.ts:1-165` (full), `buildMesh.ts:1-127` (full), `extrude.ts:78-106`.
- **Sub-agent (Explore), spot-verified:** worker-boundary map, OCCT kernel feature-loop + `.delete()` audit, test-coverage map. The R1 leak (flagged by the kernel agent) and the worker-boundary error path were independently re-read and confirmed; R2 was found during my own read of the worker.
</content>
</invoke>
