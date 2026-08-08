import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ApiClient, BlockingWorld } from '../api'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { Panel } from '../components/panel'
import { ErrorText } from '../components/status'

/**
 * Everything the account owns, across every world it belongs to, as a
 * downloadable file. Assembled from `listWorlds` + the two player-data routes,
 * all of which already return exactly the caller's own rows — so this cannot
 * read anything the account could not already read.
 *
 * Deliberately not the world export (`exportWorld`), which is owner-gated and
 * returns the WORLD's content. A departing player exports THEIR data.
 */
async function buildMyDataFile(api: ApiClient): Promise<{ url: string; filename: string }> {
  const worlds = await api.listWorlds()
  const perWorld = await Promise.all(
    worlds.map(async (w) => ({
      world: { id: w.id, name: w.name, slug: w.slug, role: w.role },
      notes: await api.listNotes(w.id),
      characters: await api.listCharacters(w.id),
    })),
  )
  const blob = new Blob([JSON.stringify({ worlds: perWorld }, null, 2)], {
    type: 'application/json',
  })
  return { url: URL.createObjectURL(blob), filename: 'my-campaign-settings-data.json' }
}

/**
 * Close the account for good.
 *
 * Three things stand between a stray click and an irreversible delete: the
 * blocking-worlds check, an explicit confirmation step, and the current
 * password. The password is the one that matters — deletion is irreversible,
 * and a session left open on a shared machine should not be enough to end
 * someone's account. The server demands it too; this is not the gate.
 *
 * The copy states the cascade plainly, including that it is a HARD delete. A
 * page that says "deleted" while meaning "hidden" is the kind of claim worth
 * getting right.
 */
export function DeleteAccountPanel({ api }: { api: ApiClient }): React.JSX.Element {
  const [blockers, setBlockers] = useState<BlockingWorld[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null)

  const loadBlockers = useCallback(async () => {
    try {
      setBlockers(await api.deletionBlockers())
    } catch (err) {
      setError(errorMessage(err, 'Could not check whether your account can be deleted'))
    }
  }, [api])

  useEffect(() => {
    void loadBlockers()
  }, [loadBlockers])

  async function onPrepareDownload(): Promise<void> {
    setError(null)
    try {
      setDownload(await buildMyDataFile(api))
    } catch (err) {
      setError(errorMessage(err, 'Could not prepare your data'))
    }
  }

  async function onDelete(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.deleteAccount(password)
      // The account and every session with it are gone. A full reload is the
      // honest thing here: there is no signed-in state left to reconcile.
      window.location.assign('/login')
    } catch (err) {
      setError(errorMessage(err, 'Could not delete your account'))
      // A refused delete may mean a world appeared since the check.
      await loadBlockers()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Delete your account">
      <h2>Delete your account</h2>
      <p>
        This permanently deletes your account, your notes and characters in every world, the pages
        GMs shared with you, your suggestions, and every session you have open. It cannot be undone
        and nothing is kept. Worlds you belong to stay, along with anything a GM has already
        accepted from you.
      </p>
      <ErrorText>{error}</ErrorText>

      {download ? (
        <p>
          <a href={download.url} download={download.filename}>
            Download all my data
          </a>
        </p>
      ) : (
        <p>
          <Button variant="secondary" onClick={() => void onPrepareDownload()}>
            Prepare all my data for download
          </Button>
        </p>
      )}

      {blockers === null ? null : blockers.length > 0 ? (
        <div role="status">
          <p>
            You still own {blockers.length === 1 ? 'a world' : 'these worlds'}. Hand each one to
            another member, or delete it, and then you can delete your account:
          </p>
          <ul>
            {blockers.map((w) => (
              <li key={w.id}>{w.name}</li>
            ))}
          </ul>
        </div>
      ) : confirming ? (
        <form onSubmit={(e) => void onDelete(e)} aria-label="Confirm account deletion">
          <TextField
            label="Your password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Button variant="danger" type="submit" disabled={busy}>
            Permanently delete my account
          </Button>{' '}
          <Button variant="secondary" type="button" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete my account
        </Button>
      )}
    </Panel>
  )
}
