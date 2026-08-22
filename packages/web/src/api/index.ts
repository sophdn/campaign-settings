import { createApiClient } from './client'

export * from './client'
export * from './errors'
export * from './types'

/** The app-wide client. Base '' → same-origin /api (vite proxies it in dev). */
export const api = createApiClient()
