import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CreatedInvitation, InvitationView, MemberView, PendingTransfer } from '../api'
import { useApi } from '../app/api-context'
import { useAuth } from '../app/auth-context'
import { errorMessage } from '../app/error-message'
import { useIsOwner, useWorld } from '../app/world-context'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'
import {
  AcceptOwnershipPanel,
  LeaveWorldPanel,
  TransferOwnershipPanel,
} from './world-membership-panels'

/** Absolute local time — these lists are about recognition, not precision. */
const when = (iso: string): string => new Date(iso).toLocaleString()

/** The absolute link an invitee opens. Built from the live origin so it works in any deploy. */
const inviteLink = (token: string): string => `${window.location.origin}/invite/${token}`

/**
 * Who is in this world, and — for the owner — how to change that.
 *
 * Every member can read the list; only the owner sees the invite form, the
 * invitation list, and the remove buttons. That split is a courtesy, not the
 * gate: the server rejects the owner-only calls for a player regardless of what
 * this component renders, which is what `members.spec.ts` asserts.
 *
 * The invite flow has one sharp edge worth reading before changing it. A freshly
 * minted token is returned exactly once and only its hash is stored, so it can
 * never be recovered from the invitation list. The component therefore holds the
 * new link in state and says plainly that it will not be shown again.
 *
 * The page also carries the two ways OUT of a world: a player leaves, an owner
 * hands it over. They belong here because this is where a person comes to ask
 * who is in this world and whether they still are.
 */
