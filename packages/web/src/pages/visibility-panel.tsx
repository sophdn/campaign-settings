import { type Visibility, VISIBILITIES } from '@campaign-settings/shared'
import { useEffect, useState } from 'react'
import type { MemberView } from '../api'
import { errorMessage } from '../app/error-message'
import { Badge } from '../components/badge'
import { Button } from '../components/button'
import { SelectField } from '../components/field'
import { EmptyState, ErrorText, Loading } from '../components/status'

/**
 * Plain-language labels — `dm_only` is not a phrase to put in front of a user.
 *
 * Exported so a surface that sets visibility on something WITHOUT a grant list
 * still reads from this one map. Currency attachments are the case: they carry a
 * `visibility` column but cannot be `restricted` (no ACL is foreign-keyable to
 * one), so they need the labels and not the control. Copying two of these three
 * strings into that panel is how "Only you (GM)" ends up phrased two ways.
 */
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: 'Everyone in the world',
  dm_only: 'Only you (GM)',
  restricted: 'Only the players you choose',
}

/**
 * Everything the control needs to know about the thing whose visibility it is
 * setting. Two implementations exist — an entity and a passage — and they differ
 * only in which endpoints they call and what noun they use.
 *
 * This is an adapter rather than a `kind` discriminator on purpose: the labels
 * above and the grant semantics below are the parts that must never diverge
 * between the two, and a fork would let them.
 */
export interface VisibilitySubject {
  /** The thing being controlled, for copy: "page", "passage". */
  noun: string
  setVisibility(next: Visibility): Promise<void>
  listGrants(): Promise<string[]>
  grant(accountId: string): Promise<void>
  revoke(accountId: string): Promise<void>
}

/**
 * Who can see this, and — when it is restricted — exactly which players.
 *
 * Rendered for the OWNER only. That is a courtesy: every call behind it is
 * owner-gated in `authz/content.ts` (`assertContentWrite`), and the HTTP tests
 * assert a player's attempt draws a 403 rather than trusting this component not
 * to render the button.
 *
 * GRANT SEMANTICS when the visibility level changes: grants are RETAINED, never
 * cleared. The authorization seam consults the grant list for `restricted` rows
 * and nothing else, so grants on a `public` or `dm_only` subject are inert — and
 * keeping them means an owner who hides something temporarily and puts it back
 * gets the same audience back rather than silently losing it. The control says
 * so on screen, because inert-but-remembered is the kind of state that is
 * alarming only when it is invisible.
 */
export function VisibilityControl({
  subject,
  members,
  initialVisibility,
  labelPrefix,
  hideLabel = false,
}: {
  subject: VisibilitySubject
  /** World members minus the owner, loaded once by the caller. */
  members: MemberView[] | null
  initialVisibility: Visibility
  /** Distinguishes the select when several are on one page. */
  labelPrefix?: string
  /**
   * Drop the select's VISIBLE label — for a caller whose own panel heading
   * already says what the control is. The accessible name is kept either way.
   * A passage's control has no heading of its own, so it leaves this alone.
   */
  hideLabel?: boolean
}): React.JSX.Element {
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility)
  const [granted, setGranted] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Load the grant list once, on mount.
   *
   * Deliberately mount-only. The caller builds `subject` inline, so it is a new
   * object every render and depending on it here would re-fetch forever. What
   * identifies a subject is which row it points at, and the callers remount
   * with a `key` when that changes — so mounting IS the right trigger.
   *
   * `cancelled` guards the setState: a remount mid-flight would otherwise land
   * the previous subject's grants in the new one's state.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const grants = await subject.listGrants()
        if (!cancelled) setGranted(grants)
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err, `Could not load who can see this ${subject.noun}`))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // MOUNT-ONLY, and the empty dependency list is the point rather than an
    // oversight. Callers build `subject` inline, so every field of it is a new
    // identity each render — listing any of them here would re-fetch forever.
    // What identifies a subject is the row it points at, and both callers
    // remount with a `key` when that changes, so mounting IS the right trigger.
  }, [])

  async function onChangeVisibility(next: Visibility): Promise<void> {
    if (next === visibility) return
    setError(null)
    setBusy(true)
    try {
      await subject.setVisibility(next)
      setVisibility(next)
    } catch (err) {
      setError(errorMessage(err, `Could not change who can see this ${subject.noun}`))
    } finally {
      setBusy(false)
    }
  }

  async function onToggleGrant(member: MemberView, hasGrant: boolean): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      if (hasGrant) await subject.revoke(member.accountId)
      else await subject.grant(member.accountId)
      // Re-read rather than patching local state: the grant list is the
      // server's answer to "who sees this", and it is the only one that counts.
      setGranted(await subject.listGrants())
    } catch (err) {
      setError(errorMessage(err, 'Could not change that player’s access'))
    } finally {
      setBusy(false)
    }
  }

  const selectLabel = labelPrefix ? `${labelPrefix} visibility` : 'Visibility'
  return (
    <>
      {/* Bounded for the same reason the entity editor is: a select stretched
          across a desktop content column puts its value a long way from the
          heading that names it, and reads as a page-wide banner rather than a
          control. */}
      <div className="bounded-form">
        <SelectField
          label="Visibility"
          ariaLabel={selectLabel}
          hideLabel={hideLabel}
          value={visibility}
          onChange={(v) => void onChangeVisibility(v)}
          options={VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }))}
        />
      </div>
      <ErrorText>{error}</ErrorText>

      {visibility === 'restricted' ? (
        members === null || granted === null ? (
          <Loading />
        ) : members.length === 0 ? (
          <EmptyState>No players in this world yet — invite someone from Members.</EmptyState>
        ) : (
          <ul>
            {members.map((m) => {
              const hasGrant = granted.includes(m.accountId)
              return (
                <li key={m.accountId}>
                  <strong>{m.username}</strong>{' '}
                  <Badge>{hasGrant ? 'can see it' : 'cannot see it'}</Badge>{' '}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void onToggleGrant(m, hasGrant)}
                  >
                    {hasGrant ? `Revoke ${m.username}` : `Grant ${m.username}`}
                  </Button>
                </li>
              )
            })}
          </ul>
        )
      ) : (
        <p className="empty-state">
          {granted !== null && granted.length > 0
            ? `${granted.length} player grant(s) are kept but inactive while this ${subject.noun} is not restricted. Switch back to restricted to use them again.`
            : 'Choose "Only the players you choose" to pick individual players.'}
        </p>
      )}
    </>
  )
}
