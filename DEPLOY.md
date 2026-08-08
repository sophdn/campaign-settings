# Deploying CampaignSettings to your-server (Tailscale)

This is the runbook for the **ops half** of the deploy. The **code half** — a real
server entrypoint (`packages/server/src/main.ts`) and a `/api/health` liveness
probe — is already in the repo and smoke-tested against a real Postgres. Everything
below runs **on the server** (`ssh youruser@your-server`), adapt paths to taste.

## Architecture (one box, one process, one Tailscale origin)

```
Tailscale HTTPS :8443  ──▶  fastify (node) 127.0.0.1:8787  ──/api──▶  routes
                                                           ──/────▶  SPA (@fastify/static)
                                                            └──────▶  Postgres (docker, localhost)
```

- A **single process** serves both the API (`/api/*`) and the built web SPA
  (`packages/web/dist`, via `@fastify/static` with index.html fallback for
  client-side routes). Set `WEB_DIST_DIR` to enable static serving; unset = API
  only. Bound to `127.0.0.1` — Tailscale is the only ingress. Migrations run on boot.
- The API client uses a **relative `/api` base** with `credentials: 'include'`,
  so same-origin "just works" — no CORS, no base-URL config. Tailscale just
  proxies the one port; no path routing needed.

## Why `node --import tsx`, not a bundle

The codebase uses bundler-style imports (directory + extensionless), so raw
`node main.ts` can't resolve them. `tsx` (already a vetted dependency) is the
loader: `ExecStart=node --import tsx …` keeps the systemd unit on the `node`
binary with **zero new dependencies and no build step**. If you'd rather ship a
compiled artifact, the alternative is a one-line esbuild/vite SSR bundle to
`dist/server.mjs` + `ExecStart=node dist/server.mjs` — say the word and I'll wire
it; tsx is the simpler default.

## 1. Prerequisites on the box

- Node **>= 24** (`node --version`) — required for native TS + `node:sqlite`.
- `pnpm` (install only, not at runtime), `postgresql`, `tailscale` (already up).

## 2. Get the code + install

```bash
sudo mkdir -p /opt/campaign-settings && sudo chown "$USER" /opt/campaign-settings
git clone https://github.com/sophdn/campaign-settings /opt/campaign-settings
cd /opt/campaign-settings
pnpm install --frozen-lockfile     # build deps once; not run at boot
```

## 3. Postgres

```bash
sudo -u postgres psql -c "CREATE USER campaign WITH PASSWORD '<pick-a-strong-pw>';"
sudo -u postgres psql -c "CREATE DATABASE campaign OWNER campaign;"
```

Migrations run automatically the first time the service starts — no manual
migrate step.

## 4. Environment file `/etc/campaign-settings.env`

```ini
DATABASE_URL=postgres://campaign:<pw>@127.0.0.1:5432/campaign
SESSION_SECRET=<openssl rand -hex 32>     # MUST be >= 32 chars
NODE_ENV=production                        # flags the session cookie Secure
PORT=8787
HOST=127.0.0.1
SESSION_TTL_DAYS=30
WEB_DIST_DIR=/opt/campaign-settings/packages/web/dist
UPLOADS_DIR=/var/lib/campaign-settings/uploads
```

`chmod 600` it (it holds the DB password + session secret).

`UPLOADS_DIR` is where uploaded images live. It defaults to `.uploads` inside the
server package, which a `git pull`-based deploy will happily leave in place but
which nothing is watching — set it explicitly to a path outside the checkout, and
create it owned by the service user:

```bash
sudo install -d -o <service-user> -g <service-user> -m 700 /var/lib/campaign-settings/uploads
```

The resource ceilings are also environment-configured and default to values sized
for a demo: `MAX_MEDIA_BYTES_PER_WORLD` (100 MB), `MAX_IMAGE_BYTES` (5 MB),
`MAX_MAP_IMAGE_BYTES` (25 MB), `MAX_THUMBNAIL_BYTES` (512 KB).

## 5. First account (operator CLI)

```bash
cd /opt/campaign-settings
set -a; . /etc/campaign-settings.env; set +a
CS_ADMIN_PASSWORD='<owner-pw>' \
  pnpm --filter @campaign-settings/server exec tsx scripts/create-account.mts <owner-username>
```

The password is read from `CS_ADMIN_PASSWORD` (or prompted) — never on argv.

### Renaming a world: no script, on purpose

There is no `rename-world.mts`, and there should not be one. A world's owner
renames it in the app — **Settings** in the world's own rail — which is the only
path, and the same one every owner has.

This is worth writing down because two throwaway scripts were written, run, and
deleted on 2026-07-31 to rename a world and hand another one over. Both existed
for the same reason: there was no route that changed a world's name. There is
now (`PATCH /api/worlds/:worldId`), so a third throwaway would be re-solving a
solved problem, and a _supported_ script would be a second caller of the slug
logic waiting to drift from the endpoint's.

The case a script would cover is an owner who cannot reach their own world. That
is a lockout, and renaming is not its remedy: transfer the world to a member
(**Members → Transfer ownership**), or restore the account with the tooling
above.

## 6. Build the web SPA

```bash
cd /opt/campaign-settings
pnpm --filter @campaign-settings/web build      # -> packages/web/dist
```

