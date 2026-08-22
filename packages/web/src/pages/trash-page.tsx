import { findKindEntry } from '@campaign-settings/shared'
import { useCallback, useEffect, useState } from 'react'
import type { TrashEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useIsOwner, useWorld } from '../app/world-context'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'

/** Absolute local time — the trash is read to recognise a deletion, not to time it. */
const when = (iso: string): string => new Date(iso).toLocaleString()

/** The registry's singular label, or the raw kind for anything unregistered. */
const kindLabel = (kind: string): string => findKindEntry(kind)?.label.singular ?? kind

/** Group entries by kind, preserving the newest-first order the server sent. */
function byKind(entries: readonly TrashEntry[]): Array<[string, TrashEntry[]]> {
  const groups = new Map<string, TrashEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.kind)
    if (group) group.push(entry)
    else groups.set(entry.kind, [entry])
  }
  return [...groups].sort(([a], [b]) => kindLabel(a).localeCompare(kindLabel(b)))
}

/**
 * Deleted content, and the two things that can happen to it.
 *
 * Deleting an entity has always been a soft delete, which meant every deletion
 * was recoverable in principle and unrecoverable in practice — this page is the
 * way back. It is also the ONLY way to destroy anything for good: the row has to
 * be in the trash before it can be purged, so permanent loss takes two separate
 * acts rather than one mis-click.
 *
 * Purge asks for a second click on the same row rather than opening a dialog.
 * The confirmation names the entity, and it sits where the entity is, so the
 * thing being destroyed and the sentence describing it cannot come apart — which
 * is the failure a modal invites when the list behind it has moved on.
 *
 * There is no auto-purge and nothing expires. Sophi's call, 2026-08-08: a
 * campaign is years of writing, and a timer that quietly finishes deleting it is
 * a worse problem than a trash list that gets long.
 *
 * Owner-only, and the server enforces that on all three calls. The player copy
 * below is a courtesy, not the gate.
 */
export function TrashPage(): React.JSX.Element {
  const api = useApi()
  const { worldId } = useWorld()
  const isOwner = useIsOwner()

  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The row whose permanent delete is awaiting its second click, as `kind:id`. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isOwner) return
    try {
      setEntries(await api.listTrash(worldId))
    } catch (err) {
      setError(errorMessage(err, 'Could not load the trash'))
    }
  }, [api, worldId, isOwner])

  useEffect(() => {
    void load()
  }, [load])

  const key = (entry: TrashEntry): string => `${entry.kind}:${entry.id}`

  async function act(entry: TrashEntry, what: 'restore' | 'purge'): Promise<void> {
    setError(null)
    setBusy(key(entry))
    try {
      if (what === 'restore') await api.restoreTrashed(worldId, entry.kind, entry.id)
      else await api.purgeTrashed(worldId, entry.kind, entry.id)
      setConfirming(null)
      await load()
    } catch (err) {
      setError(
        errorMessage(
          err,
          what === 'restore' ? 'Could not restore that' : 'Could not delete that permanently',
        ),
      )
    } finally {
      setBusy(null)
    }
  }

  if (!isOwner) {
    return (
      <div>
        <PageHeader title="Trash" />
        <Panel ariaLabel="Trash">
          <p>Only the GM can see what has been deleted from this world.</p>
        </Panel>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Trash" />
      <Panel ariaLabel="Trash">
        <p>
          Anything you delete comes here and stays here. Nothing is removed on a schedule — a
          deleted page is gone from the wiki and from your players&rsquo; view, but it is still
          yours until you say otherwise.
        </p>
        <ErrorText>{error}</ErrorText>
        {entries === null ? (
          <Loading />
        ) : entries.length === 0 ? (
          <EmptyState>Nothing has been deleted.</EmptyState>
        ) : null}
      </Panel>

      {entries !== null && entries.length > 0
        ? byKind(entries).map(([kind, group]) => (
            <Panel key={kind} ariaLabel={`Deleted ${kindLabel(kind)}`}>
              <h2>{kindLabel(kind)}</h2>
              <ul>
                {group.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.name}</strong> <Badge>{kindLabel(entry.kind)}</Badge>
                    <br />
                    <small>Deleted {when(entry.deleted_at)}</small>
                    <br />
                    <Button
                      variant="secondary"
                      disabled={busy === key(entry)}
                      onClick={() => void act(entry, 'restore')}
                    >
                      Restore {entry.name}
                    </Button>{' '}
                    {confirming === key(entry) ? (
                      <>
                        {/* The warning names the entity, so the sentence and the
                            row it acts on cannot drift apart. */}
                        <span role="alert">
                          Delete {entry.name} permanently? This cannot be undone, and it takes any
                          images attached to it with it.
                        </span>{' '}
                        <Button
                          variant="danger"
                          disabled={busy === key(entry)}
                          onClick={() => void act(entry, 'purge')}
                        >
                          Yes, delete {entry.name} permanently
                        </Button>{' '}
                        <Button variant="secondary" onClick={() => setConfirming(null)}>
                          Keep {entry.name}
                        </Button>
                      </>
                    ) : (
                      <Button variant="danger" onClick={() => setConfirming(key(entry))}>
                        Delete {entry.name} permanently
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          ))
        : null}
    </div>
  )
}
