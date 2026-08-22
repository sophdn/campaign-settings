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

The checkout lives at `~/homelab/campaign-settings`, alongside the rest of the
homelab layout (`~/homelab/campaign-db` holds this service's backup units).
Every path below follows from that one. This document used to say
`/opt/campaign-settings`, which has never existed on the box — see the caution
in section 9 for why that particular staleness is worth being careful about.

```bash
mkdir -p ~/homelab
git clone https://github.com/sophdn/campaign-settings ~/homelab/campaign-settings
cd ~/homelab/campaign-settings
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
WEB_DIST_DIR=/home/youruser/homelab/campaign-settings/packages/web/dist
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
cd ~/homelab/campaign-settings
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
cd ~/homelab/campaign-settings
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
WorkingDirectory=/home/youruser/homelab/campaign-settings/packages/server
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
cd ~/homelab/campaign-settings && git pull
pnpm install --frozen-lockfile
pnpm --filter @campaign-settings/web build
sudo systemctl restart campaign-settings     # re-runs any new migrations on boot
```

> **Update in the tree the service actually reads.** These four commands are
> the ones run while shipping, so a wrong directory here fails in the worst
> available way. When this section said `/opt/campaign-settings`, the `cd`
> failed outright — recoverable, because you see it. The dangerous version is
> creating that directory to make the runbook work: then all four commands
> **succeed**, pulling, installing and building a tree the service never reads,
> and the restart brings the old code back up. A deploy that reports success
> and ships nothing. Confirm with
> `systemctl show campaign-settings -p WorkingDirectory` if in any doubt.

## Rehearse the migrations FIRST — required, not advisory

**Any deploy carrying a migration that has not run against live data is rehearsed
first.** This is a step, not a suggestion, and it applies to both deploys below.

Migrations run on BOOT. There is no deploy step that applies them and can fail
visibly — so without a rehearsal the first sign of a bad one is a service that
will not come up, or worse, one that comes up having quietly mangled data.

### 1. Ask the live database what it has actually run

```bash
docker exec campaign-settings-postgres \
  psql -U campaign -d campaign -tAc 'select name from kysely_migration order by name'
```

**Count this, never the files in `db/migrations/`.** The unrun set is the
difference between that list and `db/migrations/index.ts`. Counting files and
assuming live has not moved has produced a wrong number three separate times —
eight, then twelve, when the answer on 2026-08-11 was three.

### 2. Rehearse against a restored copy, never against live

```bash
NEWEST=$(sudo find ~/homelab/campaign-db/data -name 'campaign-*.dump' -printf '%T@ %p\n' \
  | sort -rn | head -1 | cut -d' ' -f2-)
docker exec -i campaign-settings-postgres psql -U campaign -d postgres -c 'CREATE DATABASE cs_rehearsal;'
sudo cat "$NEWEST" | docker exec -i campaign-settings-postgres pg_restore -U campaign -d cs_rehearsal --no-owner

DATABASE_URL=postgres://campaign:<pw>@127.0.0.1:5432/cs_rehearsal \
  node --import tsx packages/server/scripts/rehearse-migrations.mts
```

It exits non-zero on any failure, so it can gate the deploy. It refuses to run
against a URL ending in `/campaign` or `/campaign_dev`. Drop the copy afterwards.

The dumps and the weekly restore test that proves them are
`~/homelab/campaign-db/` — the rehearsal is that restore path's most useful
customer.

### 3. Read what it checked

The script captures the source rows BEFORE each destructive migration and
compares row by row afterwards. A total-only comparison is not enough and this
is not hypothetical: fold `culture_languages` to the wrong relationship type and
the row count is still exactly right — five rows simply land as `venerates`
instead of `speaks`. Only the per-row check sees it.

### The rollback answer

| migration              | `down` reverses it?                                      |
| ---------------------- | -------------------------------------------------------- |
| 0015 `entity_passages` | **Yes** — additive; `down` drops the two tables it added |
| 0016 `map_visibility`  | **Yes** — additive; `down` drops the ACL table it added  |
| 0017 `fold_junctions…` | **No. Restore from backup.**                             |

0017's `down` succeeds, and that is exactly what makes it dangerous to trust.
Measured on a restored copy 2026-08-11: after stepping it back, the nine
junction tables are all recreated **empty** and the 14 folded rows are still
sitting in `entity_relationships`. The schema reverses; the data does not move
back. So the recovery for 0017 is to restore the dump, not to migrate down.

## The OTHER deploy: public, in containers

Everything above is the **private** deploy — one box on the tailnet, systemd,
`tailscale serve`. It is still the live one and this section does not replace it.

The **public** deploy at `campaign-settings.com` is a separate stack on an
isolated VPS, described by `compose.prod.yaml` + `Dockerfile` + `Caddyfile` in
the repo root. Steps 3–6 above (Postgres, the env-file contract, the operator
account, the SPA build) carry over conceptually; steps 7–8 (systemd, Tailscale)
are what containers replace.

```
internet ──▶ caddy :80/:443 ──▶ app:8787 ──▶ postgres:5432
             (TLS, auto-certs)   (expose)     (no ports)
```

Only Caddy is bound to the host. The app and Postgres are reachable on the
compose network and nowhere else — `expose`, never `ports`. `compose.prod.yaml`
is a separate FILE rather than an override of `compose.yaml` for one reason: the
dev file publishes Postgres on host port 5433, and an override can add a service
but cannot take a published port away.

```bash
cp .env.prod.example /etc/campaign-settings.env   # then fill it in
chmod 600 /etc/campaign-settings.env
docker compose -f compose.prod.yaml --env-file /etc/campaign-settings.env up -d --build
docker compose -f compose.prod.yaml --env-file /etc/campaign-settings.env ps   # app: healthy
```

DNS must already point at the box: Caddy gets its certificate over the ACME HTTP
challenge on port 80, so it cannot issue one for a name that does not resolve
here yet. That is the ordering constraint chain 436 task 1 owns.

**Decide the access gates before the first boot.** All six fail closed, and
`LOGIN_ENABLED` is the one that bites: with it off, registration succeeds and
the very next login returns 403, which reads like a broken deploy rather than a
closed door. `.env.prod.example` lists all six with the two sensible postures.

### The first account

Step 5's operator CLI runs from the source checkout via pnpm and tsx, none of
which exist in the image. It is bundled into it instead:

```bash
CS_ADMIN_PASSWORD='<owner-pw>' docker compose -f compose.prod.yaml \
  --env-file /etc/campaign-settings.env \
  run --rm -e CS_ADMIN_PASSWORD app node create-account.mjs <owner-username>
```

Same script, same password-never-on-argv rule. The alternative — opening
`PUBLIC_SIGNUP_ENABLED`, registering, then closing it again — leaves a gate open
for as long as it takes someone to remember to close it, which is why this is
here.

### What the image is, and why it is a bundle

`packages/server/build.mjs` bundles the server to a single `dist/server.mjs`
with esbuild, and the runtime stage copies in exactly two things: that file and
the built SPA. No `node_modules`, no pnpm, no tsx, no source. Runs as uid 1000
(`node`), never root.

This is the alternative the "Why `node --import tsx`, not a bundle" section
above offers, taken up for the container only — shipping tsx plus a full pnpm
tree into a production image on a CX22-class box is a large dependency surface
for no runtime gain. The private systemd deploy still runs from source via tsx;
both are supported and neither is going away.

One thing to know if you touch the bundle: the `createRequire` banner in
`build.mjs` is load-bearing. `pg` is CommonJS and calls `require('events')`, and
esbuild's ESM output rewrites that to a shim that throws unless a real `require`
is in scope — so without the banner the bundle builds perfectly clean and dies
on its first database connection.

### Volumes

Named volumes, not bind mounts, so a `docker compose down` cannot take the data
with it and a backup can name its target:

| volume             | holds                                     |
| ------------------ | ----------------------------------------- |
| `campaign-pgdata`  | Postgres data                             |
| `campaign-uploads` | `UPLOADS_DIR` — uploaded images           |
| `caddy-data`       | TLS certificates and the ACME account key |
| `caddy-config`     | Caddy's autosaved config                  |

`caddy-data` matters more than it looks: losing it means re-issuing certificates
on every recreate, and Let's Encrypt rate-limits that hard enough to take the
site down for a week.

The first two are what a backup must cover — see the next section, which applies
to this deploy exactly as it does to the private one.

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

### Do not cut over to a host that cannot restore

This is a gate, not advice. **A new host is not ready for real data until every
line below is true of that host** — not of the Tailscale box, and not "in the
plan":

- [ ] The Postgres dump runs on a schedule, writing **timestamped** files —
      history, not one file overwritten in place — to storage that is not the
      database's own disk.
- [ ] `UPLOADS_DIR` is captured on the **same schedule and the same retention**,
      and **after** the dump. A media row is inserted only once its bytes are on
      disk, so a file with no row is inert while a row with no file is a broken
      image. Different cadences mean the two halves restore to different points
      in time, which is a half-restore that reports success.
- [ ] Retention has a **hard floor by count, not by age**. A bare
      `find … -mtime +N -delete` honours age and ignores the floor, so one clock
      or path bug deletes everything. Keep N newest regardless of age.
- [ ] A restore test runs on a schedule and **actually restores** — into a
      throwaway database, with the uploads tree beside it. Checking that a
      backup file exists and is non-empty is the failure this whole section
      exists to prevent.
- [ ] That test asserts **both halves**: row counts against production, _and_
      every `media_attachments.file_path` and non-null `maps.image_path` in the
      **restored** database resolving to a real file. Row counts alone pass with
      every image gone.
- [ ] It has **passed at least once on this host**, and you have read the log
      rather than the exit code. The existing box's test asserted a `users`
      table that has never existed; it was installed, green-looking, and would
      have failed every week it ran had it ever been scheduled.

Why this is a gate: bug 1179 came from a team that lost live campaign tables to
a remote-quoting bug and recovered only by luck, from an unrelated snapshot.
There is no "re-derive from source" for a TTRPG campaign — the data _is_ the
work. A backup nobody has restored from is a rumour.

---

The remaining **live-verification / cutover** steps follow once the above is
serving _and the backup gate above is ticked_: confirm a real owner login,
import a world, grant a player and verify dm-only visibility filtering, then
retire the predecessor app's `tailscale serve` config and its service.

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

**You no longer have to keep `ACCOUNT_MANAGEMENT_ENABLED` off wherever
`DEMO_MODE` is on.** This used to be a rule you had to remember, and remembering
is not a guarantee. The demo principal is now refused the whole `/api/account/*`
family by `requireAccount` — **reads included**, not only mutations — so the two
flags can both be on without exposing anything. Leaving account management off
on the public box is still the tidier posture, since nobody there has a real
account to manage; it is a preference now, not a safety requirement.

Why reads had to go too: `GET /api/account/sessions` lists the SHARED session
with the device label of whoever opened it, so one visitor learns a fact about
another visitor's browser. Being a safe method is not the same as being harmless
on an account everybody shares.

---

## Outbound email

Password reset and email verification need a way to send. Without one the app
falls back to a **logging mailer** that writes "a reset was requested" to the
journal and sends nothing — safe for dev, useless in production, and silent
about it. A user who asks for a reset and gets no mail has no way to tell
anybody, so this is the flow where a silent failure costs the most.

**Provider: Resend** (chosen 2026-08-11). 3,000 emails/month free, 100/day,
which is ample for a signup-closed launch. The integration is a single POST to
one URL, written against Node's built-in `fetch` — **no SDK, no new
dependency**. Swapping providers means one more file the size of
`packages/server/src/auth/resend-mailer.ts` and one changed line in `main.ts`;
the app depends on the `Mailer` port and never on a vendor.

### 1. Create the account and verify the domain (yours)

1. Sign up at resend.com and add `campaign-settings.com` as a domain.
2. Resend gives you three DNS records. Add them at whatever hosts the domain's
   DNS — the exact values come from Resend's dashboard and are per-account, so
   copy them from there rather than from anywhere else:

   | Type  | Host                                      | Purpose                                                        |
   | ----- | ----------------------------------------- | -------------------------------------------------------------- |
   | `TXT` | `send.campaign-settings.com`              | SPF — authorises Resend to send as the domain                  |
   | `TXT` | `resend._domainkey.campaign-settings.com` | DKIM — the public key mail servers check the signature against |
   | `MX`  | `send.campaign-settings.com`              | bounce handling (Resend's `feedback-smtp` host, priority 10)   |

   These sit alongside the `A`/`AAAA` records for the apex and `www` that task
   3546 adds for Caddy. They do not conflict: the mail records are on the
   `send.` subdomain.

3. Wait for Resend to show the domain **Verified**. DNS propagation is usually
   minutes, occasionally an hour.
4. Create an API key with **sending** permission only.

### 2. Put it in the env file (yours)

Three variables, all required together — the server refuses to boot with a half
configuration rather than sending links to nowhere:

```ini
RESEND_API_KEY=re_...                              # the key from step 1.4
MAIL_FROM=CampaignSettings <no-reply@campaign-settings.com>
APP_ORIGIN=https://campaign-settings.com           # builds the links in the mail
```

The key belongs in `/etc/campaign-settings.env` (`chmod 600`) and nowhere else.
It is never in the repo, never in the image — `.dockerignore` keeps every
`.env*` out of the build context — and the compose stack passes it through at
run time.

`APP_ORIGIN` must be `https` (except on `localhost`) and is validated at boot.
Getting it wrong points every link in every email at the wrong host, which is
the sort of thing nobody notices until a user reports a dead link.

### 3. Prove it (one command)

```bash
# on the box, in the app directory
set -a; . /etc/campaign-settings.env; set +a
node --import tsx packages/server/scripts/send-test-email.mts you@example.com
```

It sends a real password-reset-shaped message carrying an obviously fake token —
it touches no database, so the link is dead on arrival and can reset nothing.

Check the mail **arrived and is not in spam**. Landing in spam means the SPF or
DKIM records are missing or wrong; a refusal from the provider names its own
reason (unverified domain, revoked key, malformed `From`), because the error
carries the provider's message rather than swallowing it.

## Behind a reverse proxy: set `TRUST_PROXY` or the rate limits are theatre

`/api/login`, `/api/register`, `/api/demo-login`, the password-reset routes and
the token-guess routes are rate-limited **per caller**, and "caller" means the
client IP for anyone without a session.

Fastify takes that IP from the socket, which behind a proxy is **the proxy's
address, identical for every visitor on earth**. Unset, the ceilings still
appear in the code, still return 429s, and protect nothing: the first abuser
spends the shared bucket and everybody else is locked out with them.

- **Container deploy:** already handled. `compose.prod.yaml` sets
  `TRUST_PROXY: '1'`, and Caddy sets `X-Forwarded-For` to the real client.
- **Tailscale deploy:** `tailscale serve` is also a proxy. Add `TRUST_PROXY=1`
  to `/etc/campaign-settings.env` and restart. Verified missing there on
  2026-08-11 — it was not doing damage yet, because the only limited route at
  the time was owner-gated and keyed by session cookie, but it is wrong the
  moment the auth-surface limits land.

Set it to the number of proxies a request **must** pass through. Never set it
where the process is reachable directly: trusting `X-Forwarded-For` when nothing
sets it lets a caller choose their own rate-limit key, which is worse than
having no limit because it looks like one.

### The ceilings, and how to move them

| Variable                               | Default     | Applies to                                       |
| -------------------------------------- | ----------- | ------------------------------------------------ |
| `AUTH_RATE_LIMIT_MAX` / `_WINDOW_MS`   | 10 / 600000 | `/api/login`, `/api/register`, `/api/demo-login` |
| `MAIL_RATE_LIMIT_MAX` / `_WINDOW_MS`   | 5 / 600000  | `/api/password-reset/request`                    |
| `TOKEN_RATE_LIMIT_MAX` / `_WINDOW_MS`  | 30 / 600000 | reset confirm, verify-email, invitation preview  |
| `LOOKUP_RATE_LIMIT_MAX` / `_WINDOW_MS` | 20 / 60000  | `/api/worlds/:worldId/account-lookup`            |

A missing or non-positive value falls back to the default, so a typo cannot
remove a ceiling. Raise `AUTH_RATE_LIMIT_MAX` if a group of players sharing one
household address ever runs into it — that is the realistic false positive, and
it is one line rather than a deploy.

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
