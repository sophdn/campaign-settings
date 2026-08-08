/**
 * Demo seed: build a small, self-contained sample world so a fresh clone shows
 * off the interesting parts of the app — the entity wiki, the `[[wiki-link]]`
 * graph, and (the point of the whole thing) the per-player visibility model.
 *
 *   pnpm demo:seed            # from the repo root
 *   tsx scripts/seed-demo.mts # from packages/server
 *
 * It is idempotent: it deletes the demo accounts first (accounts/worlds cascade),
 * then rebuilds the world from scratch. It touches ONLY the demo accounts, so it
 * is safe to re-run against a database that also holds real worlds.
 *
 * Env: DATABASE_URL (defaults to the compose.yaml dev URL). Demo passwords come
 * from CS_DEMO_DM_PASSWORD / CS_DEMO_PLAYER_PASSWORD or fall back to obvious
 * demo defaults — this is a throwaway LOCAL database, never a hosted one.
 */
import { createScryptAuth } from '../src/auth/service'
import { CONTENT_REPOS } from '../src/data/content-repos'
import type { WorldContext } from '../src/data/context'
import { grantEntityVisibility } from '../src/data/entity-visibility'
import { createDb } from '../src/db/kysely'
import { migrateToLatest } from '../src/db/migrator'
import { createTenancy } from '../src/tenancy'
import { upsertMember } from '../src/tenancy/members'
import { Pool } from 'pg'

const url = process.env.DATABASE_URL ?? 'postgres://campaign:campaign@localhost:5433/campaign_dev'
const DM_USER = 'dm-demo'
const PLAYER_USER = 'player-demo'
const SCOUT_USER = 'player-scout'
/**
 * The shared demo principal (DEMO_MODE / task 3633). Not created here — it is
 * operator-provisioned, and demo mode deliberately never mints an account. But
 * this seed DELETES and rebuilds the showcase world, which would silently strip
 * that account's membership and grants and leave the /demo entry point landing
 * visitors on an empty world picker. So if it exists, re-attach it.
 */
const DEMO_USER = process.env.DEMO_USERNAME ?? 'demo'
const DM_PASSWORD = process.env.CS_DEMO_DM_PASSWORD ?? 'demo-dm-password'
const PLAYER_PASSWORD = process.env.CS_DEMO_PLAYER_PASSWORD ?? 'demo-player-password'

/** One entity to seed: its kind, name, visibility, and link-bearing description. */
interface Seed {
  kind: string
  name: string
  visibility: 'public' | 'dm_only' | 'restricted'
  description: string
  occupation?: string
}

// A pocket noir setting. Descriptions reference other entities by `[[Name]]`,
// which the graph view resolves into edges. The dm_only cluster (the Ashen Hand
// conspiracy) is invisible to players; `Silas Crow` is `restricted` — a single
// player is granted him below, so the ACL is visible in the running app.
const SEEDS: Seed[] = [
  {
    kind: 'settlement',
    name: 'Saltmarsh',
    visibility: 'public',
    description:
      'A salt-crusted port town clinging to the coast. Watched over by [[The Lamplighters]]; its nights belong to quieter powers.',
  },
  {
    kind: 'location',
    name: 'Old Harbor',
    visibility: 'public',
    description:
      "The fog-bound docks where [[Saltmarsh]]'s trade breathes in and out. Smugglers favor the rotted eastern piers.",
  },
  {
    kind: 'location',
    name: 'The Undercroft',
    visibility: 'dm_only',
    description:
      'A drowned temple beneath [[Saltmarsh]]. [[The Ashen Hand]] meets here by candlelight.',
  },
  {
    kind: 'organization',
    name: 'The Lamplighters',
    visibility: 'public',
    description:
      "Saltmarsh's lantern-carrying night watch. Captain [[Oren Doss]] keeps the peace, mostly.",
  },
  {
    kind: 'organization',
    name: 'The Ashen Hand',
    visibility: 'dm_only',
    description:
      'A cabal trading in secrets and ash. Answers to [[The Hollow Man]]; shelters in [[The Undercroft]].',
  },
  {
    kind: 'npc',
    name: 'Mara Vane',
    visibility: 'public',
    occupation: 'Tavern keeper',
    description:
      'Keeps the Gull & Anchor in [[Saltmarsh]]. Hears everything, repeats little — even to [[The Lamplighters]].',
  },
  {
    kind: 'npc',
    name: 'Oren Doss',
    visibility: 'public',
    occupation: 'Watch captain',
    description:
      'Captain of [[The Lamplighters]]. Honest, tired, and one bad night from asking [[Mara Vane]] the wrong question.',
  },
  {
    kind: 'npc',
    name: 'The Hollow Man',
    visibility: 'dm_only',
    occupation: 'Cabal master',
    description:
      'No one has seen his face. He steers [[The Ashen Hand]] and hunts the [[Ledger of Ash]]. He already owns [[Silas Crow]].',
  },
  {
    kind: 'npc',
    name: 'Silas Crow',
    visibility: 'restricted',
    occupation: 'Informant',
    description:
      'A twitchy dockhand on [[Old Harbor]] who sells whispers. Secretly reports to [[The Ashen Hand]].',
  },
  {
    kind: 'pc',
    name: 'Bright',
    visibility: 'public',
    description:
      'A wandering hedge-mage newly arrived in [[Saltmarsh]]. Owes [[Mara Vane]] for a room and a lie.',
  },
  {
    kind: 'lore_article',
    name: 'The Sundering',
    visibility: 'public',
    description: 'The night the old harbor gods drowned. [[Saltmarsh]] was built on their bones.',
  },
  {
    kind: 'lore_article',
    name: 'Ledger of Ash',
    visibility: 'dm_only',
    description:
      'A book naming every soul [[The Ashen Hand]] has bought. [[The Hollow Man]] would burn a city to keep it.',
  },
]

