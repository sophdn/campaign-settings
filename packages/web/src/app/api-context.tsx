import { createContext, useContext } from 'react'
import { type ApiClient, api as defaultApi } from '../api'

/** Makes the api-client injectable (the real one in the app, a fake in tests). */
const ApiContext = createContext<ApiClient>(defaultApi)

export const ApiProvider = ApiContext.Provider

export function useApi(): ApiClient {
  return useContext(ApiContext)
}
