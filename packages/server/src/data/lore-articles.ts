import { createContentRepository } from '../authz/content'
import { DETAIL_SPECS } from './entity-details'

/**
 * The wiki-entry repository (lore articles). Like npcs, an instance of the
 * content-authorization seam over the `entities` base table (kind `lore_article`,
 * with `lore_article_details` merged in) — world-scoped, dm_only-filtered,
 * owner-write.
 */
const repo = createContentRepository('entities', {
  kind: 'lore_article',
  detail: DETAIL_SPECS.lore_article,
})

export const createLoreArticle = repo.create
export const getLoreArticle = repo.get
export const listLoreArticles = repo.list
export const updateLoreArticle = repo.update
export const softDeleteLoreArticle = repo.softDelete