## 7. systemd unit `/etc/systemd/system/campaign-settings.service`

```ini
[Unit]
Description=CampaignSettings server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/campaign-settings/packages/server
EnvironmentFile=/etc/campaign-settings.env
ExecStart=/usr/bin/node --import tsx src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now campaign-settings
journalctl -u campaign-settings -f      # expect: "...listening on http://127.0.0.1:8787"
curl -fsS http://127.0.0.1:8787/api/health   # -> {"status":"ok"}
```

## 8. Tailscale serve (HTTPS :8443)

The single process serves API + SPA, so Tailscale just proxies the one port:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
sudo tailscale serve status
```

Then browse `https://your-server.<tailnet>.ts.net:8443/` and log in as the
owner account from step 5. (During a parallel bring-up next to a predecessor
app already on :8443, stage on a spare port like `:8444` first, then move to
:8443 at cutover.)

## 9. Updating later

```bash
cd /opt/campaign-settings && git pull
pnpm install --frozen-lockfile
pnpm --filter @campaign-settings/web build
sudo systemctl restart campaign-settings     # re-runs any new migrations on boot
```

## Backups: TWO things, not one

A `pg_dump` does **not** contain `UPLOADS_DIR`. From the moment anyone uploads an
image, a backup regime that covers only Postgres covers only half the data — and
the half it misses fails silently, because the rows survive and every image
simply 404s. A restore that comes back with no pictures is not a restore.

So whatever cadence you settle on has to carry both:

```bash
pg_dump -Fc campaign > campaign-$(date +%F).dump      # rows
tar -czf uploads-$(date +%F).tar.gz -C /var/lib/campaign-settings uploads   # bytes
```

Prove it the same way, together: restore the dump into a scratch database, drop
the uploads tree beside it, and load an entity page that has an image on it. A
restore verified by row counts alone would pass with every image missing.

**On the existing Tailscale box this is already automated**, in the `homelab`
repo rather than here, because that is where the box's backup regime lives:

- `restic/scripts/backup.sh` dumps the Postgres into `campaign-db/data/` and
  then snapshots both that and `/var/lib/campaign-settings/uploads`. Nightly at
  03:00, retention 7 daily / 4 weekly / 6 monthly, to a restic repo on a
  separate physical disk.
- `campaign-db/scripts/restore-test.sh` restores the newest dump into a
  throwaway database weekly and asserts BOTH halves — core tables non-empty
  against production, and every `media_attachments.file_path` /
  `maps.image_path` in the restored database resolving to a real file.

A fresh deploy (the VPS) needs its own equivalent; the shape above is what to
copy. `UPLOADS_DIR` is per-host, so back up what the running service is
configured to use — and if you ever change it, move the existing tree with it
and re-check that every recorded path still resolves. Moving it once already
orphaned two images that way.

---

The remaining **live-verification / cutover** steps follow once the above is
serving: confirm a real owner login, import a world, grant a player and verify
dm-only visibility filtering, then retire the predecessor app's `tailscale serve`
config and its service.

---

## Turning the demo on

The public portfolio lands visitors on a shared, read-only account. Two halves,
and demo mode is useless with either one missing:

1. **Provision the account.** Demo mode never creates it — if the account is
   absent the endpoint answers `503 demo_unavailable` naming what it looked for.

   ```bash
   # on the host, in the app directory
   CS_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
     node --import tsx packages/server/scripts/create-account.mts demo
   ```

   The password is never used: `POST /api/demo-login` issues the session
   directly and the account is refused every mutation. Generate it, do not
   record it, and do not reuse a password from anywhere else.

2. **Give it something to show.** The demo account needs membership in the
   showcase world (task 3553), which the owner grants from that world's
   **Members** page. Granting it a `restricted` page as well is what makes the
   per-player visibility model visible to a visitor rather than merely claimed.

Then set the env and restart:

```
DEMO_MODE=true
DEMO_USERNAME=demo          # must match the account created above
```

`DEMO_MODE` is fail-closed, so the private instance needs no change: leave it
unset and none of the demo behaviour exists there.

**Keep `ACCOUNT_MANAGEMENT_ENABLED` off wherever `DEMO_MODE` is on.** The demo
principal is refused every mutation including `/api/account/*`, so the two are
belt and braces — but a future account route added without the family's
preHandler would be caught by the flag and not by anything else.

---

## Before changing what is collected

`/terms` and `/privacy` (`packages/web/src/pages/terms-page.tsx` and
`privacy-page.tsx`) state the ACTUAL behaviour of this deployment, not
boilerplate: session contents and retention, token lifetimes, the resource
limits, and exactly what account deletion does and does not remove.

**Review both pages in the same commit as any change to:**

- what is stored on an account or a session (`auth/`, migrations touching
  `accounts` or `auth_sessions`)
- any token lifetime — reset (1 hour), verification (24 hours), invitation
  (7 days) — or `SESSION_TTL_DAYS`
- the deletion cascade (`auth/deletion.ts`) or what leaving a world removes
  (`tenancy/lifecycle.ts`)
- the resource limits (`tenancy/limits.ts`) the terms page refers to

The privacy page carries a comment listing the source file behind each claim.
A page that overstates what deletion does is worse than no page.
