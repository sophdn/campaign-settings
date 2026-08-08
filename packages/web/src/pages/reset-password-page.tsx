import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { useSurfaceGate } from '../app/surface-gate'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { ErrorText } from '../components/status'

/**
 * Set a new password from a reset link. The token rides in `?token=`; a missing
 * token is a dead link, and a rejected token surfaces the server's error.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const api = useApi()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { gate } = useSurfaceGate()

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await gate('passwordResetEnabled', async () => {
        await api.confirmPasswordReset(token, password)
        navigate('/login', { replace: true })
      })
    } catch (err) {
      setError(errorMessage(err, 'Could not reset your password'))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <div className="login-screen">
        <div className="login-form">
          <h1>Invalid reset link</h1>
          <p role="alert">This password-reset link is missing its token. Request a new one.</p>
          <Link to="/forgot-password">Request a new link</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="login-screen">
      <form
        onSubmit={(e) => void onSubmit(e)}
        aria-label="Choose a new password"
        className="login-form"
      >
        <h1>Choose a new password</h1>
        <TextField
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>
          Set new password
        </Button>
      </form>
    </div>
  )
}
