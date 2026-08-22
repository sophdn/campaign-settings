import { useCallback } from 'react'
import { ApiClientError, type FeatureFlags } from '../api'
import { useConfig } from './config-context'
import { useContactModal } from './contact/contact-modal'

/**
 * The client half of the access gates (task 3630).
 *
 * A gated surface has TWO ways of being closed and this handles both:
 *
 *  1. The flag says so up front — `/api/config` reported it off, so the action
 *     never runs and the contact modal opens instead.
 *  2. The server says so on the way out — the request went anyway and came back
 *     `surface_disabled`. Same outcome, because the user's situation is
 *     identical and a raw error would be a worse way to learn it.
 *
 * WHILE THE CONFIG PROBE IS STILL IN FLIGHT, the action is ALLOWED to run. The
 * SPA's copy of the flags starts fail-closed, so pre-empting on it would open
 * the contact modal for anyone who clicked before the probe resolved — a
 * working surface refused because a fetch had not landed yet. Case 2 covers it
 * instead: the request goes, and the server (which is the only thing that
 * actually decides) says no. Being fail-closed is the right default for
 * RENDERING a form; it is the wrong default for judging a click.
 *
 * None of this is the gate. The endpoints refuse on their own — a script never
 * reaches this code.
 *
 * This is the DEPLOYMENT half of the presentation rule stated on
 * `isOwnerRole` (world-context.tsx). The ROLE half hides what the viewer can
 * never use; this half keeps what they could use visible and turns a
 * switched-off surface or a demo-capped write into the contact conversation.
 * The portfolio demo is an instance of both halves, not a special case.
 */
export function useSurfaceGate(): {
  gate: (flag: keyof FeatureFlags, run: () => Promise<void>) => Promise<void>
} {
  const { openContact } = useContactModal()
  const { flags, loading } = useConfig()

  const gate = useCallback(
    async (flag: keyof FeatureFlags, run: () => Promise<void>): Promise<void> => {
      if (!loading && !flags[flag]) {
        openContact()
        return
      }
      try {
        await run()
      } catch (err) {
        // `demo_read_only` lands here too: the contact modal's copy already
        // says exactly what a demo visitor needs to hear, so a blocked write
        // and a switched-off surface are the same conversation.
        if (
          err instanceof ApiClientError &&
          (err.code === 'surface_disabled' || err.code === 'demo_read_only')
        ) {
          openContact()
          return
        }
        throw err
      }
    },
    [openContact, flags, loading],
  )

  return { gate }
}
