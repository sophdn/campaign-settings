import { type ReactNode, createContext, useContext, useEffect, useState } from 'react'
import type { PublicConfig } from '../api'
import { useApi } from './api-context'

/**
 * Fail-closed defaults used until the initial `/api/config` probe resolves — and
 * if it fails. Flags read as closed and the contact address is empty, so a slow
 * or unreachable endpoint never briefly exposes a gated surface.
 */
const DEFAULT_CONFIG: PublicConfig = {
  flags: {
    publicSignupEnabled: false,
    loginEnabled: false,
    passwordResetEnabled: false,
    suggestionsEnabled: false,
    accountManagementEnabled: false,
    demoModeEnabled: false,
  },
  contactEmail: '',
}

export interface ConfigState extends PublicConfig {
  /** True until the initial config probe resolves. */
  loading: boolean
}

const ConfigContext = createContext<ConfigState | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const api = useApi()
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // React 19 discards state updates after unmount, so no manual race guard.
    void api.getConfig().then(
      (c) => {
        setConfig(c)
        setLoading(false)
      },
      () => {
        // Probe failed — stay fail-closed on the defaults.
        setConfig(DEFAULT_CONFIG)
        setLoading(false)
      },
    )
  }, [api])

  return <ConfigContext.Provider value={{ ...config, loading }}>{children}</ConfigContext.Provider>
}

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within a ConfigProvider')
  return ctx
}
