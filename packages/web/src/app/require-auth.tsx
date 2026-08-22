import { Navigate, Outlet } from 'react-router-dom'
import { Loading } from '../components/status'
import { useAuth } from './auth-context'

/** Gate for authenticated routes: wait for the session probe, then allow or bounce to /login. */
export function RequireAuth(): React.JSX.Element {
  const { account, loading } = useAuth()
  if (loading) return <Loading />
  if (!account) return <Navigate to="/login" replace />
  return <Outlet />
}
