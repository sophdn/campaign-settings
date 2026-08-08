/** The authorization security core — the single seam for world-scoped access. */
export { resolveWorldContext } from './context'
export {
  assertContentWrite,
  assertWorldOwner,
  createContentRepository,
  type ContentTableName,
} from './content'
export { assertPlayerDataWrite, playerDataReadScope } from './player-data'
export { ForbiddenError } from './errors'
