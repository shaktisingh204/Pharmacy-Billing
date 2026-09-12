import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Medicine, Pct } from '@contract'
import { useApi } from '@/api'
import { explainDiscount, revisionInForce } from './pricePolicy'
import type { PriceRevision, PriceRule } from './pricePolicy'

/** One shared empty list, so "no policy" has a stable identity across renders. */
const EMPTY: readonly PriceRule[] = []

/**
 * What the chain's price list says, at the counter.
 *
 * A hook rather than a call site, because two properties have to hold every time
 * anybody asks and neither survives being re-derived per screen:
 *
 *  - IT NEVER BLOCKS. The list is data that arrives over a link explicitly
 *    allowed to be down for a week. While it is loading, or if it never loads,
 *    every medicine prices at zero discount and billing continues. There is no
 *    state of this hook in which the counter has to wait.
 *  - IT RESOLVES BY THE BILL'S DATE. `today` and not "now" — a bill dated
 *    yesterday is priced by yesterday's list, the same rule the tax rate follows.
 */
export function usePriceList(today: string): {
  revision: PriceRevision | null
  rules: readonly PriceRule[]
  /** The list discount for this medicine. Zero when nothing is published. */
  policyFor: (medicine: Pick<Medicine, 'id' | 'manufacturer'>) => Pct
  /** The rule that decided, for a screen that has to explain a figure. */
  explainFor: (medicine: Pick<Medicine, 'id' | 'manufacturer'>) => ReturnType<typeof explainDiscount>
} {
  const api = useApi()

  const revisions = useQuery({
    queryKey: ['priceRevisions'],
    queryFn: () => api.listPriceRevisions(),
    /* The list changes when somebody at HQ publishes, which is not something a
       counter needs to poll for mid-queue. It is re-read when the till comes
       back to the screen, which is soon enough for a price that is dated
       forward anyway. */
    staleTime: 5 * 60_000,
  })

  const revision = useMemo(
    () => revisionInForce(revisions.data ?? [], today),
    [revisions.data, today],
  )
  /* Memoised, and not `revision?.rules ?? []` inline: the fallback would be a
     fresh array on every render, which changes the identity of both callbacks
     below and re-creates the cart's `addMedicine` on every keystroke. */
  const rules = useMemo<readonly PriceRule[]>(() => revision?.rules ?? EMPTY, [revision])

  const explainFor = useCallback(
    (medicine: Pick<Medicine, 'id' | 'manufacturer'>) => explainDiscount(rules, medicine),
    [rules],
  )

  const policyFor = useCallback(
    (medicine: Pick<Medicine, 'id' | 'manufacturer'>) => explainDiscount(rules, medicine).discountPct,
    [rules],
  )

  return { revision, rules, policyFor, explainFor }
}
