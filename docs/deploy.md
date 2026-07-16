# Deploying Plastiq (self-host)

Plastiq is a fully client-side app: the production build is a static bundle
(HTML + JS + wasm) that any web server can host. There is no required backend —
AI generation calls the provider the user configures in-app (BYO key), and
persistence is in-browser (IndexedDB/sql.js). Self-hosting is therefore just
"serve `apps/plastiq/dist/` correctly".

## Option A: Docker (recommended)

A multi-stage image (`deploy/plastiq-web/Dockerfile`) builds the workspace with
pnpm and serves the result with nginx (`deploy/plastiq-web/nginx.conf`).

```bash
just app-docker-build   # docker build -f deploy/plastiq-web/Dockerfile -t plastiq-web .
just app-docker-run     # docker run --rm -p 8080:80 plastiq-web
```

Then open <http://localhost:8080>.

What the nginx config guarantees (all load-bearing):

- **`application/wasm` Content-Type** — `WebAssembly.instantiateStreaming`
  hard-fails on any other type.
- **Precompressed gzip** (`gzip_static`) — `.gz` siblings are generated at
  image build time with `gzip -9`, so the big wasm payloads are compressed
  once, not per request. Runtime `gzip` stays on as a fallback.
- **Caching** — hashed `/assets/*` files are `public, max-age=31536000,
  immutable`; `index.html` is `no-cache` so redeploys are picked up on the
  next page load.
- **SPA fallback** — unknown paths serve `index.html`. The app is
  single-route today, so this is purely defensive.

The build context is filtered by `deploy/plastiq-web/Dockerfile.dockerignore`
(BuildKit reads the `<Dockerfile>.dockerignore` next to the Dockerfile); it
excludes `node_modules`, the `./local` benchmark mount, Python services, etc.

### Brotli upgrade path

`nginx:alpine` ships without the brotli module, so the image uses gzip.
Brotli typically shaves another 10–20% off these wasm payloads. To upgrade: swap the serve stage's base image for one with
`ngx_brotli` compiled in (e.g. build nginx with
[google/ngx_brotli](https://github.com/google/ngx_brotli), or front the
container with a brotli-capable proxy such as Caddy or Cloudflare), add
`brotli_static on;` next to `gzip_static on;`, and generate `.br` siblings in
the builder stage alongside the `.gz` ones (`brotli -q 11 -k`).

## Option B: bare build + any static server

```bash
pnpm install
pnpm run build          # tsc --noEmit + vite build → apps/plastiq/dist/
```

Serve `apps/plastiq/dist/` with any static file server, provided it:

1. serves `.wasm` as `application/wasm` (streaming compilation fails otherwise);
2. ideally compresses responses (see sizes below) and caches `/assets/*`
   aggressively while keeping `index.html` uncached.

For a quick smoke test, `pnpm --filter @plastiq/app run preview` serves the
built bundle locally with correct MIME types.

## Cross-origin isolation: NOT required (by design)

Every vendored/bundled wasm build is **single-threaded**: MuJoCo is the
official single-thread export (see `packages/sim/vendor/mujoco/PROVENANCE.md`
— the `./mt` multithreaded build is deliberately not vendored), and OCCT,
sql.js, and planegcs are likewise thread-free. No `SharedArrayBuffer` is used,
so the app works from a plain static host **without**
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers.

**Warning:** if a multithreaded wasm build is ever adopted, browsers will
refuse to give it `SharedArrayBuffer` unless the server starts sending:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

That is a deployment-breaking change for hosts that can't set headers (e.g.
plain object storage) — flag it in review if it comes up.

## Bundle size expectations

The built `dist/` is ~33 MB raw; with compression the initial transfer is far
smaller. The heavy assets (all lazy-loaded hashed files under `/assets/`):

| Asset | Raw | gzip |
| --- | --- | --- |
| OCCT kernel (`plastiq-occt-*.wasm`) | ~18 MB | ~5.6 MB |
| MuJoCo (`mujoco-*.wasm`) | ~9.1 MB | ~2.3 MB |
| sql.js (`sql-wasm-*.wasm`) | ~660 KB | ~326 KB |
| planegcs (`planegcs-*.wasm`) | ~508 KB | ~177 KB |

First load on a cold cache downloads several MB (dominated by OCCT); the
immutable caching makes every subsequent load near-instant.

## Optional Python services

The core app needs none of these. They back the mesh→B-rep reconstruction
pipeline and run separately (each has its own setup guide):

| Service | Port | Guide |
| --- | --- | --- |
| `services/reconstruct` | 8000 | `services/reconstruct/README.md` |
| `services/capture` | 8001 | `services/capture/README.md` |
| `services/nerf` | 8002 | `services/nerf/README.md` |

## Future SaaS note

The AI-provider layer already has the seam a hosted offering would need:
API keys resolve through a swappable `KeyResolver`
(`apps/plastiq/src/ai/settings.ts:84-95`) — `localKeyResolver` returns the
user's BYO key today, and `proxyKeyResolver` returns no key so a hosted proxy
could inject credentials server-side. Nothing hosted exists yet; this note
only records where such a deployment would plug in.