export function MembersPage(): React.JSX.Element {
  const api = useApi()
  const { worldId, refreshWorld } = useWorld()
  const { account } = useAuth()
  const isOwner = useIsOwner()

  const [members, setMembers] = useState<MemberView[] | null>(null)
  const [membersError, setMembersError] = useState<string | null>(null)

  const [invitations, setInvitations] = useState<InvitationView[] | null>(null)
  const [invitationsError, setInvitationsError] = useState<string | null>(null)

  const navigate = useNavigate()
  const [pendingTransfer, setPendingTransfer] = useState<PendingTransfer | null>(null)

  const [inviteUsername, setInviteUsername] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [minted, setMinted] = useState<CreatedInvitation | null>(null)

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await api.listMembers(worldId))
    } catch (err) {
      setMembersError(errorMessage(err, 'Could not load the member list'))
    }
  }, [api, worldId])

  const loadInvitations = useCallback(async () => {
    // Owner-only server-side; asking as a player would just draw a 403.
    if (!isOwner) return
    try {
      setInvitations(await api.listInvitations(worldId))
    } catch (err) {
      setInvitationsError(errorMessage(err, 'Could not load invitations'))
    }
  }, [api, worldId, isOwner])

  // Any member may read the pending offer: the recipient has to be able to see
  // that they have been offered the world.
  const loadPendingTransfer = useCallback(async () => {
    try {
      setPendingTransfer(await api.getPendingTransfer(worldId))
    } catch {
      // Non-fatal: the member list is the page's job, and a failed offer check
      // should not blank it. The panels surface their own errors when acted on.
    }
  }, [api, worldId])

  useEffect(() => {
    void loadMembers()
    void loadInvitations()
    void loadPendingTransfer()
  }, [loadMembers, loadInvitations, loadPendingTransfer])

  /** Back to the world picker — the current world is no longer ours to be on. */
  const onLeft = (): void => {
    void navigate('/')
  }

  async function onInvite(e: FormEvent): Promise<void> {
    e.preventDefault()
    setInviteError(null)
    setMinted(null)
    setInviteBusy(true)
    try {
      // An empty field means an open link, so the name is passed only when set.
      const created = await api.createInvitation(worldId, inviteUsername.trim() || undefined)
      setMinted(created)
      setInviteUsername('')
      await loadInvitations()
    } catch (err) {
      setInviteError(errorMessage(err, 'Could not create the invitation'))
    } finally {
      setInviteBusy(false)
    }
  }

  async function onRevokeInvitation(id: string): Promise<void> {
    setInvitationsError(null)
    try {
      await api.revokeInvitation(worldId, id)
      await loadInvitations()
    } catch (err) {
      setInvitationsError(errorMessage(err, 'Could not revoke the invitation'))
    }
  }

  async function onRemoveMember(accountId: string): Promise<void> {
    setMembersError(null)
    try {
      await api.revokeMember(worldId, accountId)
      await loadMembers()
    } catch (err) {
      setMembersError(errorMessage(err, 'Could not remove that member'))
    }
  }

  return (
    <div>
      <PageHeader title="Members" />

      <Panel ariaLabel="Members">
        <ErrorText>{membersError}</ErrorText>
        {members === null ? (
          <Loading />
        ) : members.length === 0 ? (
          <EmptyState>No members yet.</EmptyState>
        ) : (
          <ul>
            {members.map((m) => (
              <li key={m.accountId}>
                {/* The name is its own element so it is addressable on its own —
                    as a bare text node beside the badge, nothing can select it. */}
                <strong>{m.username}</strong> <Badge>{m.role}</Badge>
                {m.accountId === account?.id ? ' — you' : ''}
                <br />
                <small>Joined {when(m.joinedAt)}</small>
                {/* The owner cannot be removed — the server refuses it, and
                    offering the button would only produce a 403. */}
                {isOwner && m.role !== 'owner' ? (
                  <>
                    {' '}
                    <Button variant="secondary" onClick={() => void onRemoveMember(m.accountId)}>
                      Remove {m.username}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {isOwner ? (
        <>
          <Panel>
            <form onSubmit={(e) => void onInvite(e)} aria-label="Invite someone">
              <h2>Invite</h2>
              <TextField
                label="Username (leave blank for an open link)"
                value={inviteUsername}
                onChange={setInviteUsername}
                autoComplete="off"
              />
              <p className="empty-state">
                Naming someone pins the invitation to that account. Leaving it blank creates a link
                anyone can use once.
              </p>
              <ErrorText>{inviteError}</ErrorText>
              <Button type="submit" disabled={inviteBusy}>
                Create invitation
              </Button>
            </form>
            {minted ? (
              <div role="status">
                <p>
                  Copy this link now — it will not be shown again, and it cannot be recovered from
                  the list below.
                </p>
                <p>
                  <code>{inviteLink(minted.token)}</code>
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel ariaLabel="Invitations">
            <h2>Invitations</h2>
            <ErrorText>{invitationsError}</ErrorText>
            {invitations === null ? (
              <Loading />
            ) : invitations.length === 0 ? (
              <EmptyState>No invitations yet.</EmptyState>
            ) : (
              <ul>
                {invitations.map((inv) => (
                  <li key={inv.id}>
                    <strong>{inv.invitee ?? 'Open link'}</strong> <Badge>{inv.status}</Badge>
                    <br />
                    <small>
                      Created {when(inv.createdAt)} · expires {when(inv.expiresAt)}
                      {inv.acceptedAt ? ` · accepted ${when(inv.acceptedAt)}` : ''}
                    </small>
                    {/* Only a pending invitation can be revoked; an accepted one
                        is history, and removing that member is the list above. */}
                    {inv.status === 'pending' ? (
                      <>
                        {' '}
                        <Button variant="secondary" onClick={() => void onRevokeInvitation(inv.id)}>
                          Revoke invitation for {inv.invitee ?? 'open link'}
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <TransferOwnershipPanel
            api={api}
            worldId={worldId}
            members={(members ?? []).filter((m) => m.role !== 'owner')}
            onTransferred={() => {
              void loadMembers()
              void loadPendingTransfer()
            }}
          />
        </>
      ) : (
        <LeaveWorldPanel api={api} worldId={worldId} onLeft={onLeft} />
      )}

      {/* Only for the account the offer actually names. The server refuses
          everyone else's accept regardless, so this is presentation. */}
      {pendingTransfer && account && pendingTransfer.accountId === account.id ? (
        <AcceptOwnershipPanel
          api={api}
          worldId={worldId}
          onAccepted={() => {
            // The viewer is the GM now — the role in context is stale, and the
            // page would otherwise keep offering them the player view.
            refreshWorld()
            void loadMembers()
            void loadPendingTransfer()
          }}
        />
      ) : null}
    </div>
  )
}
