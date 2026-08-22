import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi } from '../app/api-context'
import { useAuth } from '../app/auth-context'
import { errorMessage } from '../app/error-message'
import { Loading } from '../components/status'

/**
 * The portfolio's front door. Signs the visitor in as the shared, read-only
 * demo player and drops them straight into the app — no credentials, no form,
 * nothing to read first.
 *
 * There is deliberately no button. A visitor who followed a link labelled "try
 * the demo" has already said yes; making them say it again on arrival is a
 * second door in front of the door.
 */
export function DemoPage(): React.JSX.Element {
  const api = useApi()
  const { applyAccount } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.demoLogin().then(
      (account) => {
        applyAccount(account)
        navigate('/', { replace: true })
      },
      (err: unknown) => setError(errorMessage(err, 'The demo is not available right now')),
    )
  }, [api, applyAccount, navigate])

  if (!error) return <Loading />

  return (
    <div className="login-screen">
      <div className="login-form">
        <h1>The demo is not available</h1>
        <p role="alert">{error}</p>
        <Link to="/login">Go to log in</Link>
      </div>
    </div>
  )
}
