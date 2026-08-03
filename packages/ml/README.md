# @plastiq/ml

Shared **submit→poll + cancel** primitives for Plastiq’s five domain ML clients.

## What this package exports

| Export | Role |
|--------|------|
| `JobClientOptions` / `JobCancelOptions` / `JobState` | Common connection, poll, and cancel knobs |
| `cancelServiceJob` | `DELETE /jobs/{id}` (204/404 ok; bearer when `apiKey` set) |
| `serviceHttpError` | Stable FastAPI-detail error strings |

Domain packages own request/result payloads and still ship their own `cancelJob` /
`onJob` wrappers:

| Domain client | Package |
|---------------|---------|
| Capture | `@plastiq/capture` |
| NeRF | `@plastiq/nerf` |
| NURBS | `@plastiq/nurbs` |
| Photogrammetry | `@plastiq/photogrammetry` |
| Reconstruct | `@plastiq/recon` |

Service pipelines live under `services/*` (Python).

## Not a mega-package

This is **not** a single HTTP client for all ML features. Pipelines and wire
schemas stay domain-local; only the shared job lifecycle helpers live here so
cancel/onJob/auth cannot drift across clients.
