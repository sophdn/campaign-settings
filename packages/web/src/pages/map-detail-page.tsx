import { fuzzySearch } from '@campaign-settings/shared'
import { useCallback, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { MapPin, WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { makeThumbnail } from '../app/thumbnail'
import { useResource } from '../app/use-resource'
import { useWikiIndex } from '../app/use-name-index'
import { useWorld } from '../app/world-context'
import { BackLink } from '../components/back-link'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { Panel } from '../components/panel'
import { MapVisibilityPanel } from './map-visibility-panel'
import { EmptyState, ErrorText, Loading } from '../components/status'
import { MapViewer } from './map-viewer'
import type { Point } from './map-viewport'

/**
 * One map: its image, its pins, and — for an owner — the controls that change
 * both.
 *
 * Every pin that reaches this page has already had its target resolved
 * server-side; a pin naming an entity the reader may not see is dropped whole
 * before it is sent. So there is deliberately no filtering here, and no
 * client-side visibility logic that could disagree with the server's.
 */
export function MapDetailPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const { role } = useWorld()
  const { worldId = '', mapId = '' } = useParams()
  const canEdit = role === 'owner'

  const mapFetcher = useCallback(() => api.getMap(worldId, mapId), [api, worldId, mapId])
  const mapResource = useResource(mapFetcher)
  const pinFetcher = useCallback(() => api.listPins(worldId, mapId), [api, worldId, mapId])
  const pins = useResource(pinFetcher)

  // `placing` holds the coordinate a click produced, which the picker then
  // attaches an entity to. Two steps rather than one because a pin needs both a
  // WHERE and a WHAT, and the map can only supply the first.
  const [placing, setPlacing] = useState<Point | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (mapResource.loading) return <Loading />
  if (mapResource.error !== null || mapResource.data === null) {
    return <ErrorText>{mapResource.error ?? 'Not found'}</ErrorText>
  }
  const { map, image } = mapResource.data

  const onPlace = (at: Point): void => {
    setPlacing(at)
    setAddMode(false)
  }

  async function attachPin(entry: WikiEntry): Promise<void> {
    const at = placing
    setPlacing(null)
    if (!at) return
    setError(null)
    try {
      await api.createPin(worldId, mapId, {
        kind: entry.kind,
        entityId: entry.id,
        x: at.x,
        y: at.y,
      })
      pins.reload()
    } catch (err) {
      setError(errorMessage(err, 'Could not place the pin'))
    }
  }

  async function removePin(pin: MapPin): Promise<void> {
    setError(null)
    try {
      await api.deletePin(worldId, mapId, pin.id)
      pins.reload()
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the pin'))
    }
  }

  async function patchPin(
    pin: MapPin,
    patch: { x?: number; y?: number; label?: string },
  ): Promise<void> {
    setError(null)
    try {
      await api.updatePin(worldId, mapId, pin.id, patch)
      pins.reload()
    } catch (err) {
      setError(errorMessage(err, 'Could not update the pin'))
    }
  }

  async function removeMap(): Promise<void> {
    try {
      await api.deleteMap(worldId, mapId)
      await navigate(`/worlds/${worldId}/maps`)
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the map'))
    }
  }

  const openPin = (pin: MapPin): void => {
    void navigate(`/worlds/${worldId}/${pin.target.kind}/${pin.target.id}`)
  }

  return (
    <>
      <BackLink to={`/worlds/${worldId}/maps`}>Back to maps</BackLink>
      <Panel ariaLabel="Map">
        <h2>{map.name}</h2>
        {map.description ? <p>{map.description}</p> : null}
        {error ? <p role="alert">{error}</p> : null}

        <MapViewer
          map={map}
          imageUrl={image ? api.mediaRawUrl(worldId, image.id) : null}
          pins={pins.data ?? []}
          onPlace={canEdit && addMode ? onPlace : null}
          onOpenPin={openPin}
          onMovePin={canEdit ? (pin, to) => void patchPin(pin, { x: to.x, y: to.y }) : null}
        />

        {canEdit ? (
          <>
            <MapImageUpload
              worldId={worldId}
              mapId={mapId}
              hasImage={image !== null}
              onUploaded={mapResource.reload}
            />
            <div className="form-actions">
              {image ? (
                <Button
                  variant={addMode ? 'danger' : 'secondary'}
                  type="button"
                  onClick={() => setAddMode((on) => !on)}
                >
                  {addMode ? 'Cancel pin' : 'Add pin'}
                </Button>
              ) : null}
              <Button variant="danger" type="button" onClick={() => void removeMap()}>
                Delete map
              </Button>
            </div>
          </>
        ) : null}
        {addMode ? <p role="status">Click the map to place a pin.</p> : null}
      </Panel>

      {canEdit ? (
        <MapVisibilityPanel
          key={map.id}
          api={api}
          worldId={worldId}
          mapId={map.id}
          initialVisibility={map.visibility}
        />
      ) : null}

      {placing ? (
        <PinTargetPicker
          worldId={worldId}
          onPick={(entry) => void attachPin(entry)}
          onCancel={() => setPlacing(null)}
        />
      ) : null}

      <PinList
        pins={pins.data ?? []}
        canEdit={canEdit}
        onOpen={openPin}
        onRemove={removePin}
        onRelabel={(pin, label) => void patchPin(pin, { label })}
      />
    </>
  )
}

function MapImageUpload({
  worldId,
  mapId,
  hasImage,
  onUploaded,
}: {
  worldId: string
  mapId: string
  hasImage: boolean
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
      await api.uploadMapImage(worldId, mapId, file, await makeThumbnail(file))
      onUploaded()
    } catch (err) {
      setStatus(errorMessage(err, 'Upload failed'))
    } finally {
      setBusy(false)
      // Without clearing, re-picking the SAME file fires no change event, so a
      // failed upload cannot be retried.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="map-upload">
      <label>
        {hasImage ? 'Replace the map image' : 'Upload a map image'}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPick(file)
          }}
        />
      </label>
      {busy || status ? <p role="status">{busy ? 'Uploading…' : status}</p> : null}
    </div>
  )
}

