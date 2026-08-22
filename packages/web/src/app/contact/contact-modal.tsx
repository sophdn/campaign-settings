import { useCallback } from 'react'
import { useConfig } from '../config-context'
import { useModal } from '../modal/modal-context'

const TITLE_ID = 'contact-modal-title'

/** The contact modal's content: a short message and a single mailto link. */
function ContactContent({ email }: { email: string }): React.JSX.Element {
  return (
    <>
      <h2 id={TITLE_ID}>Interested?</h2>
      <p>
        This is a read-only demo. To create your own world or use game-master features, email{' '}
        <a href={`mailto:${email}`}>{email}</a> and I will set you up.
      </p>
    </>
  )
}

/**
 * The single contact affordance: opens the shared modal with a mailto to the
 * deploy-configured address. Every blocked action — signup, login,
 * forgot-password, player-to-GM suggestion, and demo GM/write attempts — routes
 * here, so the contact copy and address live in exactly one place. It has no
 * backend: the modal shows a plain mailto and posts nowhere.
 */
export function useContactModal(): { openContact: () => void } {
  const { open } = useModal()
  const { contactEmail } = useConfig()
  const openContact = useCallback(
    () => open(<ContactContent email={contactEmail} />, { labelledBy: TITLE_ID }),
    [open, contactEmail],
  )
  return { openContact }
}
