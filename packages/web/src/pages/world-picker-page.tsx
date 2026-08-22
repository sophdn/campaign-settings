import { type ChangeEvent, type FormEvent, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { WorldExport } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { CardLink } from '../components/card-link'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { EmptyState, ErrorText } from '../components/status'

export function WorldPickerPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const fetcher = useCallback(() => api.listWorlds(), [api])
  const worldsRes = useResource(fetcher)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    try {
      const world = await api.createWorld(name)
      navigate(`/worlds/${world.slug}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function onImport(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    setError(null)
    const file = e.target.files?.[0]
    if (!file) return
    let data: WorldExport
    try {
      data = JSON.parse(await file.text()) as WorldExport
    } catch {
      setError('That file is not valid JSON.')
      return
    }
    try {
      const result = await api.importWorld(file.name.replace(/\.json$/i, ''), data)
      navigate(`/worlds/${result.slug}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section>
      <PageHeader title="Your worlds" />
      <ResourceView
        resource={worldsRes}
        empty={(worlds) => worlds.length === 0}
        emptyLabel={<EmptyState>No worlds yet.</EmptyState>}
      >
        {(worlds) => (
          <ul className="card-grid">
            {worlds.map((w) => (
              <CardLink
                key={w.id}
                to={`/worlds/${w.slug}`}
                title={w.name}
                meta={<Badge>{w.role}</Badge>}
              />
            ))}
          </ul>
        )}
      </ResourceView>

      <form onSubmit={(e) => void onCreate(e)} aria-label="Create a world">
        <h2>New world</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="World name"
          aria-label="World name"
        />
        <Button type="submit">Create</Button>
      </form>

      <div>
        <h2>Import a world</h2>
        <label>
          Upload a world export (.json)
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void onImport(e)}
            aria-label="World export file"
          />
        </label>
      </div>

      <ErrorText>{error}</ErrorText>
    </section>
  )
}
