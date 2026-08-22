# Security review of the public surface — 2026-08-11

Task 3551, chain 436. Reviewed against `main` at `91c6888` plus the two branches
ahead of it (`feat/demo-mode-flag-invariant`, `feat/landing-and-getting-started`).

**Launch posture this review assumes**, decided by Sophi on 2026-08-11: the
public deploy runs **demo on, public sign-up CLOSED**. Registration opens later
by flipping `PUBLIC_SIGNUP_ENABLED`. The review still covers open registration,
because the flag is one env line away from being the live posture and a review
that only covers today's configuration expires the day it changes.

## The task's own starting premises were stale — measured, not assumed

The task text (written 2026-07-22) says there is no rate limiting and no
rate-limit dependency, listing the server's dependencies as "fastify,
@fastify/cookie, @fastify/static, pg, kysely, zod, and nothing else", over a
"28-route surface". None of that is true any more:

| Claim in the task         | Measured 2026-08-11                                 |
| ------------------------- | --------------------------------------------------- |
| No rate-limit dependency  | `@fastify/rate-limit` **11.1.0**, pinned exactly    |
| No rate limiting anywhere | Registered with `global: false`; one route opted in |
| 28 routes                 | **112**                                             |
| (not mentioned)           | Resource ceilings complete in `tenancy/limits.ts`   |

So the work was narrower and sharper than the task described: attach ceilings to
the anonymous surface, then verify the guarantees rather than assume them.

## Findings

### 1. Rate limits behind a proxy were about to be one shared bucket — FIXED

Fastify reads the client IP from the socket. Behind Caddy that is Caddy's
container address, the same for every visitor, so any IP-keyed ceiling stops
being per-caller and becomes per-internet: the first abuser spends it and locks
out everybody, while the 429s make it look like the limit is working.

Fixed by `AppDeps.trustProxy`, wired from `TRUST_PROXY` through
`parseTrustProxy`, with `compose.prod.yaml` setting `1` (one hop: Caddy, which
cannot be bypassed because the app publishes no host port). Default is `false`,
because trusting `X-Forwarded-For` where nothing sets it lets a caller pick
their own rate-limit key.

`http-rate-limits.test.ts` proves both directions: a forged header buys no fresh
bucket by default, and with `trustProxy` on, two visitors behind one proxy get
two independent ceilings.

**Still outstanding, and it is yours:** the Tailscale box has `TRUST_PROXY`
unset (verified over ssh). `tailscale serve` is a proxy too. Add
`TRUST_PROXY=1` to `/etc/campaign-settings.env` and restart. Harmless today —
the only limited route was owner-gated and keyed by session — but wrong the
moment these changes land there.

### 2. No ceilings on the anonymous surface — FIXED

Added, each with a stated ceiling and its reasoning:

