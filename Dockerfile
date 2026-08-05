# tnmtmmorpg — one image holding both halves of the game.
#
# The server needs no build step: Node 24 strips TypeScript types natively,
# so packages/server/src/index.ts is the entrypoint as-written. Only the
# client is compiled, by Vite, into static files that Caddy serves on the VPS.
#
# The image therefore ships two things:
#   /app                  the server, run directly from source
#   /app/public           the built client, extracted at deploy time
#
# Layout matters: loader.ts resolves the features directory relative to its
# OWN location (`../../../features/` from packages/server/src/), so the repo
# structure has to be preserved inside the image rather than flattened.

# ── build: install once, compile the client ────────────────────────────────
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app

# Manifests first, so a dependency-free code change reuses the install layer.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN pnpm install --frozen-lockfile

COPY . .

# Baked into the bundle at build time — the client reads import.meta.env at
# module scope, so this cannot be supplied at container start. Changing the
# domain means rebuilding the image.
ARG VITE_WS_URL="wss://tnmtmmorpg.yy-dev.top/ws"
RUN cd packages/client && VITE_WS_URL="$VITE_WS_URL" npx vite build

# ── runtime ───────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# The whole tree, so pnpm's symlinked workspace packages (@game/shared) keep
# resolving and features/ stays where the loader expects to find it.
COPY --from=build /app ./

# A stable path for the deploy step to copy the client out of.
RUN cp -r packages/client/dist ./public && mkdir -p /app/.data

# World state lives here; mount a volume over it or a redeploy resets the map.
VOLUME ["/app/.data"]

ENV PORT=3010
ENV WORLD_DB=/app/.data/world.sqlite
EXPOSE 3010

CMD ["node", "packages/server/src/index.ts"]
