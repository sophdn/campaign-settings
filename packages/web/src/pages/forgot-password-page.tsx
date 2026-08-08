import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useSurfaceGate } from '../app/surface-gate'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { ErrorText } from '../components/status'

/**
 * Request a password-reset link. The success message is intentionally the same
 * whether or not an account matched — the server does not reveal existence, and
 * neither does this page.
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const api = useApi()
  const [identifier, setIdentifier] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const { gate } = useSurfaceGate()

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await gate('passwordResetEnabled', async () => {
        await api.requestPasswordReset(identifier)
        setSent(true)
      })
    } catch (err) {
      setError(errorMessage(err, 'Could not send a reset link'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      {sent ? (
        <div className="login-form">
          <h1>Check your email</h1>
          <p role="status">
            If an account matches that username or email, a password-reset link is on its way.
          </p>
          <Link to="/login">Back to log in</Link>
        </div>
      ) : (
        <form
          onSubmit={(e) => void onSubmit(e)}
          aria-label="Reset your password"
          className="login-form"
        >
          <h1>Reset your password</h1>
          <TextField
            label="Username or email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy}>
            Send reset link
          </Button>
          <Link to="/login">Back to log in</Link>
        </form>
      )}
    </div>
  )
}
