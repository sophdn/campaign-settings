import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { errorMessage } from '../app/error-message'
import { Loading } from '../components/status'

/**
 * Where a verification link lands. Public on purpose: the link is opened from
 * an email client, very often in a browser with no session, and demanding a
 * login first is how a verification link becomes a dead end.
 *
 * Every dead token — unknown, already used, expired — looks identical, because
 * the server refuses them all the same way and deliberately tells us nothing to
 * tell them apart by.
 */
export function VerifyEmailPage(): React.JSX.Element {
  const api = useApi()
  const token = useSearchParams()[0].get('token') ?? ''
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.verifyEmail(token).then(
      () => setState('done'),
      (err: unknown) => {
        setError(errorMessage(err, 'This verification link is no longer valid'))
        setState('failed')
      },
    )
  }, [api, token])

  if (state === 'working') return <Loading />

  return (
    <div className="login-screen">
      <div className="login-form">
        {state === 'done' ? (
          <>
            <h1>Your email is verified</h1>
            <p role="status">You can now create worlds and invite players.</p>
            <Link to="/">Go to your worlds</Link>
          </>
        ) : (
          <>
            <h1>This link is no longer valid</h1>
            <p role="alert">{error}</p>
            <p>
              It may have expired, or already been used. Sign in and ask for a new one from your
              account page.
            </p>
            <Link to="/login">Go to log in</Link>
          </>
        )}
      </div>
    </div>
  )
}
