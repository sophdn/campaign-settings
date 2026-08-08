import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useWorld } from '../app/world-context'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { FormCard } from '../components/form-card'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'
import { ErrorText } from '../components/status'

/**
 * `chicago-2026-08-08.json` — the world it came from, and when it was taken.
 *
 * Exported so its own test can pin a fixed date. Reading the clock inside the
 * component would make any assertion about the name either true only today or
 * a restatement of the implementation.
 */
export function exportFilename(slug: string, at: Date): string {
  const [date] = at.toISOString().split('T')
  return `${slug}-${date}.json`
}

/**
 * Take the whole world away as a file.
 *
 * `GET /api/worlds/:worldId/export` and `api.exportWorld` have both existed
 * since the import work, and neither had a single call site in the SPA — an
 * owner could not get their own writing out of this app without reaching for
 * curl. That is a bigger absence than a missing button: export is the ONLY
 * user-facing path to a copy of your own data, and DEPLOY.md's backup story
 * covers the operator's Postgres, not a person's ability to leave with what
 * they wrote. Open public registration makes that an obligation.
 *
 * The bytes are assembled into a Blob and saved through a real download link
 * rather than rendered into the page, because a wall of JSON on screen is not
 * a copy of anything. The link is minted on demand and revoked when it is
 * replaced, so a page left open does not pin a whole world in memory.
 */
function ExportPanel({ worldId }: { worldId: string }): React.JSX.Element {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ url: string; filename: string } | null>(null)

  // A blob URL is a live reference into this document. Dropping the state
  // without revoking would leak the whole export for as long as the tab lives.
  useEffect(() => () => (file ? URL.revokeObjectURL(file.url) : undefined), [file])

  async function onPrepare(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const data = await api.exportWorld(worldId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      setFile({ url: URL.createObjectURL(blob), filename: exportFilename(worldId, new Date()) })
    } catch (err) {
      setError(errorMessage(err, 'Could not export this world'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Export this world">
      <h2>Export</h2>
      <p>
        Everything in this world as a single JSON file — every page, passage, map, session and note,
        including the ones only you can see. It is yours to keep, and it is what an import reads, so
        a world can be moved between accounts or instances. Images are not included; the file names
        them but the bytes stay here.
      </p>
      <ErrorText>{error}</ErrorText>
      {file ? (
        <p>
          <a href={file.url} download={file.filename}>
            Download {file.filename}
          </a>
        </p>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => void onPrepare()}>
          {busy ? 'Preparing…' : 'Prepare an export'}
        </Button>
      )}
    </Panel>
  )
}

/**
 * What the owner can change about the world itself, as opposed to what is in
 * it — plus the way to take the whole thing with them. Delete and the ownership
 * handover still live beside the member list, which is where you go to ask who
 * is in this.
 *
 * The page exists for a player too, and says plainly that there is nothing here
 * for them — a nav entry that leads to a blank screen is worse than one that
 * explains itself. The server refuses their rename and their export regardless
 * of what is rendered.
 */
export function WorldSettingsPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const { worldId, worldName, role, refreshWorld } = useWorld()
  const [name, setName] = useState(worldName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onRename(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const world = await api.renameWorld(worldId, name)
      // A rename that only changed the punctuation leaves the slug alone, so
      // the navigate below is a no-op and nothing would re-read the world.
      refreshWorld()
      // The address in the bar is the old slug and no longer resolves, so this
      // is a move rather than a refresh: replace, so Back does not lead to a
      // world that is not there any more.
      navigate(`/worlds/${world.slug}/settings`, { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not rename this world'))
    } finally {
      setBusy(false)
    }
  }

  if (role !== 'owner') {
    return (
      <div>
        <PageHeader title="Settings" />
        <Panel ariaLabel="World settings">
          <p>Only the GM can change this world&rsquo;s settings.</p>
        </Panel>
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Settings" />
      <FormCard title="World name" onSubmit={onRename}>
        <TextField label="Name" value={name} onChange={setName} disabled={busy} />
        <p>
          The web address changes with the name. Links your players have saved to this world will
          stop working, and you will need to send them the new one. Invitations are unaffected.
        </p>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy || name.trim() === ''}>
          Save name
        </Button>
      </FormCard>
      {/* `worldId` from the world context IS the slug — the URL key every
          world-scoped call is addressed by — so the filename names the world
          the reader just exported rather than an opaque id. */}
      <ExportPanel worldId={worldId} />
    </div>
  )
}
