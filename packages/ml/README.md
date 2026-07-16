# @plastiq/ml (reserved scaffold)

**Status:** intentionally empty — not a shipping client.

## What this package is for

Future home for **shared submit→poll + cancel helpers** only, if/when the five
domain clients are refactored to share one HTTP loop. Until then:

| Domain client | Package / path |
|---------------|----------------|
| Capture | `@plastiq/capture` |
| NeRF | `@plastiq/nerf` |
| NURBS | `@plastiq/nurbs` |
| Photogrammetry | `@plastiq/photogrammetry` |
| Reconstruct | `@plastiq/recon` (extracted) |

Service pipelines live under `services/*` (Python).

## Not a defect

An empty `packages/ml` is **not** a missing product feature. Do not treat this
README as a promise of a mega-package. Domain APIs stay in the packages above.
