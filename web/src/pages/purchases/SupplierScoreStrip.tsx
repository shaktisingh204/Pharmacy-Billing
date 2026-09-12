import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PackageCheck, Timer, TrendingUp, Handshake } from 'lucide-react'
import type { ApiAdapter, PurchaseInvoice, Supplier } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatPercent } from '@/lib/format'
import { supplierScorecards } from '@/api/purchaseInsights'

/**
 * The distributor's record, at the moment their bill is being keyed.
 *
 * This is the only moment any of it is actionable: the driver is at the counter,
 * the salesman is on the phone, and "you shorted us on the last two orders" or
 * "your rate has moved twice this quarter" is a sentence that can only be said
 * now. The full scorecard lives on the Insights tab; four figures live here.
 *
 * Loaded only once a supplier is chosen. The goods-receipt tab is where this
 * screen opens, and walking the whole register on every visit to key a bill
 * nobody has named a supplier for is work for nothing.
 */

/** Twelve months of history, the same window the Insights scorecard scores on. */
async function loadRegister(api: ApiAdapter): Promise<PurchaseInvoice[]> {
  const out: PurchaseInvoice[] = []
  let cursor: number | null = null
  for (let page = 0; page < 20; page++) {
    const res: { rows: PurchaseInvoice[]; nextCursor: number | null } = await api.listPurchases(
      cursor === null ? { limit: 200 } : { limit: 200, cursor },
    )
    out.push(...res.rows)
    if (res.nextCursor === null) break
    cursor = res.nextCursor
  }
  return out
}

export function SupplierScoreStrip({ supplier }: { supplier: Supplier }) {
  const api = useApi()
  const today = useMemo(() => new Date(), [])

  const register = useQuery({
    queryKey: ['purchases', 'insights', 'register'],
    queryFn: () => loadRegister(api),
  })
  const orders = useQuery({
    queryKey: ['purchaseOrders'],
    queryFn: () => api.listPurchaseOrders({}),
  })
  const returns = useQuery({
    queryKey: ['supplierReturns'],
    queryFn: () => api.listSupplierReturns({}),
  })

  const score = useMemo(() => supplierScorecards({
    suppliers: [supplier],
    purchases: register.data ?? [],
    orders: orders.data ?? [],
    returns: returns.data ?? [],
    today,
  })[0] ?? null, [supplier, register.data, orders.data, returns.data, today])

  if (score === null || register.isPending) return null

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <Cell
        icon={PackageCheck}
        label="Fill rate"
        value={score.fill.pct === null ? null : formatPercent(score.fill.pct)}
        hint={score.fill.pct === null
          ? 'no order with them has come due yet'
          : `over ${score.fill.orders} order${score.fill.orders === 1 ? '' : 's'}`}
        tone={score.fill.pct === null ? 'muted'
          : D.gte(D.dec(score.fill.pct), D.dec('95')) ? 'good' : 'warn'}
      />
      <Cell
        icon={Timer}
        label="Lead time"
        value={score.leadTimeDays === null ? null : `${score.leadTimeDays} days`}
        hint={score.leadTimeDays === null ? 'nothing ordered here has arrived yet' : 'order to delivery'}
        tone="muted"
      />
      <Cell
        icon={TrendingUp}
        label="Rate rises"
        value={score.rateRises === 0 && score.rateFalls === 0 ? null : String(score.rateRises)}
        hint={score.medianRisePct === null
          ? 'no pack bought twice from them yet'
          : `typically ${formatPercent(score.medianRisePct)}, last 12 months`}
        tone={score.rateRises > 0 ? 'warn' : 'good'}
      />
      <Cell
        icon={Handshake}
        label="Claims settled"
        value={score.claims.settledPct === null ? null : formatPercent(score.claims.settledPct)}
        hint={score.claims.open > 0
          ? `${score.claims.open} still waiting on a credit note`
          : 'of what was claimed and settled'}
        tone={score.claims.open > 0 ? 'warn' : 'muted'}
      />
    </div>
  )
}

/** A figure with a mark and a word. A dash means unknown — never a zero. */
function Cell({
  icon: Icon, label, value, hint, tone,
}: {
  icon: typeof PackageCheck
  label: string
  value: string | null
  hint: string
  tone: 'good' | 'warn' | 'muted'
}) {
  return (
    <span className="flex items-center gap-1.5" title={hint}>
      <Icon
        size={13}
        aria-hidden
        className={cn(
          value === null ? 'text-fg-disabled'
            : tone === 'good' ? 'text-success-11' : tone === 'warn' ? 'text-warning-11' : 'text-fg-subtle',
        )}
      />
      <span className="micro-label">{label}</span>
      <span className={cn('num text-xs font-medium', value === null ? 'text-fg-disabled' : 'text-fg')}>
        {value ?? '—'}
      </span>
      <span className="sr-only">{hint}</span>
    </span>
  )
}
