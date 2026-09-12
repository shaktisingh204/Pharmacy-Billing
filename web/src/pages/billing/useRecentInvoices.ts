import { useQuery } from '@tanstack/react-query'
import type { SaleInvoice } from '@contract'
import { useApi } from '@/api'

/** How far back the counter can reach without opening the Sales register. */
const RECENT_LIMIT = 8

/**
 * The last few bills off THIS counter, whole — not register rows.
 *
 * A register row cannot be reprinted: the receipt is rendered from the invoice's
 * own quote, so the strip has to hold the documents themselves. Eight of them
 * out of IndexedDB is cheaper than the search index this screen already warms,
 * and it buys two features off one query — reprint, and the "just sold" tiles,
 * which are the truest fast-mover signal a shop has (yesterday's ranking cannot
 * know about the flu going round this morning).
 */
export function useRecentInvoices(today: string) {
  const api = useApi()
  return useQuery<SaleInvoice[]>({
    queryKey: ['billing', 'recent-invoices', today],
    queryFn: async () => {
      const page = await api.listSales({ from: today, to: today, sort: 'time', limit: RECENT_LIMIT })
      const invoices = await Promise.all(
        page.rows.map((r) => api.getInvoice(r.id).catch(() => null)),
      )
      return invoices.filter((i): i is SaleInvoice => i !== null)
    },
    // A reprint of a VOIDED bill is legitimate and the register marks it, so the
    // filter is on nothing: what the counter must not do is silently miss a bill.
    staleTime: 15_000,
  })
}
