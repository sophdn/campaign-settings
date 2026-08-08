import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemberView, PendingTransfer } from '../api'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { SelectField } from '../components/field'
import { Panel } from '../components/panel'
import { ErrorText } from '../components/status'

/**
 * Leaving a world, and handing one over. Both live under the member list
 * because that is where a person goes to ask "who is in this, and am I?".
 */

/**
 * Build the leaver's own data as a downloadable file, from the two routes that
 * already return exactly their own rows.
 *
 * Deliberately NOT a new server endpoint. `listNotes` and `listCharacters` are
 * already scoped to the caller by `authz/player-data.ts`, so assembling the file
 * here cannot widen what anyone can read — whereas a new "export" route is
 * precisely where a departing player's download quietly becomes the world's.
 */
async function buildMyDataFile(
  api: ApiClient,
  worldId: string,
): Promise<{ url: string; filename: string }> {
  const [notes, characters] = await Promise.all([
    api.listNotes(worldId),
    api.listCharacters(worldId),
  ])
  const blob = new Blob([JSON.stringify({ worldId, notes, characters }, null, 2)], {
    type: 'application/json',
  })
  return { url: URL.createObjectURL(blob), filename: `my-data-${worldId}.json` }
}

/**
 * The player's exit. Says plainly what leaving destroys BEFORE offering the
 * button, and offers the download first — the decision the task recorded is
 * "delete, with an export offered", and an export nobody is shown is not an
 * export.
 */
export function LeaveWorldPanel({
  api,
  worldId,
  onLeft,
}: {
  api: ApiClient
  worldId: string
  onLeft: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null)

  async function onPrepareDownload(): Promise<void> {
    setError(null)
    try {
      setDownload(await buildMyDataFile(api, worldId))
    } catch (err) {
      setError(errorMessage(err, 'Could not prepare your data'))
    }
  }

  async function onLeave(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await api.leaveWorld(worldId)
      onLeft()
    } catch (err) {
      setError(errorMessage(err, 'Could not leave this world'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Leave this world">
      <h2>Leave this world</h2>
      <p>
        Leaving removes you from the world and permanently deletes your notes and characters in it,
        along with access to any pages the GM shared with you. The world&rsquo;s own content is not
        affected. Download your notes and characters first if you want to keep them.
      </p>
      <ErrorText>{error}</ErrorText>
      {download ? (
        <p>
          <a href={download.url} download={download.filename}>
            Download my notes and characters
          </a>
        </p>
      ) : (
        <Button variant="secondary" onClick={() => void onPrepareDownload()}>
          Prepare my data for download
        </Button>
      )}{' '}
      {confirming ? (
        <>
          <p role="status">
            This cannot be undone. Your notes and characters in this world will be deleted.
          </p>
          <Button variant="danger" disabled={busy} onClick={() => void onLeave()}>
            Yes, leave and delete my data
          </Button>{' '}
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Leave this world
        </Button>
      )}
    </Panel>
  )
}

/**
 * The owner's exit. An owner cannot leave — the world would be ownerless — so
 * this offers the world to a member, who must accept. Until they do, nothing
 * has moved, and the panel says so rather than implying the handover is done.
 */
export function TransferOwnershipPanel({
  api,
  worldId,
  members,
  onTransferred,
}: {
  api: ApiClient
  worldId: string
  /** Candidate recipients — players only; the caller filters the owner out. */
  members: MemberView[]
  onTransferred: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState<PendingTransfer | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPending(await api.getPendingTransfer(worldId))
    } catch (err) {
      setError(errorMessage(err, 'Could not check for a pending transfer'))
    }
  }, [api, worldId])

  useEffect(() => {
    void load()
  }, [load])

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await action()
      await load()
      onTransferred()
    } catch (err) {
      setError(errorMessage(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  const target = choice || members[0]?.accountId || ''

  return (
    <Panel ariaLabel="Transfer ownership">
      <h2>Transfer ownership</h2>
      <p>
        You cannot leave a world you own. Hand it to another member instead, or delete it. They have
        to accept — nothing changes until they do, and you stay the owner until then.
      </p>
      <ErrorText>{error}</ErrorText>
      {pending ? (
        <>
          <p role="status">
            Offered to {pending.username}. They have not accepted yet, so you are still the owner.
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(() => api.cancelOwnershipOffer(worldId), 'Could not withdraw the offer')
            }
          >
            Withdraw the offer
          </Button>
        </>
      ) : members.length === 0 ? (
        <p className="empty-state">There is nobody to hand it to yet — invite a player first.</p>
      ) : (
        <div className="form-actions">
          <SelectField
            label="Member"
            ariaLabel="Member"
            value={target}
            onChange={setChoice}
            options={members.map((m) => ({ value: m.accountId, label: m.username }))}
          />
          <Button
            disabled={busy}
            onClick={() =>
              void run(() => api.offerOwnership(worldId, target), 'Could not offer the world')
            }
          >
            Offer ownership
          </Button>
        </div>
      )}
    </Panel>
  )
}

/**
 * What the RECIPIENT of an offer sees. Rendered only when the pending transfer
 * names the viewer — the accept is refused server-side for anyone else, so this
 * is presentation, not the gate.
 */
export function AcceptOwnershipPanel({
  api,
  worldId,
  onAccepted,
}: {
  api: ApiClient
  worldId: string
  onAccepted: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAccept(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await api.acceptOwnership(worldId)
      onAccepted()
    } catch (err) {
      setError(errorMessage(err, 'Could not accept ownership'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Ownership offered to you">
      <h2>You have been offered this world</h2>
      <p>
        Accepting makes you the GM. The current owner becomes a player and keeps their notes and
        characters. As owner you will not be able to leave without handing it on again.
      </p>
      <ErrorText>{error}</ErrorText>
      <Button disabled={busy} onClick={() => void onAccept()}>
        Accept ownership
      </Button>
    </Panel>
  )
}
