import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { PublicAccount } from '../api'
import { useApi } from './api-context'

export interface AuthState {
  account: PublicAccount | null
  /** True until the initial session probe resolves. */
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  /** Create an account and adopt the session it issues. */
  register: (input: {
    username: string
    password: string
    email: string
    inviteToken?: string
  }) => Promise<void>
  logout: () => Promise<void>
  /**
   * Adopt an account the caller just changed (a rename). The session is
   * unaffected — only the identity the chrome displays — so this is a local
   * update, not a re-probe.
   */
  applyAccount: (account: PublicAccount) => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const api = useApi()
  const [account, setAccount] = useState<PublicAccount | null>(null)
  const [loading, setLoading] = useState(true)

  /**
   * Whether something has since answered the question the boot probe asked.
   *
   * The probe is a guess about a session the visitor may not have; a sign-in is
   * a fact. On `/demo` the two overlap by design — the page signs in the moment
   * it mounts, while the probe (sent before there was any cookie to present) is
   * still in flight. If the probe's "nobody" lands second and is believed, it
   * evicts a visitor who is signed in, and RequireAuth sends them to the login
   * page the demo exists to spare them.
   */
  const signedInSince = useRef(false)

  /** Adopt an authoritative outcome, and retire the probe's claim on the answer. */
  const adopt = useCallback((next: PublicAccount | null) => {
    signedInSince.current = true
    setAccount(next)
    // The app is no longer waiting to find out who this is, so RequireAuth can
    // stop holding a spinner over the answer. Leaving `loading` set would make
    // every sign-in wait on a request whose reply is already irrelevant — which
    // on a cold server is long enough to look broken.
    setLoading(false)
  }, [])

  useEffect(() => {
    // React 19 discards state updates after unmount, so no manual race guard.
    void api.me().then(
      (a) => {
        if (!signedInSince.current) setAccount(a)
        setLoading(false)
      },
      () => {
        if (!signedInSince.current) setAccount(null)
        setLoading(false)
      },
    )
  }, [api])

  const login = useCallback(
    async (username: string, password: string) => {
      adopt(await api.login(username, password))
    },
    [api, adopt],
  )

  const register = useCallback(
    async (input: { username: string; password: string; email: string; inviteToken?: string }) => {
      adopt(await api.register(input))
    },
    [api, adopt],
  )

  const logout = useCallback(async () => {
    await api.logout()
    adopt(null)
  }, [api, adopt])

  const applyAccount = useCallback((next: PublicAccount) => adopt(next), [adopt])

  return (
    <AuthContext.Provider value={{ account, loading, login, register, logout, applyAccount }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
