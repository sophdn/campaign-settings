/**
 * Provision the isolated e2e database, then seed the fixture world. Run under
 * tsx (the codebase's loader for its bundler-style imports) as the FIRST step of
 * the Playwright webServer command, so the server that boots afterwards connects
 * to an already-migrated, already-seeded database — no cross-process race with
 * migrate-on-boot, and DROP DATABASE never fights a live connection.
 *
 *   DATABASE_URL=postgres://…/campaign_e2e  node --import tsx e2e/prepare-db.mts
 *
 * DATABASE_URL names the e2e database itself (NOT dev/prod); this script drops
 * and recreates exactly that database via the admin `postgres` connection.
 */
import { CONTENT_REPOS } from '../packages/server/src/data/content-repos'
import { grantEntityVisibility } from '../packages/server/src/data/entity-visibility'
import { createPassage, grantPassageVisibility } from '../packages/server/src/data/passages'
import { createDb } from '../packages/server/src/db/kysely'
import { migrateToLatest } from '../packages/server/src/db/migrator'
import { createPool } from '../packages/server/src/db/pool'
import { createScryptAuth } from '../packages/server/src/auth/service'
import { createTenancy } from '../packages/server/src/tenancy/service'
import {
  ACCOUNTS,
  DEMO_USERNAME,
  LINKED_NPC,
  RESTRICTED_NPC,
  SEED_NPC,
  STAGED_PASSAGE,
  WORLD,
} from './seed-data'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL must name the e2e database')

const dbName = new URL(url).pathname.slice(1)
if (!dbName) throw new Error(`DATABASE_URL has no database name: ${url}`)

// Guard-rail: refuse to nuke anything that isn't an e2e database.
if (!dbName.includes('e2e')) {
  throw new Error(
    `refusing to drop/recreate non-e2e database "${dbName}" — name must contain "e2e"`,
  )
}

async function main(): Promise<void> {
  const adminUrl = new URL(url as string)
  adminUrl.pathname = '/postgres'
  const admin = createPool(adminUrl.toString())
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await admin.end()
  }

  const db = createDb(createPool(url as string))
  try {
    await migrateToLatest(db)

    const auth = createScryptAuth(db)
    const owner = await auth.createAccount(ACCOUNTS.owner.username, ACCOUNTS.owner.password)
    const player1 = await auth.createAccount(ACCOUNTS.player1.username, ACCOUNTS.player1.password)
    const player2 = await auth.createAccount(ACCOUNTS.player2.username, ACCOUNTS.player2.password)
    // Deliberately joined to nothing — the members spec invites them into the world.
    await auth.createAccount(ACCOUNTS.stranger.username, ACCOUNTS.stranger.password)
    // Exists to be deleted by the account-deletion spec; owns nothing.
    await auth.createAccount(ACCOUNTS.disposable.username, ACCOUNTS.disposable.password)
    // The shared demo principal. Joined to the world below so it has something
    // to show; every write it attempts is refused server-side.
    const demo = await auth.createAccount(DEMO_USERNAME, 'e2e-password-1234')

    const tenancy = createTenancy(db)
    const world = await tenancy.createWorld(owner.id, WORLD.name)
    await tenancy.grantMember(owner.id, world.id, player1.id)
    await tenancy.grantMember(owner.id, world.id, player2.id)
    await tenancy.grantMember(owner.id, world.id, demo.id)

    const ownerCtx = {
      db,
      worldId: world.id,
      actor: { accountId: owner.id, role: 'owner' as const },
    }
    const npcRepo = CONTENT_REPOS.npc
    if (!npcRepo) throw new Error('npc content repo is not registered')
    const seedNpc = await npcRepo.create(ownerCtx, {
      name: SEED_NPC.name,
      description: 'A seeded fixture NPC.',
      visibility: 'public',
    })

    // The staged-reveal fixture. Both entities are PUBLIC — what is restricted
    // is the passage joining them, so the thing player2 must not learn is that
    // they are connected at all.
    await npcRepo.create(ownerCtx, {
      name: LINKED_NPC.name,
      description: 'Watches the harbour. Visible to everyone.',
      visibility: 'public',
    })
    const staged = await createPassage(
      ownerCtx,
      { entityId: seedNpc.id, body: STAGED_PASSAGE.body, visibility: 'restricted' },
      owner.id,
    )
    await grantPassageVisibility(ownerCtx, staged.id, player1.id)

    // A restricted npc, granted to player1 only — exercises per-player visibility.
    const restricted = await npcRepo.create(ownerCtx, {
      name: RESTRICTED_NPC.name,
      description: 'Only player1 may see this.',
      visibility: 'restricted',
    })
    await grantEntityVisibility(ownerCtx, restricted.id, player1.id)

    console.log(`e2e db "${dbName}" seeded — world "${world.slug}", accounts owner/player1/player2`)
  } finally {
    await db.destroy()
  }
}

await main()
