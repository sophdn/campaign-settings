import { createContentRepository } from '../authz/content'
import { DETAIL_SPECS } from './entity-details'

/**
 * The npcs repository — the canonical instance of the content-authorization
 * seam over the shared `entities` base table (filtered to kind `npc`, with the
 * `npc_details` table merged in). Every per-kind content repo is created the
 * same way; all world-scoping / visibility / soft-delete / owner-write rules
 * live in createContentRepository, not here.
 */
const repo = createContentRepository('entities', { kind: 'npc', detail: DETAIL_SPECS.npc })

export const createNpc = repo.create
export const getNpc = repo.get
export const listNpcs = repo.list
export const updateNpc = repo.update
export const softDeleteNpc = repo.softDelete

export type NewNpc = Parameters<typeof repo.create>[1]
export type NpcPatch = Parameters<typeof repo.update>[2]
