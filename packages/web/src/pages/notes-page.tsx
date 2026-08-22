import { useCallback, useState } from 'react'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useWikiIndex } from '../app/use-name-index'
import { useResource } from '../app/use-resource'
import { useWorld } from '../app/world-context'
import { Button } from '../components/button'
import { EntityDescription } from '../components/entity-description'
import { FormCard } from '../components/form-card'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { ErrorText } from '../components/status'
import { TextAreaField } from '../components/text-area-field'

/** Player notes — each account manages its own; the DM sees the world's. */
export function NotesPage(): React.JSX.Element {
  const api = useApi()
  const { worldId } = useWorld()
  const fetcher = useCallback(() => api.listNotes(worldId), [api, worldId])
  const notesRes = useResource(fetcher)
  const { reload } = notesRes
  const { nameIndex, candidates } = useWikiIndex(worldId)
  const [body, setBody] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  async function onAdd(): Promise<void> {
    setActionError(null)
    try {
      await api.createNote(worldId, body)
      setBody('')
      reload()
    } catch (err) {
      setActionError(errorMessage(err, 'Failed'))
    }
  }

  async function onDelete(id: string): Promise<void> {
    setActionError(null)
    try {
      await api.deleteNote(worldId, id)
      reload()
    } catch (err) {
      setActionError(errorMessage(err, 'Failed'))
    }
  }

  return (
    <section>
      <PageHeader title="Notes" />
      <FormCard title="New Note" ariaLabel="New note" onSubmit={onAdd}>
        <TextAreaField
          label="Note"
          value={body}
          onChange={setBody}
          candidates={candidates}
          hint="Type [[ to link another entry. Matches on its name; capitalisation does not matter."
        />
        <Button type="submit">Add note</Button>
      </FormCard>
      <ErrorText>{actionError}</ErrorText>
      <ResourceView resource={notesRes}>
        {(notes) => (
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <EntityDescription text={n.body} worldId={worldId} nameIndex={nameIndex} />
                <Button variant="danger" type="button" onClick={() => void onDelete(n.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
    </section>
  )
}
