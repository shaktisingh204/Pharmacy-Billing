import { createContext, useContext } from 'react'
import type { ApiAdapter, BrandProfile } from '@contract'
import { DEFAULT_BRAND } from './applyBrand'

/**
 * The brand, read from context.
 *
 * Every consumer reads it here rather than calling getBrand() itself, so the
 * shell, the receipts and the settings preview can never disagree about which
 * name the product currently has.
 */

export const brandQueryKey = ['brand'] as const

/**
 * Shared by the provider and the settings panel so both sit on one cache entry:
 * saving writes through it and the shell re-themes without a refetch.
 *
 * Never stale. Branding changes when a human saves it and at no other moment,
 * and a background refetch that re-applied the accent mid-sale would repaint the
 * POS for no reason.
 */
export function brandQueryOptions(api: ApiAdapter) {
  return {
    queryKey: brandQueryKey,
    queryFn: () => api.getBrand(),
    staleTime: Number.POSITIVE_INFINITY,
  }
}

/**
 * Defaults to the built-in profile rather than throwing on a missing provider.
 *
 * A branded name is cosmetic; the till is not. A print-only tree or a component
 * test that forgot the provider should render under the product's own identity,
 * not take out the screen.
 */
export const BrandContext = createContext<BrandProfile>(DEFAULT_BRAND)

export function useBrand(): BrandProfile {
  return useContext(BrandContext)
}
