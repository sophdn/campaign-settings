import { BrowserRouter } from 'react-router-dom'
import { api } from './api'
import { ApiProvider } from './app/api-context'
import { AppRoutes } from './app/app-routes'
import { AuthProvider } from './app/auth-context'
import { ConfigProvider } from './app/config-context'
import { ModalProvider } from './app/modal/modal-context'

/** Composition root: wire the api-client + runtime config + modal service + auth. */
export function App(): React.JSX.Element {
  return (
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <AuthProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </AuthProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>
  )
}
