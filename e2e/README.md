# End-to-end tests (Playwright)

Browser-level tests that drive the **real** app: the Fastify server serving the
built SPA single-origin over a real Postgres.

## Run locally

Requires the dev Postgres up (`docker compose up -d` — provides the `postgres`
maintenance db the e2e database is created from):

```sh
pnpm e2e            # reset+seed the e2e db, build web, boot server, run specs
```

The first run also needs the browser binary:

```sh
pnpm e2e:install    # playwright install --with-deps chromium
```

## How it works

- **Isolated database.** The run uses a dedicated `campaign_e2e` database derived
  from `DATABASE_URL` (only the db name is swapped) — dev/prod data is never
  touched. `e2e/prepare-db.mts` drops + recreates it, migrates, and seeds.
- **Deterministic fixture.** One owner + two players (`e2e/seed-data.ts`) and one
  world (`E2E World`) they all belong to, plus a public NPC so the entity list is
  non-empty. Seed and specs share `seed-data.ts` so credentials never drift.
- **Single sequential boot.** The Playwright `webServer` runs
  `prepare-db → build web → boot server` in order, so the server always connects
  to an already-migrated, already-seeded db (no race with migrate-on-boot).
- **Real auth flow.** Specs log in through the UI rather than injecting a cookie.

## CI

The `e2e` job in `.gitea/workflows/ci.yml` runs alongside the `check` gate: it
installs the chromium browser and runs `pnpm e2e` against a postgres service.
