import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  type ApiClient,
  ApiClientError,
  type InvitationView,
  type MemberRole,
  type MemberView,
  type PublicAccount,
} from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { MembersPage } from './members-page'

const DM: PublicAccount = { id: 'a', username: 'dm' }

const member = (over: Partial<MemberView> = {}): MemberView => ({
  accountId: 'p1',
  username: 'player-one',
  role: 'player',
  joinedAt: '2026-07-20T10:00:00.000Z',
  ...over,
})

const invitation = (over: Partial<InvitationView> = {}): InvitationView => ({
  id: 'i1',
  status: 'pending',
  invitee: 'invitee-one',
  createdAt: '2026-07-25T10:00:00.000Z',
  expiresAt: '2026-08-01T10:00:00.000Z',
  acceptedAt: null,
  ...over,
})

function renderPage(api: ApiClient, role: MemberRole = 'owner'): void {
  render(
    <ApiProvider value={api}>
      <AuthProvider>
        <WorldRoleProvider value={{ worldId: 'w', worldName: 'W', role, refreshWorld: vi.fn() }}>
          <MemoryRouter>
            <MembersPage />
          </MemoryRouter>
        </WorldRoleProvider>
      </AuthProvider>
    </ApiProvider>,
  )
}

/** A signed-in fake with whatever member/invitation data the test needs. */
const signedIn = (over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ me: vi.fn(() => Promise.resolve(DM)), ...over })

