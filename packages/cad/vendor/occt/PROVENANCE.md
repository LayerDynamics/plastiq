# Vendored: trimmed OpenCascade (OCCT) WebAssembly

`plastiq-occt.{js,wasm,d.ts}` is a **custom, trimmed build** of
[`opencascade.js`](https://ocjs.org) (OCCT → WebAssembly), produced from
[`../../occt.build.yml`](../../occt.build.yml) by the official builder image.

## Why

The full prebuilt `opencascade.js` wasm is ~48 MB raw / **~13.7 MB gzip** — it
exposes thousands of OCCT classes, almost none of which the kernel calls. This
trimmed build binds **only the OCCT symbols `@plastiq/cad` actually uses** (see
`occt.build.yml`); LTO + `--gc-sections` dead-strips everything unreachable from
those bindings at link time. The 2026-08-03 artifact is **19,476,078 bytes raw /
5,959,776 bytes gzip** — the shipped browser payload remains about 56% smaller
than the full prebuilt gzip.

Nothing is removed from the project: the full `opencascade.js` npm package stays
a dependency (it supplies the TypeScript API types and is the **source** for this
build). `src/oc/init.ts` loads these vendored files in both Node and the browser.

## How it was built / how to rebuild

```sh
just cad-occt   # docker run donalffons/opencascade.js:<pinned> occt.build.yml
```

Requires Docker with **≥ ~12 GB memory** — the final link does monolithic LTO
over the whole OCCT object tree and OOMs on the 8 GB default (it ran here on amd64
under QEMU emulation on Apple Silicon).

The recipe is fully automated: it copies `occt.build.yml` into the gitignored
staging dir `packages/cad/build/occt/`, runs the builder there (the image writes
to its own working directory, so mounting `packages/cad` directly would litter
the package root), and copies `plastiq-occt.{js,wasm,d.ts}` into THIS directory,
overwriting these files. Review the generated artifact diff, then run
`./node_modules/.bin/vitest run packages/cad/src/oc/bindings.test.ts` to confirm
the new trim still binds every required symbol. Ask before committing it.

## The symbol list (occt.build.yml) — three layers

`occt.build.yml` lists every symbol that must be bound. It is verified against
the trimmed wasm by the binding pin, focused real-kernel tests, the full test
suite, and browser E2E; a missing symbol normally surfaces as an embind
`UnboundTypeError`. Three layers are required:

1. **Leaf API classes/enums** the kernel calls via `oc.X` or holds as a return
   value (`BRepPrimAPI_MakeBox`, `BRepFeat_MakePrism`, `LocOpe_LinearForm`,
   `BRepExtrema_DistShapeShape`, `gp_Pnt`, `Poly_Triangulation`, the STEP/IGES
   readers and writers, the `GeomAbs_*`/`TopAbs_*` enums, …).
2. **Base classes** — embind needs the full inheritance chain bound, or
   constructing a derived class throws `unbound types: <Base>`
   (`Standard_Transient`, `BRepBuilderAPI_MakeShape`, `BRepPrimAPI_MakeSweep`,
   the boolean/fillet/offset bases, `Geom_Geometry`, `NCollection_*`, …).
3. **`Handle_<T>` wrappers** — methods returning/taking a smart pointer need the
   handle bound, not just the class (`Handle_Poly_Triangulation` for
   `BRep_Tool.Triangulation`, the `Handle_Geom_*` curve handles, …).

If a kernel change touches a new OCCT symbol, add it (plus any new base/handle it
pulls in), rebuild, and re-run `./node_modules/.bin/vitest run` — a missing entry
fails loud.

## License

The vendored `plastiq-occt.{js,wasm,d.ts}` build is derived from Open CASCADE
Technology (OCCT) via `opencascade.js`, whose package metadata declares
`LGPL-2.1-only` (see `apps/plastiq/node_modules/opencascade.js/package.json`).
Upstream OCCT is published by Open Cascade SAS under the GNU Lesser General
Public License version 2.1 with the additional "Open CASCADE Exception
(version 1.0)"; the `opencascade.js` npm package ships the plain LGPL-2.1
text as its `LICENSE` file.

The complete, verbatim GNU LGPL-2.1 text is included alongside this file as
[`LICENSE_LGPL_2_1.txt`](./LICENSE_LGPL_2_1.txt). These vendored artifacts
remain under that license — the repository's first-party PolyForm
Noncommercial license (root `LICENSE`) does **not** apply to them. The wasm
module is a separable, replaceable artifact: it can be rebuilt or swapped
independently of the first-party code via `just cad-occt` as described above
(see also the root `THIRD-PARTY-NOTICES.md`).
