import { Outlet } from 'react-router-dom'
import { LandingPage } from '../pages/landing-page'
import { Loading } from '../components/status'
import { useAuth } from './auth-context'

/**
 * What `/` is, which depends on who is asking: the public landing page for a
 * visitor with no session, the world picker for someone signed in.
 *
 * Deliberately NOT {@link RequireAuth} with a different redirect. RequireAuth
 * answers "you may not be here"; this answers "here is a different page". The
 * distinction matters for the one route that has to serve both audiences —
 * bouncing a first-time visitor to a login form is how a public site reads as
 * closed.
 *
 * The session probe is still awaited before deciding. Rendering the landing page
 * during the probe would flash marketing copy at someone who is signed in, on
 * every cold load of the site's most-visited URL.
 */
export function HomeRoute(): React.JSX.Element {
  const { account, loading } = useAuth()
  if (loading) return <Loading />
  if (!account) return <LandingPage />
  return <Outlet />
}
