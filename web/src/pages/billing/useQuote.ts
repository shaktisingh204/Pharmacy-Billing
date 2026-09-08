import { useQuery } from '@tanstack/react-query'
import type { Quote, QuoteRequest } from '@contract'
import { useApi } from '@/api'
import { useCart } from '@/store/cart'

/**
 * Re-quotes on every cart change.
 *
 * The server owns every number on the screen. The alternative — computing totals
 * in the view and posting them — means two implementations of the tax rules that
 * drift, and a bill whose printed total disagrees with what was stored.
 *
 * `placeholderData: keepPrevious` matters at the counter: without it the totals
 * rail blanks on every keystroke and the operator sees the grand total flicker
 * while they are reading it.
 */
export function useQuote(storeId: number, invoiceDate: string, interState: boolean) {
  const api = useApi()
  const ids = useCart((s) => s.ids)
  const byId = useCart((s) => s.byId)
  const customerId = useCart((s) => s.customerId)
  const billDiscountPct = useCart((s) => s.billDiscountPct)

  const request: QuoteRequest = {
    storeId,
    invoiceDate,
    interState,
    ...(customerId ? { customerId } : {}),
    billDiscountPct,
    lines: ids.flatMap((id) => {
      const l = byId[id]
      if (!l || Number(l.qty) <= 0) return []
      return [{
        lineId: l.lineId,
        medicineId: l.medicineId,
        qty: l.qty,
        freeQty: l.freeQty,
        discountPct: l.discountPct,
        ...(l.batchOverride ? { batchOverride: l.batchOverride } : {}),
      }]
    }),
  }

  const fingerprint = JSON.stringify(request)

  return useQuery<Quote>({
    queryKey: ['quote', fingerprint],
    queryFn: () => api.quoteSale(request),
    enabled: request.lines.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 0,
    // A quote that fails must NOT retry quietly behind a stale total. It once
    // threw on a missing GST rate and the rail rendered a confident zero, which
    // is the most dangerous possible failure at a till.
    retry: false,
  })
}

export const EMPTY_QUOTE: Quote = {
  lines: [],
  grossAmount: '0.00', itemDiscount: '0.00', billDiscountPct: '0', billDiscount: '0.00',
  taxableValue: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00',
  roundOff: '0.00', netAmount: '0.00', taxBreakup: [], warnings: [], costOfGoods: '0.00',
}