| Routes                                                                        | Ceiling     | Why that shape                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/login`, `/api/register`, `/api/demo-login`                              | 10 / 10 min | A long window, not a small max: a short window at the same rate lets an attacker sustain throughput forever by pacing. Registration is the expensive one — it writes rows and runs scrypt. |
| `/api/password-reset/request`                                                 | 5 / 10 min  | The per-account throttle cannot see a caller walking a list of addresses, because no account repeats.                                                                                      |
| `/api/password-reset/confirm`, `/api/verify-email`, `/api/invitations/:token` | 30 / 10 min | The tokens are 256-bit, so guessing is hopeless regardless. This stops the endpoints being a free "is this token real?" oracle, and makes sweeping for a leaked link expensive.            |

Every ceiling is **environment-configurable** (`AUTH_RATE_LIMIT_MAX`,
`AUTH_RATE_LIMIT_WINDOW_MS`, and the same pair for `MAIL_`, `TOKEN_`,
`LOOKUP_`), for the reason `tenancy/limits.ts` already gives about resource
ceilings: the right number for a portfolio demo, for a household of players
behind one NAT, and for a public site are three different numbers, and none of
them should need a code change. A missing or non-positive value falls back to
the default, so a typo cannot remove a ceiling.

That configurability was not foresight. The first version hardcoded the numbers
and **68 e2e specs failed**, because every spec signs in through the real form
from one address and the suite is therefore a single caller spending a
ten-sign-ins-per-ten-minutes budget. Worth keeping in mind as a rough proxy for
a real household behind one NAT: if the ceiling ever feels tight in practice,
it is one env line.

**The registration order is load-bearing and was got wrong first.**
`@fastify/rate-limit` applies `config.rateLimit` through an `onRoute` hook that
only fires for routes registered after the plugin finishes loading, and
`app.register` defers loading to `ready()`. Declared in the normal flow, a route
carries its limit config and **no limit** — it works perfectly and is simply not
limited. All nine rate-limit tests failed that way before the routes moved
inside `app.after()`.

### 3. A HIGH advisory was waived on a reason that had expired — FIXED

`GHSA-qwww-vcr4-c8h2` (react-router, RSC-mode CSRF bypass) was waived in
`.audit-allowlist` on the grounds that "no patched release exists yet — the
advisory names 8.3.0 and the newest published react-router is 8.1.0".

Checked against the registry rather than re-read: the advisory's own
`Patched versions` field is **`>=7.18.2`**, published **2026-07-28** — fourteen
days earlier, and well clear of the workspace's 7-day `minimumReleaseAge` floor.
A patch inside our own major line had been available the whole time and the
waiver looked past it at the 8.x number. (8.3.0 has since shipped too.)

Fixed by upgrading `react-router-dom` 7.18.1 → 7.18.2 and deleting the waiver.
`scripts/audit-gate.sh` is green with seven remaining advisories, all waived
with reasons that hold.

**The gap this exposes** is in the gate, not in the waiver: `audit-gate.sh`
fails when a waived advisory _disappears_, which cannot catch a waiver whose
_reason_ expires while the advisory stays. "No fix exists" is a claim with a
shelf life and nothing was watching it. Filed as a suggestion.

## Verified, not assumed

Each of these was an acceptance criterion. Each now has a test that fails if the
guarantee breaks.

- **Every world-scoped route re-checks membership.** `http-route-guards.test.ts`
  reads the real registered route table (recorded by an `onRoute` hook in
  `buildApp` and exposed as `app.routeGuards`) and asserts that all 50+ routes
  under `/api/worlds/:worldId` carry both `requireAccount` and `requireWorld`.
  A structural assertion, not a sample: the route that leaks is by definition
  the one somebody forgot, which is the one a hand-written spot-check forgets
  too. Mutation-checked — pointing one route at `authed` instead of `inWorld`
  fails it.
- **And they refuse, not merely carry a guard.** The same file drives a
  signed-in stranger at every route in that family and asserts nothing answers
  with a success.
- **The anonymous surface is exactly 13 method/route pairs**, asserted as an
  exhaustive list. A new unguarded route fails the test until somebody adds it
  deliberately, which is the moment to ask whether it should be public.
- **`GET /api/worlds/:worldId/export` stays owner-only** against a member who is
  not the owner — a 403 for the player, 200 for the owner.
- **`GET /api/worlds/:worldId/media/:id/raw` enforces the owning entity's
  visibility.** Already covered by `http-media.test.ts`: hiding a location from
  players 404s both the media list and the raw bytes. Re-read rather than
  re-written.
- **The account family is closed to the shared demo principal, reads included**
  (task 3564, PR #70). `GET /api/account/sessions` would otherwise hand one
  visitor the device label of the browser that opened the shared session.
- **Resource ceilings** — worlds per account, entities per world, media bytes
  per world, per-file image/map/thumbnail bytes, passages per entity, passage
  body length, pending proposals per author — all present in
  `tenancy/limits.ts`, env-configurable with fail-safe fallbacks, with
  `maxUploadBytes` as fastify's socket-level `bodyLimit` so an oversized upload
  is refused before it is buffered.
- **Secrets.** `scripts/secret-scan-tree.sh` clean over the tree; the only
  tracked env files are the two `.example` templates; `.env` is gitignored and
  `.dockerignore` keeps every `.env*` out of the build context except the
  example.
- **Live box posture** (the Tailscale box, checked over ssh): `NODE_ENV=production`,
  `SESSION_SECRET` **64 characters**, `/etc/campaign-settings.env` mode `600`,
  service active. The public box does not exist yet (task 3546), so its posture
  is checked at cutover, not now.

## Dependency vetting: `@fastify/rate-limit` 11.1.0

Per `skill:dependency-vetting-discipline`, three layers, because a green
scanner is not sufficient on its own.

- **Provenance and maintenance.** Published by the Fastify org
  (`github.com/fastify/fastify-rate-limit`), MIT, the first-party plugin for the
  framework already in use. Three runtime dependencies — `@lukeed/ms`,
  `fastify-plugin`, `toad-cache` — all small and all in the Fastify/lukeed
  orbit. Registry `time.modified` 2026-08-06, so actively maintained.
- **Automated scan.** `pnpm audit` reports no advisory against it or its three
  dependencies; `scripts/audit-gate.sh` green.
- **Manual scan.** No supply-chain incident found for the package or its
  dependency trio. `toad-cache` is the one worth naming, being the smallest and
  least-known; it is by the Fastify maintainer (@Uzlopak) and is the cache
  fastify itself uses.
- **Pinning.** Exact, `11.1.0`. Latest is 11.2.0; not taken here, because
  changing a dependency version is not this task's business and the pin is
  deliberate. Worth a routine bump later.

## Not fixed, deliberately

- **No `helmet` / CSP.** Caddy already sets HSTS, `X-Content-Type-Options` and
  `Referrer-Policy`. A Content-Security-Policy is worth having and is a
  different piece of work with its own testing — the SPA is Vite-built with
  inline module preloads, so a CSP needs measuring rather than pasting. Not
  smuggled into this task.
- **`@fastify/rate-limit` keeps its counters in memory.** Correct for one
  process on one box, which is this deployment. It resets on restart, so a
  patient attacker can bounce a deploy — irrelevant here, since a restart is
  something only the operator does.
- **No account lockout after N failed logins.** Deliberate: lockout on a
  username is a denial-of-service primitive against a named user. The rate limit
  is on the caller instead.