/**
 * Choose which entity a new pin marks.
 *
 * The corpus is the wiki index — the same authorized list the `[[name]]` picker
 * offers — so it is already filtered to what this actor may see, and a pin
 * cannot be aimed at something invisible even by accident.
 */
function PinTargetPicker({
  worldId,
  onPick,
  onCancel,
}: {
  worldId: string
  onPick: (entry: WikiEntry) => void
  onCancel: () => void
}): React.JSX.Element {
  const { candidates } = useWikiIndex(worldId)
  const [query, setQuery] = useState('')
  const matches = fuzzySearch(candidates, query, { text: (e) => e.name }).slice(0, 20)

  return (
    <Panel ariaLabel="Pin an entity">
      <h3>Pin which entry?</h3>
      <TextField label="Search" value={query} onChange={setQuery} placeholder="Search entries…" />
      {matches.length === 0 ? (
        <EmptyState>No matching entries.</EmptyState>
      ) : (
        <ul className="pin-options">
          {matches.map((m) => (
            <li key={`${m.item.kind}:${m.item.id}`}>
              <Button variant="secondary" type="button" onClick={() => onPick(m.item)}>
                {m.item.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Panel>
  )
}

/**
 * The pins as a list beside the map.
 *
 * Not a duplicate of the overlay: a marker on a zoomed-in map may be off-screen,
 * and a pin nobody can find is a pin nobody can remove. It is also the only
 * way to reach a pin without a pointer.
 */
function PinList({
  pins,
  canEdit,
  onOpen,
  onRemove,
  onRelabel,
}: {
  pins: MapPin[]
  canEdit: boolean
  onOpen: (pin: MapPin) => void
  onRemove: (pin: MapPin) => void
  onRelabel: (pin: MapPin, label: string) => void
}): React.JSX.Element {
  return (
    <Panel ariaLabel="Pins">
      <h3>Pins</h3>
      {pins.length === 0 ? (
        <EmptyState>Nothing pinned on this map yet.</EmptyState>
      ) : (
        <ul className="pin-list">
          {pins.map((pin) => (
            <PinRow
              key={pin.id}
              pin={pin}
              canEdit={canEdit}
              onOpen={onOpen}
              onRemove={onRemove}
              onRelabel={onRelabel}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function PinRow({
  pin,
  canEdit,
  onOpen,
  onRemove,
  onRelabel,
}: {
  pin: MapPin
  canEdit: boolean
  onOpen: (pin: MapPin) => void
  onRemove: (pin: MapPin) => void
  onRelabel: (pin: MapPin, label: string) => void
}): React.JSX.Element {
  const [label, setLabel] = useState(pin.label ?? '')

  return (
    <li>
      <Button variant="secondary" type="button" onClick={() => onOpen(pin)}>
        {pin.target.name}
      </Button>
      {canEdit ? (
        <>
          {/* A label is what a marker on the map READS as, so it is edited here
              rather than only at placement — renaming is the common case, and
              the map overlay has no room for a text field. */}
          <TextField
            label={`Label for ${pin.target.name}`}
            ariaLabel={`Label for ${pin.target.name}`}
            value={label}
            onChange={setLabel}
            placeholder={pin.target.name}
          />
          <Button
            type="button"
            disabled={label === (pin.label ?? '')}
            onClick={() => onRelabel(pin, label)}
          >
            Save label
          </Button>
          <Button
            variant="secondary"
            type="button"
            aria-label={`Remove pin for ${pin.target.name}`}
            onClick={() => onRemove(pin)}
          >
            Remove
          </Button>
        </>
      ) : pin.label ? (
        <span className="field-hint">{pin.label}</span>
      ) : null}
    </li>
  )
}
