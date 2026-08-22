import { useState } from 'react'
import type { ApiClient, WikiEntry } from '../api'
import { errorMessage } from '../app/error-message'
import { useSurfaceGate } from '../app/surface-gate'
import { Button } from '../components/button'
import { FormCard } from '../components/form-card'
import { ErrorText } from '../components/status'
import { TextAreaField } from '../components/text-area-field'

/**
 * A player suggests something to add to this page.
 *
 * Replaces the standalone suggestion form, which lived on its own screen and
 * made you pick an entity from a dropdown before you could say anything about
 * it. Proposing where you are reading is the whole improvement: the DM reviews
 * it in place, and the player does not have to describe which page they mean.
 *
 * What is submitted becomes a `proposed` passage visible to its author and the
 * GM alone, until the GM publishes it at a visibility they choose. The server
 * decides all of that — see the propose route, which is the one write in the
 * app that a player is allowed to make.
 */
export function ProposePassagePanel({
  api,
  worldId,
  kind,
  entityId,
  candidates,
  onProposed,
}: {
  api: ApiClient
  worldId: string
  kind: string
  entityId: string
  /** Entities the `[[name]]` picker may offer. */
  candidates: WikiEntry[]
  onProposed: () => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { gate } = useSurfaceGate()

  async function onSubmit(): Promise<void> {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      // Gated: with suggestions switched off the contact modal opens instead.
      // The endpoint refuses on its own too — this is not the gate.
      await gate('suggestionsEnabled', async () => {
        await api.proposePassage(worldId, kind, entityId, body)
        setBody('')
        setNotice('Sent to the GM. You can see it here until they review it.')
        onProposed()
      })
    } catch (err) {
      setError(errorMessage(err, 'Could not send that suggestion'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormCard title="Suggest an addition" ariaLabel="Suggest an addition" onSubmit={onSubmit}>
      <TextAreaField
        label="Your suggestion"
        ariaLabel="Your suggestion"
        value={body}
        onChange={setBody}
        rows={4}
        candidates={candidates}
        hint="Type [[ to link another entry. Only you and the GM can see this until they accept it."
      />
      <ErrorText>{error}</ErrorText>
      {notice ? <p role="status">{notice}</p> : null}
      <Button type="submit" disabled={busy || body.trim() === ''}>
        Send to GM
      </Button>
    </FormCard>
  )
}