const pool = new Pool({ connectionString: url })
const db = createDb(pool)

try {
  await migrateToLatest(db)

  // Idempotent reset, in two steps and in this order.
  //
  // The world goes FIRST and explicitly. Migration 0012 changed
  // worlds.owner_id from ON DELETE CASCADE to RESTRICT, so deleting the owner
  // account no longer takes its world with it — deliberately, because that
  // cascade would let an account deletion destroy other members' work. This
  // script is the one place that genuinely wants the world gone, so it says so.
  // (Deleting the world still cascades to its content, memberships and grants.)
  await db
    .deleteFrom('worlds')
    .where(
      'owner_id',
      'in',
      db
        .selectFrom('accounts')
        .select('id')
        .where('username', 'in', [DM_USER, PLAYER_USER, SCOUT_USER]),
    )
    .execute()
  await db
    .deleteFrom('accounts')
    .where('username', 'in', [DM_USER, PLAYER_USER, SCOUT_USER])
    .execute()

  const auth = createScryptAuth(db)
  const dm = await auth.createAccount(DM_USER, DM_PASSWORD)
  const player = await auth.createAccount(PLAYER_USER, PLAYER_PASSWORD)
  const scout = await auth.createAccount(SCOUT_USER, PLAYER_PASSWORD)

  const tenancy = createTenancy(db)
  const world = await tenancy.createWorld(dm.id, 'Saltmarsh Nights')
  await upsertMember(db, { world_id: world.id, account_id: player.id, role: 'player' })
  await upsertMember(db, { world_id: world.id, account_id: scout.id, role: 'player' })

  const ctx: WorldContext = {
    db,
    worldId: world.id,
    actor: { accountId: dm.id, role: 'owner' },
  }

  const idByName = new Map<string, string>()
  for (const seed of SEEDS) {
    const repo = CONTENT_REPOS[seed.kind]
    if (!repo) throw new Error(`unknown content kind: ${seed.kind}`)
    const { kind: _kind, name: _name, ...input } = seed
    const row = await repo.create(ctx, { name: seed.name, ...input })
    idByName.set(seed.name, row.id)
  }

  // The per-player grant: only `player-demo` may see the `restricted` informant.
  // `player-scout` gets no grant — so the ACL is observable by logging in as each.
  const silasId = idByName.get('Silas Crow')
  if (!silasId) throw new Error('seed inconsistency: Silas Crow was not created')
  await grantEntityVisibility(ctx, silasId, player.id)

  // Re-attach the shared demo principal if this instance has one. Rebuilding the
  // world above cascaded away whatever membership and grants it held, and the
  // failure is silent: /demo would still sign a visitor in, just into a world
  // picker with nothing in it. Same grant as player-demo, so the portfolio's
  // front door demonstrates per-player visibility rather than only public pages.
  const demoAccount = await db
    .selectFrom('accounts')
    .select('id')
    .where('username', '=', DEMO_USER)
    .executeTakeFirst()
  if (demoAccount) {
    await upsertMember(db, { world_id: world.id, account_id: demoAccount.id, role: 'player' })
    await grantEntityVisibility(ctx, silasId, demoAccount.id)
    console.log(`  re-attached demo principal "${DEMO_USER}" to the showcase world`)
  }

  const pub = SEEDS.filter((s) => s.visibility === 'public').length
  const dmOnly = SEEDS.filter((s) => s.visibility === 'dm_only').length
  const restricted = SEEDS.filter((s) => s.visibility === 'restricted').length

  console.log(`\nSeeded world "${world.name}" (slug: ${world.slug})`)
  console.log(
    `  ${SEEDS.length} entities: ${pub} public, ${dmOnly} dm-only, ${restricted} restricted\n`,
  )
  console.log('Accounts (demo passwords — local DB only):')
  console.log(`  owner   ${DM_USER.padEnd(13)} ${DM_PASSWORD}   (sees everything)`)
  console.log(
    `  player  ${PLAYER_USER.padEnd(13)} ${PLAYER_PASSWORD}   (public + granted "Silas Crow")`,
  )
  console.log(`  player  ${SCOUT_USER.padEnd(13)} ${PLAYER_PASSWORD}   (public only — no grant)\n`)
  console.log('Log in as each to watch the visibility model: the player accounts')
  console.log('cannot see the dm-only conspiracy, and only player-demo sees Silas Crow.\n')
} finally {
  await db.destroy()
}
