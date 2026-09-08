import { createContext, useContext } from 'react'
import type { ApiAdapter } from '@contract'
import { LocalAdapter } from './localAdapter'

/**
 * The single seam between the UI and the backend.
 *
 * Nothing outside this file may import a concrete adapter. Phase 6 replaces the
 * value here with an HTTP adapter against the Rust server and the screens do not
 * change — that is the whole point of building UI-first against a frozen contract.
 */

export const api: ApiAdapter & { init(): Promise<void> } = new LocalAdapter({
  now: () => new Date(),
})

export const ApiContext = createContext<ApiAdapter>(api)

export function useApi(): ApiAdapter {
  return useContext(ApiContext)
}

export { LocalAdapter } from './localAdapter'
export { SearchIndex } from './searchIndex'
