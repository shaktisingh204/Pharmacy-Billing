import { ClipboardCheck, PackageCheck, PackageMinus, PackagePlus, X } from 'lucide-react'
import type { PurchaseOrder } from '@contract'
import { cn } from '@/lib/cn'
import { formatPercent, formatQty } from '@/lib/format'
import { reconcileOrder } from '@/api/purchaseOrders'
import type { KeyedLine, OrderLineCompare } from '@/api/purchaseOrders'
import { Meter } from './parts'

/**
 * Receiving goods against the order that asked for them.
 *
 * The order is a promise; the bill is what turned up. Every incumbent lets you
 * key the bill as though the order never existed, so nobody ever learns that
 * four lines were dropped — they are simply re-ordered next week, at next week's
 * rate, and the distributor's fill rate stays a feeling rather than a number.
 *
 * Picking an order here does two things and only two: it fills the grid with the
 * lines that were ordered, and it lays the order over whatever gets keyed. The
 * receipt is still the document — nothing is auto-posted, no quantity is
 * assumed, and the batch, expiry and rate still come off the paper bill.
 */

export function OrderPicker({
  orders, selected, onPick, busy,
}: {
  orders: readonly PurchaseOrder[]
  selected: PurchaseOrder | null
  onPick: (order: PurchaseOrder | null) => void
  busy: boolean
}) {
  if (orders.length === 0) return null
  return (
    <label className="block shrink-0">
      <span className="micro-label mb-0.5 block">Against order</span>
      <select
        aria-label="Receive against a purchase order"
        disabled={busy}
        value={selected?.id ?? ''}
        onChange={(e) => {
          const id = e.target.value === '' ? null : Number(e.target.value)
          onPick(id === null ? null : orders.find((o) => o.id === id) ?? null)
        }}
        className={cn(
          'h-[var(--control-h)] w-[196px] rounded-[var(--radius-md)] border border-border bg-surface',
          'px-2 text-base hover:border-border-strong disabled:opacity-55',
        )}
      >
        <option value="">Not against an order</option>
        {orders.map((o) => (
          <option key={o.id} value={o.id}>
            {o.orderNo} · {o.lines.length} line{o.lines.length === 1 ? '' : 's'}
            {o.expectedOn ? ` · due ${o.expectedOn}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

const STATUS_STYLE: Record<OrderLineCompare['status'], { tone: string; word: string; icon: typeof PackageCheck }> = {
  exact: { tone: 'text-success-11', word: 'in full', icon: PackageCheck },
  short: { tone: 'text-warning-11', word: 'short', icon: PackageMinus },
  over: { tone: 'text-info-11', word: 'extra', icon: PackagePlus },
  missing: { tone: 'text-danger-11', word: 'not sent', icon: PackageMinus },
}

/**
 * The order laid over the keyed bill, live.
 *
 * It never blocks a post. A distributor is entitled to short-supply and the shop
 * is entitled to receive what actually arrived; what it must not do is fail to
 * NOTICE. So this states the gap, on the counter, while the driver is still
 * there — and the same arithmetic feeds the fill rate on the Insights tab.
 */
export function OrderProgressStrip({
  order, keyed, onDetach,
}: {
  order: PurchaseOrder
  keyed: readonly KeyedLine[]
  onDetach: () => void
}) {
  const r = reconcileOrder(order, keyed)
  const outstanding = r.lines.filter((l) => l.status !== 'exact')
  const pct = r.fillPct === null ? 0 : Number.parseFloat(r.fillPct)

  return (
    <div
      /* The stable hook this strip is asserted on: its own order number also
         appears inside the picker's options, where it is not visible. */
      data-order-strip
      className="shrink-0 border-b border-border-subtle bg-raised px-[var(--card-px)] py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <ClipboardCheck size={16} className="text-accent-11" aria-hidden />
          <span className="mono text-sm font-medium text-fg">{order.orderNo}</span>
          <span className="text-xs text-fg-muted">
            {order.expectedOn ? `due ${order.expectedOn}` : 'no date agreed'}
          </span>
        </span>

        <span className="flex min-w-[180px] max-w-[280px] flex-1 items-center gap-2">
          <Meter
            pct={pct}
            tone={pct >= 95 ? 'success' : pct >= 60 ? 'warning' : 'danger'}
            ariaLabel={`${order.orderNo} filled by what has been keyed`}
          />
          <span className="num shrink-0 text-sm font-medium text-fg">
            {r.fillPct === null ? '—' : formatPercent(r.fillPct)}
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <Count tone="text-success-11" icon={PackageCheck} n={r.exact} word="in full" />
          <Count tone="text-warning-11" icon={PackageMinus} n={r.short} word="short" />
          <Count tone="text-danger-11" icon={PackageMinus} n={r.missing} word="not sent" />
          <Count tone="text-info-11" icon={PackagePlus} n={r.over} word="over-supplied" />
          {r.extras > 0 ? (
            <span className="text-fg-muted">
              <span className="num font-medium">{r.extras}</span> keyed that were not ordered
            </span>
          ) : null}
        </span>

        <button
          type="button"
          onClick={onDetach}
          aria-label={`Stop receiving against ${order.orderNo}`}
          className="ml-auto shrink-0 rounded-[var(--radius-sm)] p-1.5 text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      {outstanding.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {outstanding.slice(0, 6).map((l) => {
            const style = STATUS_STYLE[l.status]
            const Icon = style.icon
            return (
              <li
                key={l.medicineId}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle',
                  'bg-surface px-2 py-1 text-2xs',
                  style.tone,
                )}
                title={l.basis}
              >
                <Icon size={12} aria-hidden />
                <span className="max-w-[160px] truncate font-medium text-fg">{l.brandName}</span>
                {/* The word as well as the tone, and the units either way: "short"
                    on its own does not tell anybody how much to chase. */}
                <span className="num">
                  {style.word} · {formatQty(l.keyedUnits)} of {formatQty(l.orderedUnits)}
                </span>
              </li>
            )
          })}
          {outstanding.length > 6 ? (
            <li className="inline-flex items-center px-1 text-2xs text-fg-subtle">
              +{outstanding.length - 6} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

function Count({
  n, word, tone, icon: Icon,
}: {
  n: number
  word: string
  tone: string
  icon: typeof PackageCheck
}) {
  if (n === 0) return null
  return (
    <span className={cn('inline-flex items-center gap-1', tone)}>
      <Icon size={12} aria-hidden />
      <span className="num font-medium">{n}</span> {word}
    </span>
  )
}
