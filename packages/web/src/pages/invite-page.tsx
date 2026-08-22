import { type FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { InvitationPreview } from '../api'
import { useApi } from '../app/api-context'
import { useAuth } from '../app/auth-context'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { ErrorText, Loading } from '../components/status'

/**
 * Where an invitation link lands. Shows which world the token opens, then
 * offers the one action that fits: join, if you are signed in; create an
 * account and join, if you are not.
 *
 * Every dead token — unknown, revoked, expired, already used, meant for
 * somebody else — looks identical here, because the server refuses them all the
 * same way and deliberately tells us nothing to distinguish them by.
 */
export function InvitePage(): React.JSX.Element {
  const api = useApi()
  const { account, loading: authLoading, register } = useAuth()
  const navigate = useNavigate()
  const token = useParams().token ?? ''

  const [preview, setPreview] = useState<InvitationPreview | null>(null)
  const [dead, setDead] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.previewInvitation(token).then(setPreview, () => setDead(true))
  }, [api, token])

  async function run(action: () => Promise<string>): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      navigate(`/worlds/${await action()}`, { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not accept this invitation'))
    } finally {
      setBusy(false)
    }
  }

  const onJoin = (): Promise<void> => run(async () => (await api.acceptInvitation(token)).worldSlug)

  if (dead) {
    return (
      <div className="login-screen">
        <div className="login-form">
          <h1>This invitation is no longer valid</h1>
          <p role="status">
            It may have expired, been withdrawn, or already been used. Ask whoever invited you for a
            new link.
          </p>
          <Link to="/login">Go to log in</Link>
        </div>
      </div>
    )
  }

  if (preview === null || authLoading) return <Loading />

  // Defined below the guard so `preview` is known non-null — the world slug is
  // read straight off it rather than through a fallback that could never fire.
  const world = preview.world
  const onRegister = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      await register({ username, password, email, inviteToken: token })
      // Redeeming the token joins the world server-side, so this is where the
      // new member now belongs.
      return world.slug
    })
  }

  return (
    <div className="login-screen">
      <div className="login-form">
        <h1>You&rsquo;ve been invited to {preview.world.name}</h1>
        {account ? (
          <>
            <p>
              You&rsquo;re signed in as {account.username}. Joining adds this world to your list.
            </p>
            <ErrorText>{error}</ErrorText>
            <Button type="button" disabled={busy} onClick={() => void onJoin()}>
              Join {preview.world.name}
            </Button>
          </>
        ) : (
          <form onSubmit={onRegister} aria-label="Create an account and join">
            <p>Create an account to join. Your invitation is what lets you in.</p>
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
            <Button type="submit" disabled={busy}>
              Create account and join
            </Button>
            <Link to="/login">Already have an account?</Link>
          </form>
        )}
      </div>
    </div>
  )
}
