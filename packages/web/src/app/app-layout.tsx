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
            {/* The demo principal is refused the whole /api/account family,
                reads included — the account is shared, so its session list and
                status are not this visitor's business. Linking there would
                offer a page that can only fail. */}
            {account.isDemo ? account.username : <Link to="/account">{account.username}</Link>}{' '}
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
