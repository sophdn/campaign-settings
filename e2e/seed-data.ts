/**
 * Fixture constants shared by the seed script (prepare-db.mts, run under tsx)
 * and the Playwright specs (run under Playwright's own loader). Keep this file
 * dependency-free — no server imports, no @playwright/test — so BOTH loaders can
 * import it without pulling in the other side's heavy deps.
 */

export const ACCOUNTS = {
  owner: { username: 'e2e-owner', password: 'e2e-password-1234' },
  player1: { username: 'e2e-player1', password: 'e2e-password-1234' },
  player2: { username: 'e2e-player2', password: 'e2e-password-1234' },
  /** An account in NO world — the person a DM invites. Never seeded as a member. */
  stranger: { username: 'e2e-stranger', password: 'e2e-password-1234' },
  /**
   * Exists only to be DELETED by the account-deletion spec. In no world, so
   * nothing blocks it, and no other spec depends on it.
   */
  disposable: { username: 'e2e-disposable', password: 'e2e-password-1234' },
} as const

/**
 * The shared demo principal. Named separately from ACCOUNTS because nothing
 * ever logs in AS it through the form — the demo entry point issues its session.
 * DEMO_USERNAME in the e2e server env must match.
 */
export const DEMO_USERNAME = 'e2e-demo'

export type AccountKey = keyof typeof ACCOUNTS

/** The one world the owner owns and both players are members of. */
export const WORLD = { name: 'E2E World' } as const

/** A public content entity so the entity-list surface is non-empty. */
export const SEED_NPC = { name: 'Test NPC' } as const

/**
 * The world dashboard's fixture: one session that touched SEED_NPC, and one
 * character linked to player1. Between them the GM's party panel, the player's
 * own-character panel and the session panel all have something to render, which
 * is what lets the dashboard spec assert the two roles read differently.
 */
/**
 * `playedAt` is deliberately absurd. The e2e database is seeded once for the
 * whole run and other specs write their own sessions — calendars.spec.ts dates
 * one to 1481 — so a fixture that relied on being the only session, or on being
 * the most recently edited, would top the dashboard's panel or not depending on
 * which specs had run first. A date nothing will out-rank makes it the top
 * session deterministically. The undated ordering case is covered where it can
 * be held still: data/dashboard.test.ts and world-dashboard-page.test.tsx.
 */
export const SEED_SESSION = { name: 'The Harbour Job', playedAt: '9999-12-31' } as const
export const SEED_PC = { name: 'Wren' } as const

/** A `restricted` npc granted to player1 only — the per-player visibility fixture. */
export const RESTRICTED_NPC = { name: 'Restricted Cabal' } as const

/**
 * The staged-reveal fixture, and the shape it has to be to prove anything.
 *
 * BOTH entities are public — every member sees both, and both nodes are on
 * everyone's graph. The secret is the CONNECTION between them, which lives in a
 * `restricted` passage on SEED_NPC granted to player1 alone. So player1 reads
 * the reveal and gets the extra graph edge; player2 sees the same two nodes and
 * no edge joining them.
 *
 * If either entity were hidden this would prove nothing new — the pre-existing
 * both-endpoints rule would already cover it.
 */
export const LINKED_NPC = { name: 'Harbour Watcher' } as const
export const STAGED_PASSAGE = {
  body: `He answers to [[${LINKED_NPC.name}]].`,
  /** A distinctive phrase to assert on, independent of the bracket markup. */
  phrase: 'He answers to',
} as const
