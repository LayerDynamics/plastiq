# syntax=docker/dockerfile:1
# Plastiq self-host image: build the static SPA, serve it with nginx.
#
# Build from the REPO ROOT (the workspace packages @plastiq/cad|sim|nerf are
# consumed as TypeScript source, so the whole workspace is the build input):
#
#   docker build -f deploy/plastiq-web/Dockerfile -t plastiq-web .
#
# Context filtering lives in Dockerfile.dockerignore next to this file
# (BuildKit picks up `<Dockerfile>.dockerignore` automatically).

# --- Stage 1: build ------------------------------------------------------------
FROM node:24-alpine AS builder

# Pin pnpm to the workspace's `packageManager` version (root package.json).
RUN npm install -g pnpm@10.32.1

WORKDIR /repo

# The workspace is interdependent (lockfile importers cover apps/* + packages/*),
# so copy the filtered context wholesale rather than trying to layer manifests.
COPY . .

RUN pnpm install --frozen-lockfile

# Root "build" script = tsc --noEmit + vite build of @plastiq/app.
RUN pnpm run build

# Precompress the large assets so nginx's gzip_static serves them without
# re-compressing per request (OCCT wasm is ~17 MB raw / ~5.3 MB gz, MuJoCo
# ~8.7 MB / ~2.2 MB). -k keeps the originals for clients without gzip support.
RUN find apps/plastiq/dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
         -o -name '*.json' -o -name '*.wasm' \) \
      -exec gzip -9 -k {} \;

# --- Stage 2: serve ------------------------------------------------------------
FROM nginx:alpine

COPY deploy/plastiq-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/plastiq/dist /usr/share/nginx/html

EXPOSE 80
# nginx:alpine's entrypoint already runs `nginx -g "daemon off;"`.
