import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MemberView } from '../api'
import { makeApi } from '../testing/fake-api'
import { EntityVisibilityPanel } from './entity-visibility-panel'

const member = (over: Partial<MemberView> = {}): MemberView => ({
  accountId: 'p1',
  username: 'player-one',
  role: 'player',
  joinedAt: '2026-07-20T10:00:00.000Z',
  ...over,
})

const OWNER = member({ accountId: 'a', username: 'dm', role: 'owner' })

function renderPanel(
  api: ApiClient,
  initialVisibility: 'public' | 'dm_only' | 'restricted' = 'restricted',
): void {
  render(
    <EntityVisibilityPanel
      api={api}
      worldId="w"
      kind="npc"
      entityId="e"
      initialVisibility={initialVisibility}
    />,
  )
}

describe('EntityVisibilityPanel — the level', () => {
  it('shows the current level in plain language', async () => {
    renderPanel(makeApi(), 'dm_only')
    const select = screen.getByLabelText('Visibility') as HTMLSelectElement
    expect(select.value).toBe('dm_only')
    expect(await screen.findByText(/Choose "Only the players you choose"/)).toBeTruthy()
  })

  it('changes the level and reflects it without a reload', async () => {
    const updateEntity = vi.fn(() => Promise.resolve({ id: 'e' }))
    renderPanel(makeApi({ updateEntity }), 'public')

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'restricted' } })

    await waitFor(() =>
      expect(updateEntity).toHaveBeenCalledWith('w', 'npc', 'e', { visibility: 'restricted' }),
    )
    // the per-player list is now the thing on screen
    expect(await screen.findByText(/No players in this world yet/)).toBeTruthy()
  })

  it('surfaces a refused level change and keeps the old level', async () => {
    renderPanel(
      makeApi({
        updateEntity: () => Promise.reject(new ApiClientError(403, 'forbidden', 'owner only')),
      }),
      'public',
    )

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'restricted' } })

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect((screen.getByLabelText('Visibility') as HTMLSelectElement).value).toBe('public')
  })

  it('does not call the server when the level is re-selected unchanged', async () => {
    const updateEntity = vi.fn(() => Promise.resolve({ id: 'e' }))
    renderPanel(makeApi({ updateEntity }), 'public')

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'public' } })

    await waitFor(() => expect(screen.getByLabelText('Visibility')).toBeTruthy())
    expect(updateEntity).not.toHaveBeenCalled()
  })

  it('says grants are kept but inactive while the page is not restricted', async () => {
    renderPanel(
      makeApi({
        listMembers: vi.fn(() => Promise.resolve([OWNER, member()])),
        listEntityGrants: vi.fn(() => Promise.resolve(['p1'])),
      }),
      'dm_only',
    )

    expect(await screen.findByText(/1 player grant\(s\) are kept but inactive/)).toBeTruthy()
  })
})

describe('EntityVisibilityPanel — per-player grants', () => {
  const withMembers = (over: Partial<ApiClient> = {}): ApiClient =>
    makeApi({ listMembers: vi.fn(() => Promise.resolve([OWNER, member()])), ...over })

  it('lists players with whether they can see the page, and never offers the owner', async () => {
    renderPanel(withMembers({ listEntityGrants: vi.fn(() => Promise.resolve(['p1'])) }))

    expect(await screen.findByText('player-one')).toBeTruthy()
    expect(screen.getByText('can see it')).toBeTruthy()
    // the owner sees everything, so a control for them could not change anything
    expect(screen.queryByText('dm')).toBeNull()
  })

  it('grants a player and re-reads the server list rather than guessing', async () => {
    const grantEntityAccess = vi.fn(() => Promise.resolve())
    const listEntityGrants = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(['p1'])
    renderPanel(withMembers({ grantEntityAccess, listEntityGrants }))

    fireEvent.click(await screen.findByRole('button', { name: 'Grant player-one' }))

    await waitFor(() => expect(grantEntityAccess).toHaveBeenCalledWith('w', 'npc', 'e', 'p1'))
    expect(await screen.findByRole('button', { name: 'Revoke player-one' })).toBeTruthy()
    expect(screen.getByText('can see it')).toBeTruthy()
  })

  it('revokes a player and reflects the loss of access', async () => {
    const revokeEntityAccess = vi.fn(() => Promise.resolve())
    const listEntityGrants = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['p1'])
      .mockResolvedValue([])
    renderPanel(withMembers({ revokeEntityAccess, listEntityGrants }))

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke player-one' }))

    await waitFor(() => expect(revokeEntityAccess).toHaveBeenCalledWith('w', 'npc', 'e', 'p1'))
    expect(await screen.findByRole('button', { name: 'Grant player-one' })).toBeTruthy()
    expect(screen.getByText('cannot see it')).toBeTruthy()
  })

  it('surfaces a refused grant', async () => {
    renderPanel(
      withMembers({
        grantEntityAccess: () => Promise.reject(new ApiClientError(403, 'forbidden', 'owner only')),
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Grant player-one' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('surfaces a failure to load who can see the page', async () => {
    renderPanel(makeApi({ listMembers: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('says so when the world has no players to grant to', async () => {
    renderPanel(withMembers({ listMembers: vi.fn(() => Promise.resolve([OWNER])) }))
    expect(await screen.findByText(/No players in this world yet/)).toBeTruthy()
  })
})
