import { contentKinds } from '@campaign-settings/shared'
import { createContentRepository } from '../authz/content'
import type { WorldContext } from './context'
import { DETAIL_SPECS } from './entity-details'

/**
 * Registry of content-entity repos keyed by registry kind. Used where a feature
 * needs to reach an entity by kind at runtime (the entities route, the
 * suggestion queue). Each is an instance of the content-authorization seam over
 * the shared `entities` base table (filtered to its `kind`, with its detail
 * table merged in), so reads/writes are already world-scoped, dm_only-filtered,
 * and owner-gated.
 */

/** The repo surface a by-kind consumer needs (CRUD over the content seam). */
export interface ContentRepoLike {
  list(ctx: WorldContext): Promise<ReadonlyArray<{ id: string }>>
  get(ctx: WorldContext, id: string): Promise<{ id: string } | undefined>
  create(ctx: WorldContext, input: Record<string, unknown>): Promise<{ id: string }>
  update(
    ctx: WorldContext,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ id: string } | undefined>
  softDelete(ctx: WorldContext, id: string): Promise<boolean>
  listDeleted(ctx: WorldContext): Promise<ReadonlyArray<{ id: string }>>
  restore(ctx: WorldContext, id: string): Promise<boolean>
  purge(ctx: WorldContext, id: string): Promise<boolean>
}

/**
 * One repo per content kind, built from the shared `contentKinds()` set so the
 * registry can never drift from the taxonomy. Each targets the `entities` base
 * table filtered to that kind, with the kind's detail table (if any) merged in.
 */
export const CONTENT_REPOS: Readonly<Record<string, ContentRepoLike>> = Object.fromEntries(
  contentKinds().map((k) => [
    k.kind,
    createContentRepository('entities', { kind: k.kind, detail: DETAIL_SPECS[k.kind] }),
  ]),
)

/**
 * Registry the entity-CRUD route dispatches over. A superset of CONTENT_REPOS:
 * it adds `session`, which rides the same content seam (the sessions table has
 * the world_id/visibility/deleted_at shape) but is deliberately NOT a suggestion
 * target — so it lives here, not in CONTENT_REPOS. The split keeps "kinds you
 * can CRUD" separate from "kinds you can propose edits to": the suggestion
 * queue (suggestions.ts) and its parity with the shared contentKinds() set stay
 * keyed off CONTENT_REPOS, while the entities route reaches sessions too.
 *
 * Sessions are their own bespoke table (captured_text/played_at, entity touches,
 * graph edges) — not folded into `entities` — but ride the seam for world-scope,
 * soft-delete, member-read and owner-only writes.
 */
export const ENTITY_REPOS: Readonly<Record<string, ContentRepoLike>> = {
  ...CONTENT_REPOS,
  session: createContentRepository('sessions', { kind: 'session' }),
  // Maps join sessions as a bespoke table riding the seam. Registering the repo
  // here is not a convenience: the media raw route resolves an attachment's
  // owner through `repoOf(owner_kind)` before serving a byte, so a map image is
  // gated by its map's visibility only because this entry exists. Like session,
  // a map is not a suggestion target, so it stays out of CONTENT_REPOS.
  map: createContentRepository('maps', {
    kind: 'map',
    // Maps carry their own ACL: `entity_visibility.entity_id` is foreign-keyed
    // to `entities`, so a grant naming a map cannot live there. Passing the
    // table here is the whole of what makes a map `restricted`-able (0016).
    grantTable: { table: 'map_visibility', subjectColumn: 'map_id' },
  }),
}
