import { Link, Outlet } from 'react-router-dom'
import { useAuth } from './auth-context'

/** The in-app chrome around authenticated pages. */
export function AppLayout(): React.JSX.Element {
  const { account, logout } = useAuth()
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>CampaignSettings</strong>
        {account ? (
          <span>
            <Link to="/account">{account.username}</Link>{' '}
            <button type="button" onClick={() => void logout()}>
              Log out
            </button>
          </span>
        ) : null}
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
