import { contentKinds } from '@campaign-settings/shared'
import { describe, expect, it } from 'vitest'
import { CONTENT_REPOS, ENTITY_REPOS } from './content-repos'

describe('CONTENT_REPOS', () => {
  it('exactly matches the shared contentKinds() set (single source of truth for suggestable kinds)', () => {
    const repoKinds = Object.keys(CONTENT_REPOS).sort()
    const sharedKinds = contentKinds()
      .map((k) => k.kind)
      .sort()
    expect(repoKinds).toEqual(sharedKinds)
  })
})

describe('ENTITY_REPOS', () => {
  it('is the CRUD dispatch superset: every content repo plus the two bespoke tables', () => {
    expect(Object.keys(ENTITY_REPOS).sort()).toEqual(
      [...Object.keys(CONTENT_REPOS), 'session', 'map'].sort(),
    )
  })

  it('serves the bespoke kinds for CRUD but keeps them OUT of the suggestable set', () => {
    // Both ride the content seam (their tables have the world_id / visibility /
    // deleted_at shape) without being among the 16 kinds folded into `entities`,
    // and neither is something a player proposes an edit to.
    for (const kind of ['session', 'map'] as const) {
      expect(ENTITY_REPOS[kind]).toBeDefined()
      expect(CONTENT_REPOS[kind]).toBeUndefined()
    }
  })
})
