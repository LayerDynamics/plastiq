# @plastiq/recon

Browser client for `services/reconstruct` (mesh GLB → B-rep STEP).

```ts
import { reconstructMesh } from "@plastiq/recon";

const { step, report } = await reconstructMesh(glbBase64, {
  baseURL: "http://localhost:8000",
  method: "auto",
});
```

The app wraps `step` as a CadDocument via `stepToImportDocument` in `apps/plastiq/src/ai/reconstruct.ts`.
