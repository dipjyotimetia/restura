# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────────────
# Restura self-hosted image — single Node 24 process serving the SPA and the
# /api/* Worker endpoints from one port. Multi-stage build keeps the runtime
# image small; only the compiled output + production node_modules ship.
# ──────────────────────────────────────────────────────────────────────────────

# ──────── Stage 1: deps ──────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# Copy lockfile + manifest only so this layer caches across source changes.
# `cli/` and `echo/` are independent subprojects (no workspaces) so the root
# install doesn't need their manifests.
COPY package.json package-lock.json ./

# Skip electron-builder postinstall — we don't ship Electron from this image.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --ignore-scripts


# ──────── Stage 2: build ─────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
ENV VITE_IS_DOCKER_BUILD=true

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 1. Build the SPA without the Cloudflare plugin — output goes to dist/web/
RUN npm run build:web:docker

# 2. Bundle the Node entry to dist/server/index.mjs. `--packages=external`
#    keeps node_modules out of the bundle so they can be installed once in
#    the runtime stage rather than re-bundled.
RUN npm run build:server


# ──────── Stage 3: runtime ───────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV RESTURA_STATIC_ROOT=/app/dist/web

# Install only production dependencies — no devDeps, no electron-builder.
COPY package.json package-lock.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

# Copy compiled outputs.
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web

# Drop privileges. node:24-alpine ships a `node` user (uid 1000) already.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness probe — wget is part of busybox in node:24-alpine. Falls through
# to docker-compose `healthcheck:` when set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "dist/server/index.mjs"]
