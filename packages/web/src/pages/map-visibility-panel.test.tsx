import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MemberView } from '../api'
import { makeApi } from '../testing/fake-api'
import { MapVisibilityPanel } from './map-visibility-panel'

const MEMBERS: MemberView[] = [
  { accountId: 'a', username: 'dm', role: 'owner', joinedAt: '2026-07-20T10:00:00.000Z' },
  { accountId: 'p1', username: 'player-one', role: 'player', joinedAt: '2026-07-20T10:00:00.000Z' },
]

function renderPanel(
  api: ApiClient,
  initial: 'public' | 'dm_only' | 'restricted' = 'public',
): void {
  render(<MapVisibilityPanel api={api} worldId="w" mapId="m1" initialVisibility={initial} />)
}

describe('MapVisibilityPanel', () => {
  /**
   * The point of the whole change: `restricted` used to be refused for maps
   * because a grant naming one could not be stored. It is now offered.
   */
  it('offers all three levels, including the one maps could not have', async () => {
    renderPanel(makeApi({ listMembers: vi.fn(() => Promise.resolve(MEMBERS)) }))
    const select = (await screen.findByLabelText('Visibility')) as HTMLSelectElement
    const values = [...select.options].map((o) => o.value)
    expect(values).toEqual(['public', 'dm_only', 'restricted'])
  })

  it('sets the level through updateMap', async () => {
    const updateMap = vi.fn(() => Promise.resolve({ id: 'm1' } as never))
    renderPanel(makeApi({ updateMap, listMembers: vi.fn(() => Promise.resolve(MEMBERS)) }))

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'restricted' } })
    await waitFor(() =>
      expect(updateMap).toHaveBeenCalledWith('w', 'm1', { visibility: 'restricted' }),
    )
  })

  it('grants and revokes a named player on the map', async () => {
    let grants: string[] = []
    const grantMapAccess = vi.fn((_w: string, _m: string, accountId: string) => {
      grants = [accountId]
      return Promise.resolve(undefined)
    })
    const revokeMapAccess = vi.fn(() => {
      grants = []
      return Promise.resolve(undefined)
    })
    renderPanel(
      makeApi({
        grantMapAccess,
        revokeMapAccess,
        listMapGrants: vi.fn(() => Promise.resolve(grants)),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
      }),
      'restricted',
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Grant player-one' }))
    await waitFor(() => expect(grantMapAccess).toHaveBeenCalledWith('w', 'm1', 'p1'))

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke player-one' }))
    await waitFor(() => expect(revokeMapAccess).toHaveBeenCalledWith('w', 'm1', 'p1'))
  })

  it('does not offer the owner a grant to themselves', async () => {
    renderPanel(
      makeApi({
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
        listMapGrants: vi.fn(() => Promise.resolve([])),
      }),
      'restricted',
    )
    expect(await screen.findByRole('button', { name: 'Grant player-one' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Grant dm' })).toBeNull()
  })

  it('says sharing the map does not share what is pinned on it', async () => {
    renderPanel(makeApi({ listMembers: vi.fn(() => Promise.resolve(MEMBERS)) }))
    // The per-pin filter is the non-obvious half; a DM who assumed otherwise
    // would over-share by accident.
    expect(
      await screen.findByText(/only see pins pointing at entries they are allowed to see/i),
    ).toBeTruthy()
  })

  it('surfaces a failed member load', async () => {
    renderPanel(
      makeApi({
        listMembers: vi.fn(() => Promise.reject(new ApiClientError(500, 'oops', 'members down'))),
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('members down')
  })
})
