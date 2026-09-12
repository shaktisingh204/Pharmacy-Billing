import { useNavigate } from 'react-router-dom'
import { Building2, CalendarClock, CircleDot, Package } from 'lucide-react'
import type { BranchSummaryRow } from '@contract'
import * as D from '@/domain/decimal'
import { formatAmount, formatQty } from '@/lib/format'
import { compactINR } from '@/components/charts'
import { Chip } from '@/components/ui/Badge'
import { Panel } from './panels'

/**
 * Both branches, side by side.
 *
 * Takings AND shelf, because takings alone is a blank column for any branch that
 * has not billed yet — which is every branch at nine in the morning — and the
 * question an owner opens this screen with is usually "which shop should the
 * stock go to", not "which shop is ahead by lunchtime".
 *
 * The bar encodes share of the chain's takings and carries no meaning of its own:
 * every figure beside it is written out, so a reader who cannot separate the bars
 * has lost nothing.
 */
export function BranchPanel({
  branches,
  rangePhrase,
  showsCost,
}: {
  branches: BranchSummaryRow[]
  rangePhrase: string
  /** A pharmacist sees the shelf, never what the chain paid for it. */
  showsCost: boolean
}) {
  const navigate = useNavigate()
  const peak = Math.max(0, ...branches.map((b) => Number(b.sales)))
  /* Money is added through src/domain/decimal, never as JS numbers — the same
     rule that holds everywhere else in the app. It is a headline rather than a
     ledger, but "the chain took X" is a figure an owner quotes, and a float sum
     of paisa-precision figures is exactly how the quoted number drifts from the
     register. Converted to a number ONCE, at the compaction boundary. */
  const total = {
    sales: D.sum(branches.map((b) => D.dec(b.sales))),
    orders: branches.reduce((n, b) => n + b.orders, 0),
    stockAtCost: D.sum(branches.map((b) => D.dec(b.stockAtCost))),
    nearExpiry: branches.reduce((n, b) => n + b.nearExpiry, 0),
  }

  return (
    <Panel
      title="Branches"
      icon={Building2}
      action="Move stock"
      onAction={() => navigate('/inventory')}
    >
      <div className="border-b border-border-subtle px-[var(--card-px)] py-2 text-xs text-fg-muted">
        Takings · {rangePhrase}, and what is on each shelf right now
      </div>
      <ul className="m-0 list-none p-0">
        {branches.map((b) => {
          const sales = Number(b.sales)
          const share = peak > 0 ? Math.max(sales > 0 ? 2 : 0, (sales / peak) * 100) : 0
          return (
            <li
              key={b.storeId}
              className="border-b border-border-subtle px-[var(--card-px)] py-3 last:border-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-base font-medium text-fg">{b.name}</span>
                  {b.isCurrent ? (
                    <Chip icon={CircleDot} tone="var(--accent-11)">Billing here</Chip>
                  ) : null}
                </span>
                <span className="num shrink-0 text-lg font-semibold text-fg">
                  {b.orders === 0 ? (
                    <span className="text-base font-normal text-fg-subtle">No bills yet</span>
                  ) : (
                    `₹${compactINR(sales)}`
                  )}
                </span>
              </div>

              <div className="mt-2 h-1.5 overflow-hidden rounded-[var(--radius-full)] bg-inset">
                <div
                  className="h-full rounded-[var(--radius-full)]"
                  style={{ width: `${share}%`, backgroundColor: 'var(--viz-1)' }}
                />
              </div>

              <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-2xs text-fg-muted">
                <Stat label="Bills" value={formatQty(b.orders)} />
                {showsCost ? <Stat label="Stock at cost" value={`₹${formatAmount(b.stockAtCost)}`} /> : null}
                <Stat icon={Package} label="Batches" value={formatQty(b.batches)} />
                <Stat icon={CalendarClock} label="Near expiry" value={formatQty(b.nearExpiry)} />
              </dl>
              <p className="mt-1 truncate text-2xs text-fg-subtle">{b.city}</p>
            </li>
          )
        })}
      </ul>

      {/* The chain, added up. Two branches read side by side is a comparison; the
          number an owner then quotes is the total, and computing it in their head
          from two rounded figures is how it gets quoted wrong. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border bg-subtle px-[var(--card-px)] py-3">
        <span className="micro-label">Chain total</span>
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-2xs text-fg-muted">
          <Stat label="Takings" value={`₹${compactINR(D.toNumber(total.sales))}`} />
          <Stat label="Bills" value={formatQty(total.orders)} />
          {showsCost ? <Stat label="Stock at cost" value={`₹${compactINR(D.toNumber(total.stockAtCost))}`} /> : null}
          <Stat label="Near expiry" value={formatQty(total.nearExpiry)} />
        </dl>
      </div>
    </Panel>
  )
}

/** A <div> and not a <span>: only div may wrap a dt/dd pair inside a dl. */
function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof Package
  label: string
  value: string
}) {
  return (
    <div className="flex items-baseline gap-1">
      {Icon ? <Icon size={11} aria-hidden className="translate-y-px text-fg-subtle" /> : null}
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="num font-medium text-fg">{value}</dd>
    </div>
  )
}