describe('MembersPage — the member list', () => {
  it('lists members with their roles and marks the viewer', async () => {
    const listMembers = vi.fn(() =>
      Promise.resolve([member({ accountId: 'a', username: 'dm', role: 'owner' }), member()]),
    )
    renderPage(signedIn({ listMembers }))

    // Scoped: names also appear in the transfer picker's options.
    const list = await screen.findByLabelText('Members')
    expect(within(list).getByText('player-one')).toBeTruthy()
    expect(screen.getByText('owner')).toBeTruthy()
    expect(screen.getByText('player')).toBeTruthy()
    expect(screen.getByText(/— you/)).toBeTruthy()
  })

  it('shows an empty state when the world has no members', async () => {
    renderPage(signedIn({ listMembers: vi.fn(() => Promise.resolve([])) }))
    expect(await screen.findByText('No members yet.')).toBeTruthy()
  })

  it('surfaces a failure to load the list', async () => {
    renderPage(signedIn({ listMembers: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('removes a member and re-reads the list', async () => {
    const revokeMember = vi.fn(() => Promise.resolve())
    const listMembers = vi
      .fn<() => Promise<MemberView[]>>()
      .mockResolvedValueOnce([member()])
      .mockResolvedValue([])
    renderPage(signedIn({ revokeMember, listMembers }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove player-one' }))

    await waitFor(() => expect(revokeMember).toHaveBeenCalledWith('w', 'p1'))
    expect(await screen.findByText('No members yet.')).toBeTruthy()
  })

  it('surfaces a refused removal', async () => {
    renderPage(
      signedIn({
        listMembers: vi.fn(() => Promise.resolve([member()])),
        revokeMember: () => Promise.reject(new ApiClientError(403, 'forbidden', 'not the owner')),
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Remove player-one' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('offers no remove button for the owner row', async () => {
    renderPage(
      signedIn({
        listMembers: vi.fn(() =>
          Promise.resolve([member({ accountId: 'a', username: 'dm', role: 'owner' })]),
        ),
      }),
    )
    // The owner row reads "dm — you", so the name is not a standalone text node.
    await screen.findByText(/dm/)
    expect(screen.queryByRole('button', { name: 'Remove dm' })).toBeNull()
  })
})

describe('MembersPage — what a player sees', () => {
  it('shows the list read-only: no invite form, no invitation list, no remove buttons', async () => {
    const listInvitations = vi.fn(() => Promise.resolve([invitation()]))
    renderPage(
      signedIn({ listMembers: vi.fn(() => Promise.resolve([member()])), listInvitations }),
      'player',
    )

    expect(await screen.findByText('player-one')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove player-one' })).toBeNull()
    expect(screen.queryByLabelText('Invite someone')).toBeNull()
    expect(screen.queryByText('Invitations')).toBeNull()
    // and it does not even ask — the route is owner-only server-side
    expect(listInvitations).not.toHaveBeenCalled()
  })
})

describe('MembersPage — invitations', () => {
  it('mints a pinned invitation, shows the link once, and says it will not be shown again', async () => {
    const createInvitation = vi.fn(() => Promise.resolve({ id: 'i9', token: 'raw-token' }))
    renderPage(signedIn({ createInvitation }))

    fireEvent.change(screen.getByLabelText('Username (leave blank for an open link)'), {
      target: { value: 'invitee-one' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))

    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith('w', 'invitee-one'))
    expect(await screen.findByText(/will not be shown again/i)).toBeTruthy()
    expect(screen.getByText(`${window.location.origin}/invite/raw-token`)).toBeTruthy()
  })

  it('mints an OPEN link when the username is left blank', async () => {
    const createInvitation = vi.fn(() => Promise.resolve({ id: 'i9', token: 'raw-token' }))
    renderPage(signedIn({ createInvitation }))

    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))

    // undefined, not '' — an empty string would be a username the server rejects
    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith('w', undefined))
  })

  it('surfaces an unknown-username rejection rather than opening a wider link', async () => {
    renderPage(
      signedIn({
        createInvitation: () => Promise.reject(new ApiClientError(404, 'not_found', 'account')),
      }),
    )

    fireEvent.change(screen.getByLabelText('Username (leave blank for an open link)'), {
      target: { value: 'nobody' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/will not be shown again/i)).toBeNull()
  })

  it('lists invitations with status, naming an open link, and shows the empty state otherwise', async () => {
    renderPage(
      signedIn({
        listInvitations: vi.fn(() =>
          Promise.resolve([
            invitation(),
            invitation({
              id: 'i2',
              invitee: 'invitee-two',
              status: 'accepted',
              acceptedAt: '2026-07-26T10:00:00.000Z',
            }),
            invitation({ id: 'i3', status: 'expired', invitee: null }),
          ]),
        ),
      }),
    )

    expect(await screen.findByText('invitee-one')).toBeTruthy()
    expect(screen.getByText('accepted')).toBeTruthy()
    expect(screen.getByText('expired')).toBeTruthy()
    expect(screen.getByText('Open link')).toBeTruthy()
    // only the pending one is revocable
    expect(screen.getAllByRole('button', { name: /^Revoke invitation/ })).toHaveLength(1)
  })

  it('shows an empty state when there are no invitations', async () => {
    renderPage(signedIn({ listInvitations: vi.fn(() => Promise.resolve([])) }))
    expect(await screen.findByText('No invitations yet.')).toBeTruthy()
  })

  it('revokes a pending invitation and re-reads the list', async () => {
    const revokeInvitation = vi.fn(() => Promise.resolve())
    const listInvitations = vi
      .fn<() => Promise<InvitationView[]>>()
      .mockResolvedValueOnce([invitation()])
      .mockResolvedValue([invitation({ status: 'revoked' })])
    renderPage(signedIn({ revokeInvitation, listInvitations }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke invitation for invitee-one' }),
    )

    await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith('w', 'i1'))
    expect(await screen.findByText('revoked')).toBeTruthy()
  })

  it('names an open link in the revoke button too', async () => {
    renderPage(
      signedIn({
        listInvitations: vi.fn(() => Promise.resolve([invitation({ invitee: null })])),
      }),
    )
    expect(
      await screen.findByRole('button', { name: 'Revoke invitation for open link' }),
    ).toBeTruthy()
  })

  it('surfaces a failure to load invitations', async () => {
    renderPage(signedIn({ listInvitations: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('surfaces a failure to revoke', async () => {
    renderPage(
      signedIn({
        listInvitations: vi.fn(() => Promise.resolve([invitation()])),
        revokeInvitation: () => Promise.reject(new ApiClientError(404, 'not_found', 'invitation')),
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke invitation for invitee-one' }),
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
