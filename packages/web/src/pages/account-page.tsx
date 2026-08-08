import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { SessionSummary } from '../api'
import { useApi } from '../app/api-context'
import { useAuth } from '../app/auth-context'
import { errorMessage } from '../app/error-message'
import { Button } from '../components/button'
import { TextField } from '../components/field'
import { PageHeader } from '../components/page-header'
import { Panel } from '../components/panel'
import { EmptyState, ErrorText, Loading } from '../components/status'
import { AccountStatusPanel } from './account-status-panel'
import { DeleteAccountPanel } from './delete-account-panel'

/** Absolute local time — the session list is about recognition, not precision. */
const when = (iso: string): string => new Date(iso).toLocaleString()

/**
 * Manage your own account: rename yourself, change your password, and see and
 * end the sessions you have open elsewhere.
 *
 * Changing the password ends every other session, so the list is re-fetched
 * afterwards rather than left showing devices that are already gone.
 */
export function AccountPage(): React.JSX.Element {
  const api = useApi()
  const { account, applyAccount } = useAuth()

  const [username, setUsername] = useState(account?.username ?? '')
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [usernameDone, setUsernameDone] = useState(false)
  const [usernameBusy, setUsernameBusy] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordDone, setPasswordDone] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions())
    } catch (err) {
      setSessionsError(errorMessage(err, 'Could not load your sessions'))
    }
  }, [api])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  async function onRename(e: FormEvent): Promise<void> {
    e.preventDefault()
    setUsernameError(null)
    setUsernameDone(false)
    setUsernameBusy(true)
    try {
      applyAccount(await api.changeUsername(username))
      setUsernameDone(true)
    } catch (err) {
      setUsernameError(errorMessage(err, 'Could not change your username'))
    } finally {
      setUsernameBusy(false)
    }
  }

  async function onChangePassword(e: FormEvent): Promise<void> {
    e.preventDefault()
    setPasswordError(null)
    setPasswordDone(false)
    setPasswordBusy(true)
    try {
      await api.changePassword(currentPassword, newPassword)
      setPasswordDone(true)
      setCurrentPassword('')
      setNewPassword('')
      // Other devices were just signed out — show the list as it now is.
      await loadSessions()
    } catch (err) {
      setPasswordError(errorMessage(err, 'Could not change your password'))
    } finally {
      setPasswordBusy(false)
    }
  }

  async function onRevokeAll(): Promise<void> {
    setSessionsError(null)
    try {
      await api.revokeOtherSessions()
      await loadSessions()
    } catch (err) {
      setSessionsError(errorMessage(err, 'Could not end your other sessions'))
    }
  }

  return (
    <div>
      <PageHeader title="Account" />

      <AccountStatusPanel api={api} />

      <Panel>
        <form onSubmit={(e) => void onRename(e)} aria-label="Change your username">
          <h2>Username</h2>
          <TextField
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
          />
          <ErrorText>{usernameError}</ErrorText>
          {usernameDone ? <p role="status">Username updated.</p> : null}
          <Button type="submit" disabled={usernameBusy}>
            Save username
          </Button>
        </form>
      </Panel>

      <Panel>
        <form onSubmit={(e) => void onChangePassword(e)} aria-label="Change your password">
          <h2>Password</h2>
          <TextField
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
          />
          <TextField
            label="New password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <p className="empty-state">
            Changing your password signs you out everywhere else. You will stay signed in here.
          </p>
          <ErrorText>{passwordError}</ErrorText>
          {passwordDone ? <p role="status">Password updated.</p> : null}
          <Button type="submit" disabled={passwordBusy}>
            Change password
          </Button>
        </form>
      </Panel>

      <Panel ariaLabel="Active sessions">
        <h2>Where you are signed in</h2>
        <ErrorText>{sessionsError}</ErrorText>
        {sessions === null ? (
          <Loading />
        ) : sessions.length === 0 ? (
          <EmptyState>No active sessions.</EmptyState>
        ) : (
          <ul>
            {sessions.map((s) => (
              <li key={`${s.createdAt}-${s.deviceLabel ?? 'unknown'}`}>
                {s.deviceLabel ?? 'Unknown device'}
                {s.current ? ' — this device' : ''}
                <br />
                <small>
                  Signed in {when(s.createdAt)} · last used {when(s.lastSeenAt)}
                </small>
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" onClick={() => void onRevokeAll()}>
          Sign out everywhere else
        </Button>
      </Panel>

      <DeleteAccountPanel api={api} />
    </div>
  )
}
