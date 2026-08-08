import { type FormEvent, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../app/auth-context'
import { useConfig } from '../app/config-context'
import { errorMessage } from '../app/error-message'
import { useSurfaceGate } from '../app/surface-gate'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { ErrorText, Loading } from '../components/status'

/**
 * Self-serve sign-up. The page is only reachable when the server says public
 * registration is open — but the flag is enforced server-side too, so this
 * check is about not offering a door that would slam, not about security.
 */
export function RegisterPage(): React.JSX.Element {
  const { register } = useAuth()
  const { flags, loading } = useConfig()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { gate } = useSurfaceGate()

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await gate('publicSignupEnabled', async () => {
        await register({ username, password, email })
        navigate('/', { replace: true })
      })
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />
  // Config defaults fail-closed, so an unreachable /api/config lands here too —
  // sending someone to log in is the right fallback either way.
  if (!flags.publicSignupEnabled) return <Navigate to="/login" replace />

  return (
    <div className="login-screen">
      <form
        onSubmit={(e) => void onSubmit(e)}
        aria-label="Create an account"
        className="login-form"
      >
        <h1>Create an account</h1>
        <TextField
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <ErrorText>{error}</ErrorText>
        {/* At the point of sign-up, not buried in a footer: this is where
            someone is actually deciding. */}
        <p className="empty-state">
          By creating an account you agree to the <Link to="/terms">terms of use</Link>, and to the{' '}
          <Link to="/privacy">privacy policy</Link> describing what is stored about you.
        </p>
        <Button type="submit" disabled={busy}>
          Create account
        </Button>
        <Link to="/login">Already have an account?</Link>
      </form>
    </div>
  )
}
