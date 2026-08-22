# Production image for the single Fastify process that serves BOTH the API and
# the built SPA (same-origin — see DEPLOY.md's architecture note; there is no
# CORS story here and there must not need to be one).
#
# Two stages: the builder carries pnpm and the whole workspace; the runtime
# carries two build outputs and nothing else. No node_modules, no tsx, no
# package manager, no source. Pinned by digest, as compose.yaml pins Postgres —
# a floating tag is a supply-chain hole wearing a convenience's clothes.

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder

WORKDIR /build

# corepack pins pnpm to package.json's `packageManager` field, exactly as CI does.
RUN corepack enable

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. `--frozen-lockfile` makes an out-of-date lockfile a build failure
# rather than a silent resolution.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# The SPA, then the server bundle. Both are plain build outputs; neither needs
# the database or any secret, so nothing sensitive can be baked into the image.
RUN pnpm --filter @campaign-settings/web build \
 && pnpm --filter @campaign-settings/server build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

# `node` (uid 1000) ships with the image. Used rather than created so the
# uid is stable across base-image bumps — the uploads volume is chowned to it,
# and a uid that moved would orphan every file already on that volume.
WORKDIR /app

COPY --from=builder --chown=node:node /build/packages/server/dist/server.mjs ./server.mjs
# The operator CLI, bundled the same way. Without it a fresh public stack has no
# way to make its first owner account except by opening public signup:
#   docker compose -f compose.prod.yaml run --rm app node create-account.mjs <name>
COPY --from=builder --chown=node:node /build/packages/server/dist/create-account.mjs ./create-account.mjs
COPY --from=builder --chown=node:node /build/packages/web/dist ./web

# Uploads live on a named volume mounted here. Created (and owned) in the image
# so the app can write even on the very first boot, before anything has been
# mounted over it.
RUN install -d -o node -g node -m 700 /var/lib/campaign-settings/uploads

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    WEB_DIST_DIR=/app/web \
    UPLOADS_DIR=/var/lib/campaign-settings/uploads

# HOST is 0.0.0.0 rather than 127.0.0.1 because the only route in is Caddy on
# the compose network. The port is deliberately NOT published to the host — see
# compose.prod.yaml, where `expose` replaces `ports` for exactly this reason.
EXPOSE 8787

USER node

# The same liveness probe the private deploy uses. Node rather than curl/wget,
# which this image does not ship and which would be one more thing to keep
# patched for the sake of a health check.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot (main.ts), so there is no separate migrate step and no
# entrypoint script to get wrong.
CMD ["node", "server.mjs"]
