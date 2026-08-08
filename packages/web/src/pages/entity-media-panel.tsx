import { useCallback, useRef, useState } from 'react'
import type { ApiClient, MediaAttachment } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useModal } from '../app/modal/modal-context'
import { makeThumbnail } from '../app/thumbnail'
import { useResource } from '../app/use-resource'
import { Button } from '../components/button'
import { Panel } from '../components/panel'
import { EmptyState } from '../components/status'

/**
 * The Images panel on an entity page: what is attached, and — for an owner —
 * the control that attaches more.
 *
 * The gallery renders THUMBNAILS and links to the source, so a page with a
 * dozen attachments does not pull a dozen full-size images. A row with no
 * thumbnail is normal (the legacy importer makes such rows, and so does an
 * upload whose follow-up request never landed); the raw route falls back to the
 * source in that case, so nothing here needs to branch on it.
 *
 * Every refusal shown here is the server's. The upload button is hidden from a
 * player because offering a control that always fails is unkind, not because
 * hiding it is the enforcement — that lives in `assertContentWrite`.
 */

/** Accepted by the picker; the server re-checks the bytes regardless. */
const ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * The full-size view, opened from a thumbnail.
 *
 * Rendered through the app's ONE modal service rather than a second overlay of
 * its own: the focus trap, the scrim, Escape, and the scroll lock are dialog
 * mechanics, not image-viewer mechanics, and a gallery lightbox that
 * reimplemented them would be a second place for them to be subtly wrong.
 *
 * The source is fetched here, not the thumbnail — looking closely is the whole
 * point — and the link out survives so a browser's own zoom, save, and
 * open-in-new-tab are still reachable for anyone who wants them.
 */
function ImageLightbox({
  api,
  worldId,
  media,
}: {
  api: ApiClient
  worldId: string
  media: MediaAttachment
}): React.JSX.Element {
  return (
    <>
      <img
        className="media-lightbox-image"
        src={api.mediaRawUrl(worldId, media.id)}
        alt={media.original_filename}
      />
      <p>
        <a href={api.mediaRawUrl(worldId, media.id)} target="_blank" rel="noreferrer">
          Open {media.original_filename} in a new tab
        </a>
      </p>
    </>
  )
}

export function EntityMediaPanel({
  worldId,
  kind,
  id,
  canEdit,
}: {
  worldId: string
  kind: string
  id: string
  canEdit: boolean
}): React.JSX.Element {
  const api = useApi()
  const fetcher = useCallback(
    () => api.listEntityMedia(worldId, kind, id),
    [api, worldId, kind, id],
  )
  const { data, reload } = useResource(fetcher)
  const images = (data ?? []).filter((m) => m.media_kind === 'image')

  return (
    <Panel ariaLabel="Images">
      <h3>Images</h3>
      {canEdit ? <UploadControl worldId={worldId} kind={kind} id={id} onUploaded={reload} /> : null}
      {images.length === 0 ? (
        <EmptyState>
          {canEdit ? 'No images yet. Add one above.' : 'No images on this entry.'}
        </EmptyState>
      ) : (
        <ul className="entity-media">
          {images.map((m) => (
            <MediaTile
              key={m.id}
              api={api}
              worldId={worldId}
              media={m}
              canEdit={canEdit}
              onRemoved={reload}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function MediaTile({
  api,
  worldId,
  media,
  canEdit,
  onRemoved,
}: {
  api: ApiClient
  worldId: string
  media: MediaAttachment
  canEdit: boolean
  onRemoved: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const { open } = useModal()

  async function onRemove(): Promise<void> {
    setError(null)
    try {
      await api.deleteMedia(worldId, media.id)
      onRemoved()
    } catch (err) {
      setError(errorMessage(err, 'Remove failed'))
    }
  }

  return (
    <li className="entity-media-item">
      {/* A button, not a link: this opens a dialog on this page rather than
          navigating, and a link that does not go anywhere is a link that lies
          to anyone reading the status bar or using a screen reader. */}
      <button
        type="button"
        className="media-thumb-button"
        onClick={() =>
          open(<ImageLightbox api={api} worldId={worldId} media={media} />, {
            ariaLabel: media.original_filename,
            className: 'modal-image',
          })
        }
      >
        <img
          src={api.mediaThumbnailUrl(worldId, media.id)}
          alt={`View ${media.original_filename} full size`}
          loading="lazy"
        />
      </button>
      {canEdit ? (
        <Button
          variant="secondary"
          type="button"
          onClick={() => void onRemove()}
          aria-label={`Remove ${media.original_filename}`}
        >
          Remove
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  )
}

function UploadControl({
  worldId,
  kind,
  id,
  onUploaded,
}: {
  worldId: string
  kind: string
  id: string
  onUploaded: () => void
}): React.JSX.Element {
  const api = useApi()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function onPick(file: File): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      // Generated here because the server has no image pipeline. A null result
      // is fine — the attachment then has no separate preview and the raw route
      // serves the source instead.
      const thumbnail = await makeThumbnail(file)
      await api.uploadEntityMedia(worldId, kind, id, file, thumbnail)
      setStatus(`Added ${file.name}`)
      onUploaded()
    } catch (err) {
      setStatus(errorMessage(err, 'Upload failed'))
    } finally {
      setBusy(false)
      // Clear the input so picking the SAME file again still fires a change
      // event — otherwise a failed upload cannot be retried without picking
      // something else first.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="entity-media-upload">
      <label>
        Add an image
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPick(file)
          }}
        />
      </label>
      <span className="field-hint">JPEG, PNG or WebP.</span>
      {busy || status ? <p role="status">{busy ? 'Uploading…' : status}</p> : null}
    </div>
  )
}
