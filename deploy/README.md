# Deploying

**Live: <https://tnmtmmorpg.yy-dev.top/>**

Merge to `main` → GitHub Actions builds one image, pushes it to GHCR, and
restarts the container on the VPS. Caddy serves the client and proxies the
game socket.

**There are no database migrations, and there never will be** — see the
comment at the top of `packages/server/src/db.ts`. The schema is four
`CREATE TABLE IF NOT EXISTS` statements run at every boot, and components
live in a JSON blob, so a new build never needs the database to change shape.
The only thing deploy has to get right is *not losing the file*: `./data` is
bind-mounted at `/app/.data`. Delete it and you get a fresh world.

## Deploying does not reset the world

A deploy recreates the *container*, but `./data` is a host bind mount, so the
SQLite file outlives it. On boot the server restores every entity — players,
their inventories, NPCs, dropped items — and every tile chunk that has already
been generated.

The seed only decides chunks that do **not exist yet**. Terrain is generated
lazily as players explore, deterministically from `(seed, chunkX, chunkY)`, so
with the seed unchanged the land discovered after a deploy is exactly the land
that would have been there before. The map continues; it is not regenerated.

### Changing WORLD_SEED on a live world does not do what it looks like

The seed is read from the environment on every boot and is **never stored in
the database** — nothing compares it against the world already on disk.

So changing it on a world that has data does not produce a fresh map. It
produces a hybrid: chunks that were already generated keep their old terrain,
because they are persisted, while newly explored ones use the new seed. The
result is a silent seam across the map, with no error and nothing in the logs.

Treat `WORLD_SEED` as write-once. Changing it is only meaningful together with
wiping the world:

```bash
cd ~/tnmtmmorpg
docker compose down
rm -rf data
docker compose up -d
```

That is also the only way to deliberately start over — a redeploy will never
do it for you, however many times you merge.

## What runs where

| | Where | What it is |
|---|---|---|
| Game server | container `tnmtmmorpg-server` | Node 24 running `packages/server/src/index.ts` directly — no build step, WebSocket on 3010 |
| Client | container `tnmtmmorpg-static` | `caddy:2-alpine` serving `~/tnmtmmorpg/public`, extracted from the image at deploy time |
| World state | `~/tnmtmmorpg/data` on the host | SQLite + WAL |

Neither port is published. The shared Caddy reaches both by container name
over the `web` network, so the only way in is through 443.

**Why a second container instead of `file_server` on the shared Caddy:** that
Caddy mounts only its own Caddyfile plus its config/data volumes — it cannot
read the host filesystem at all. That is why the existing `api.autentico.top`
block, which points `root` at `/root/autentico/docs`, returns 404. Every site
that works there is a `reverse_proxy`, so this one is too.

## One-time setup

### 1. GitHub secrets

Settings → Secrets and variables → Actions → **Secrets**:

| Secret | What |
|---|---|
| `VPS_HOST` | hostname or IP |
| `VPS_USER` | ssh user (must be able to run `docker`) |
| `VPS_SSH_KEY` | **private** key, full PEM including header/footer |

`GITHUB_TOKEN` is provided automatically — the workflow uses it to let the VPS
pull the image, which is private because the repo is.

### 2. GitHub variables (optional)

Same page, **Variables** tab. All have working defaults:

| Variable | Default | When to change |
|---|---|---|
| `CADDY_NETWORK` | `web` | the external network Caddy is on — `web`, same as skedoodle |
| `VITE_WS_URL` | `wss://tnmtmmorpg.yy-dev.top/ws` | different domain — this is compiled into the bundle, so changing it needs a rebuild |
| `WORLD_SEED` | `42` | only ever on a *fresh* world — see [above](#changing-world_seed-on-a-live-world-does-not-do-what-it-looks-like) |

### 3. On the VPS

```bash
mkdir -p ~/tnmtmmorpg/data
```

Then paste the block from `deploy/Caddyfile` into `~/caddy/Caddyfile` and
reload:

```bash
docker exec caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

That is the only change to the shared Caddy — no new volumes, no restart, no
compose edit. Both containers join the `web` network it is already on, the
same arrangement as `skedoodle-app`.

That is the whole manual part. Everything after is `git push`.

## Deploying

Merge to `main`, or run the **Deploy** workflow manually from the Actions tab.
The job fails loudly if the container is not running afterwards.

Rolling back is a redeploy of an older image — every build is also tagged with
its commit sha:

```bash
cd ~/tnmtmmorpg
sed -i 's|:latest|:<sha>|' .env      # or edit IMAGE=
docker compose up -d --force-recreate
```

## Checking on it

```bash
cd ~/tnmtmmorpg
docker compose logs -f server     # should print `rate=10.0/s` every 10s
docker compose ps
du -sh data                       # world growth
```

A healthy server logs `[ws] listening on ws://localhost:3010`, then
`[tick] rate=10.0/s` on a loop. If the tick rate sags well under 10, a feature
system is overrunning its 5ms budget — the guard disables it and says so.

## Local

```bash
docker build -t tnmtmmorpg .
docker run --rm -p 3010:3010 -v tnmtmmorpg-data:/app/.data tnmtmmorpg
```

That serves the socket only. For the client, `pnpm dev` is still the way —
the image's copy is built against the production websocket URL.
