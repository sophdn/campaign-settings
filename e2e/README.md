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

## Asserting on text

`getByText` is the easiest locator in the suite to satisfy by accident. Three
mechanisms have each produced assertions that passed while testing nothing, and
every one of them was invisible to code review and to green CI runs:

1. **Concatenation.** `getByText` matches the SMALLEST element whose text
   contains the string, and an element's text is its children joined. The entity
   editor renders Save beside Delete, so `div.form-actions` reads "SaveDelete" —
   which contains "saved". Five `getByText('Saved')` assertions matched that row
   whether or not anything had been saved (fixed in 6e814fd).
2. **Form-control values.** A `<textarea>` is matched by its VALUE, not by its
   text content. `expect(page.getByText(suggestion)).toBeVisible()` after
   clicking Send matched the suggestion box the player had just typed into, and
   passed with the entire read-back path removed from the server. A text
   `<input>` is NOT matched this way — textareas are the trap.
3. **A control named after the thing it changes.** Matching is
   case-insensitive, so `getByText('Primary')` finds the badge that says
   "Primary" _and_ the button that says "Make primary" — and those two are
   mutually exclusive, one per row state. The locator was therefore never 0, and
   `toHaveCount(0)` could only pass in the blink where the panel's post-write
   reload had unmounted the rows. It won that race here and lost it on CI, which
   is how a red main got noticed. Its sibling `toBeVisible()` assertions passed
   on the button, on rows that had not been promoted.

All three are silent in the direction that matters: a vacuous PASS. They become
visible only if a second match ever appears, which may be never — or, for the
third, only on a machine slow enough to lose a race this one always won.

**So a new text assertion carries a burden of proof, and the proof is a
measurement, not a reading.** In the state where the asserted thing has NOT
happened yet, the locator must find ZERO elements. Measure it — a throwaway
`console.log(await locator.count())` at that point in the spec, or defeat the
rendering in the app and watch the assertion fail. Every site in this suite has
been through that check once; the whole point is that all five originals looked
correct to reviewers who were reading rather than measuring.

For a `toHaveCount(0)` assertion the burden is the mirror: over-broad is safe
there, and the failure mode is a locator that matches nothing in ANY state. Show
it matching at least one element where the thing IS present.

**`exact: true` is NOT the house default, deliberately** — though it is the right
fix for mechanisms 1 and 3, where the ambiguity is another element carrying the
needle as part of a longer string ("SaveDelete", "Make primary"). Use it there,
and say in a comment what it is telling apart.

As a blanket rule it fails twice over. It would break the assertions that
legitimately mean "this sentence contains X" — a reveal inside surrounding prose,
"Offered to X. They have not accepted yet…", "Chrome on Windows — this device".
And it would not have caught mechanism 2 at all: the suggestion box's value
equals the needle exactly, so the exact form matches the textarea too (measured:
`loose=1 exact=1`). Exactness is not what separates a real assertion from a
vacuous one; the pre-condition state is.

Never relax a locator to `.first()` or `.nth()` to quiet a strict-mode failure.
Two matches is the suite telling the truth for once — it is how the "SaveDelete"
bug was finally caught, on a docs-only PR.

## CI

The `e2e` job in `.gitea/workflows/ci.yml` runs alongside the `check` gate: it
installs the chromium browser and runs `pnpm e2e` against a postgres service.
