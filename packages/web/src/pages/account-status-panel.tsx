import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus, ApiClient } from '../api'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { Panel } from '../components/panel'
import { ErrorText, Loading } from '../components/status'

const MB = 1024 * 1024

/**
 * Verification state and the resource ceilings in force.
 *
 * The limits are shown here whether or not the user is near them, because the
 * point is that a ceiling is knowable BEFORE a create is refused — being told
 * "you already own the maximum of 5 worlds" the first time you hear a maximum
 * exists is a bad way to learn it.
 *
 * The verification prompt appears only when something is genuinely outstanding.
 * An account with no address on it is not nagged to prove one it never gave.
 */
export function AccountStatusPanel({ api }: { api: ApiClient }): React.JSX.Element {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await api.accountStatus())
    } catch (err) {
      setError(errorMessage(err, 'Could not load your account status'))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  async function onResend(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await api.resendVerification()
      setResent(true)
    } catch (err) {
      setError(errorMessage(err, 'Could not send a new verification email'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel ariaLabel="Account status">
      <h2>Verification and limits</h2>
      <ErrorText>{error}</ErrorText>
      {status === null ? (
        <Loading />
      ) : (
        <>
          {status.emailVerified ? (
            <p>Your email address is verified.</p>
          ) : (
            <>
              <p role="status">
                Your email address is not verified yet. You can sign in and look around, but you
                cannot create a world or invite anyone until it is.
              </p>
              {resent ? (
                <p role="status">
                  If that address is reachable, a new link is on its way. It is good for 24 hours.
                </p>
              ) : (
                <Button disabled={busy} onClick={() => void onResend()}>
                  Send me a new verification email
                </Button>
              )}
            </>
          )}
          <ul>
            <li>
              Worlds you own: {status.usage.worlds} of {status.limits.worldsPerAccount}
            </li>
            <li>Pages per world: up to {status.limits.entitiesPerWorld}</li>
            <li>Images per world: up to {Math.round(status.limits.mediaBytesPerWorld / MB)} MB</li>
          </ul>
        </>
      )}
    </Panel>
  )
}
