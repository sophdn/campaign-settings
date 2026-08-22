import { useCallback, useRef, useState } from 'react'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { makeThumbnail } from '../app/thumbnail'
import { useResource } from '../app/use-resource'

/**
 * THE image for an entity, at the top of its page.
 *
 * ## Why this exists beside the gallery rather than instead of it
 *
 * `media_attachments` had no way to say which image was the portrait, so art on
 * a character had no prominence at all: you scrolled past the editor and every
 * other panel to reach a row of thumbnails. This renders the one image the
 * owner nominated, above the name.
 *
 * The gallery stays where it is. An entity with eight attachments still needs
 * it, and folding it into the avatar would trade one problem for a worse one.
 *
 * ## The circle
 *
 * Every kind, deliberately (Sophi, 2026-08-21). A circle suits a portrait and
 * crops a town map badly, and shape-per-kind is a CSS change that can follow
 * later rather than a reason to hold the feature. Said here so the next reader
 * knows the crop is a decision rather than an oversight.
 *
 * ## The plus
 *
 * Owner-only, and that is PRESENTATION. The upload route and the set-primary
 * route both go through `assertContentWrite`; hiding the control from a player
 * is a courtesy, not the enforcement.
 *
 * It uploads-and-sets when the entity has no image and changes it when it does,
 * because those are one intention — "let this be the picture" — and splitting
 * them into two controls would ask the reader which one they meant.
 */

/** Accepted by the picker; the server re-checks the bytes regardless. */
const ACCEPT = 'image/jpeg,image/png,image/webp'

export function EntityAvatar({
  worldId,
  kind,
  id,
  canEdit,
  onPrimaryChanged,
}: {
  worldId: string
  kind: string
  id: string
  canEdit: boolean
  /**
   * Told when the plus nominates a new image, so the gallery further down the
   * page re-reads. Without it the gallery keeps saying nothing is the main
   * image until a reload, which is the mirror of the staleness the gallery's
   * own callback fixes for the avatar.
   */
  onPrimaryChanged?: (() => void) | undefined
}): React.JSX.Element {
  const api = useApi()
  const fetcher = useCallback(
    () => api.getPrimaryMedia(worldId, kind, id),
    [api, worldId, kind, id],
  )
  const { data: primary, reload } = useResource(fetcher)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onPick(file: File): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      // Upload, then nominate. Two calls because they are two endpoints, and
      // the intermediate state is harmless: a failure between them leaves the
      // image attached to the gallery and nothing leading the page, which the
      // owner can fix from the gallery's own control.
      const media = await api.uploadEntityMedia(worldId, kind, id, file, await makeThumbnail(file))
      await api.setPrimaryMedia(worldId, kind, id, media.id)
      reload()
      onPrimaryChanged?.()
    } catch (err) {
      setError(errorMessage(err, 'Could not set the image'))
    } finally {
      setBusy(false)
      // Clear the input so picking the SAME file again still fires a change
      // event — otherwise a failed upload cannot be retried without picking
      // something else first.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const label = primary ? 'Change the main image' : 'Add a main image'
  return (
    <div className="entity-avatar">
      {primary ? (
        // The THUMBNAIL, not the source: this is a 6rem circle, and the gallery
        // already made the same choice for the same reason. A row with no
        // thumbnail falls back to the source at the raw route, so nothing here
        // has to branch on it.
        <img
          className="entity-avatar-image"
          src={api.mediaThumbnailUrl(worldId, primary.id)}
          alt={primary.original_filename}
        />
      ) : (
        // A neutral disc, not a broken frame. An entity with no image is the
        // ordinary case, not a fault, and it should not look like one.
        <span className="entity-avatar-image entity-avatar-empty" aria-hidden="true" />
      )}
      {canEdit ? (
        <label className="entity-avatar-add">
          {/* The `+` is the whole visible affordance. The accessible name lives
              on the input itself, so a screen reader hears "Add a main image,
              file upload" rather than the glyph. */}
          <span aria-hidden="true">+</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            aria-label={label}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onPick(file)
            }}
          />
        </label>
      ) : null}
      {busy ? <p role="status">Uploading…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
