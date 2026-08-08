import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../app/auth-context'
import { useConfig } from '../app/config-context'
import { errorMessage } from '../app/error-message'
import { useSurfaceGate } from '../app/surface-gate'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { ErrorText } from '../components/status'

export function LoginPage(): React.JSX.Element {
  const { login } = useAuth()
  const { flags } = useConfig()
  const { gate } = useSurfaceGate()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // Gated: when sign-in is switched off for this deployment the contact
      // modal opens instead. The endpoint refuses regardless.
      await gate('loginEnabled', async () => {
        await login(username, password)
        navigate('/', { replace: true })
      })
    } catch (err) {
      setError(errorMessage(err, 'Login failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form onSubmit={(e) => void onSubmit(e)} aria-label="Log in" className="login-form">
        <h1>Log in</h1>
        <TextField
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>
          Log in
        </Button>
        {flags.passwordResetEnabled ? (
          <Link to="/forgot-password">Forgot your password?</Link>
        ) : null}
        {/* Only offered when signup is actually open — the flag fails closed,
            so an unreachable /api/config hides it rather than dangling a link
            that would be refused. Task 3630 decides what shows in its place. */}
        {flags.publicSignupEnabled ? <Link to="/register">Create an account</Link> : null}
        {/* Always reachable, whatever is gated: someone deciding whether to
            use the site has to be able to read these first. The landing page
            links them too once task 3550 builds it. */}
        <p className="empty-state">
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>
        </p>
      </form>
    </div>
  )
}
