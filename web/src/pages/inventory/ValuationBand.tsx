import { CircleSlash, PackageMinus, ShieldOff, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { InventorySummary } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { compactINR } from '@/components/charts'
import { Button } from '@/components/ui/Button'
import type { Basis } from './analysis'
import { BASIS_NOTE, marginPct, parse } from './analysis'

/**
 * What the shelf is worth, and on what basis.
 *
 * The basis is the whole point of this panel. Landed cost and printed MRP differ
 * by the entire margin, and a stock figure quoted without saying which one it is
 * has caused more arguments with an accountant than any other number in a
 * pharmacy. So both are on screen, the chosen one is the hero, and the words
 * under it say what that basis actually means.
 *
 * The two figures ARE the switch. A separate segmented control beside two
 * numbers would be a third thing to read and would leave the reader asking which
 * of the numbers it governed.
 */

export type StockFilter = 'all' | 'low' | 'out' | 'quarantined'

export function ValuationBand({
  summary, pending, failed, basis, onBasis, stock, onStock, onRetry,
}: {
  summary: InventorySummary | null
  pending: boolean
  failed: boolean
  basis: Basis
  onBasis: (b: Basis) => void
  stock: StockFilter
  onStock: (s: StockFilter) => void
  onRetry: () => void
}) {
  if (failed && summary === null) {
    return (
      <section
        role="alert"
        className="card flex items-start gap-3 p-[var(--card-px)]"
        aria-label="Stock valuation"
      >
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warning-9" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-fg">The stock valuation could not be loaded</h2>
          <p className="mt-0.5 text-sm text-fg-muted">
            The batch list below is unaffected, so the shelf is still workable — only the totals
            are missing.
          </p>
        </div>
        <Button size="sm" onClick={onRetry}>Retry</Button>
      </section>
    )
  }

  const margin = summary ? marginPct(summary.stockValueAtMrp, summary.stockValueAtCost) : null
  const held = summary
    ? D.toStr(
      D.sub(parse(summary.stockValueAtMrp) ?? D.ZERO, parse(summary.stockValueAtCost) ?? D.ZERO),
      2,
    )
    : null

  return (
    <section
      className="card flex min-w-0 flex-col gap-3 p-[var(--card-px)]"
      aria-label="Stock valuation"
      aria-busy={pending}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="micro-label">Stock on hand</h2>
        <span className="truncate text-2xs text-fg-subtle">
          {/* Whichever basis is chosen, this is the SHOP's shelf and not the
              filtered grid below. Two totals that move with a filter would be
              read as the same number disagreeing with itself. */}
          Whole shelf, not this view
        </span>
      </div>

      <div role="group" aria-label="Valuation basis" className="flex min-w-0 items-end gap-5">
        <BasisFigure
          label="Stock at cost"
          value={summary?.stockValueAtCost ?? null}
          active={basis === 'cost'}
          pending={pending}
          onSelect={() => onBasis('cost')}
        />
        <BasisFigure
          label="Stock at MRP"
          value={summary?.stockValueAtMrp ?? null}
          active={basis === 'mrp'}
          pending={pending}
          onSelect={() => onBasis('mrp')}
        />
        {margin !== null && held !== null ? (
          <div className="min-w-0 pb-2.5">
            <span className="micro-label block">Margin held</span>
            <span
              className="display-num mt-0.5 block text-xl text-fg"
              title={`${formatMoney(held)} of gross margin between the two bases`}
            >
              {margin}%
            </span>
          </div>
        ) : null}
      </div>

      {/* The basis, in words. Not a tooltip: the sentence is the reason the two
          numbers are allowed to disagree by this much. */}
      <p className="text-sm text-fg-muted" title={BASIS_NOTE[basis]}>
        <span className="font-medium text-fg">Valued at {basis === 'cost' ? 'landed cost' : 'printed MRP'}.</span>{' '}
        {BASIS_NOTE[basis]}
      </p>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border-subtle pt-3">
        <Fact label="SKUs" value={summary?.totalSkus ?? null} />
        <Fact label="batches" value={summary?.totalBatches ?? null} />
        <span aria-hidden className="h-5 w-px bg-border" />
        {/* Counts of work somebody has to do, so each is the filter that shows
            it. A number you cannot click through to is a guilt trip. */}
        <Toggle
          icon={PackageMinus}
          label="low"
          title="medicines at or below their reorder level"
          value={summary?.lowStockSkus ?? null}
          tone="var(--status-low-stock)"
          on={stock === 'low'}
          onClick={() => onStock(stock === 'low' ? 'all' : 'low')}
        />
        <Toggle
          icon={CircleSlash}
          label="out"
          title="medicines with nothing sellable left"
          value={summary?.outOfStockSkus ?? null}
          tone="var(--status-out-of-stock)"
          on={stock === 'out'}
          onClick={() => onStock(stock === 'out' ? 'all' : 'out')}
        />
        <Toggle
          icon={ShieldOff}
          label="held"
          title="batches in quarantine, which never allocate"
          value={summary?.quarantinedBatches ?? null}
          tone="var(--status-quarantine)"
          on={stock === 'quarantined'}
          onClick={() => onStock(stock === 'quarantined' ? 'all' : 'quarantined')}
        />
      </div>
    </section>
  )
}

function BasisFigure({
  label, value, active, pending, onSelect,
}: {
  label: string
  value: string | null
  active: boolean
  pending: boolean
  onSelect: () => void
}) {
  const n = value === null ? null : parse(value)
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      title={value === null ? label : `${formatMoney(value)} — ${label.toLowerCase()}`}
      className={cn(
        'group flex min-w-0 flex-col items-start rounded-[var(--radius-md)] px-1 text-left',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        active ? 'text-fg' : 'text-fg-muted hover:text-fg',
      )}
    >
      <span className={cn('micro-label', active && 'text-accent-11')}>{label}</span>
      {pending && n === null ? (
        <span
          aria-hidden
          className={cn('mt-2 block h-8 animate-pulse rounded-[var(--radius-md)] bg-inset', active ? 'w-40' : 'w-24')}
        />
      ) : (
        <span className="mt-0.5 flex items-baseline gap-1">
          <span className={cn('font-medium text-fg-muted', active ? 'text-xl' : 'text-sm')}>₹</span>
          {/* Size, not colour, carries the selection: the chosen basis is the
              hero figure and the other is a reference number beside it. */}
          <span className={cn('display-num', active ? 'text-4xl' : 'text-xl')}>
            {n === null ? '—' : compactINR(D.toNumber(n))}
          </span>
        </span>
      )}
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-[3px] w-full rounded-[var(--radius-full)]',
          active ? 'bg-accent-9' : 'bg-transparent group-hover:bg-border',
        )}
      />
    </button>
  )
}

function Fact({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-xs text-fg-muted">
      <span className="num text-sm font-semibold text-fg">
        {value === null ? '—' : value.toLocaleString('en-IN')}
      </span>
      {label}
    </span>
  )
}

function Toggle({
  icon: Icon, label, title, value, tone, on, onClick,
}: {
  icon: LucideIcon
  label: string
  /** What the short chip label actually counts. */
  title: string
  value: number | null
  tone: string
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={`${title} — click to ${on ? 'stop filtering' : 'filter'}`}
      /* The visible chip is two words wide; the accessible name says what it
         actually counts, because "105 out" read aloud means nothing. */
      aria-label={`${value === null ? 'Unknown' : value.toLocaleString('en-IN')} ${title}`}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-full)] border px-2 text-xs',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        on ? 'border-accent-9 bg-accent-2 text-accent-11' : 'border-border bg-surface text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      <Icon size={14} aria-hidden style={{ color: on ? undefined : tone }} />
      <span className="num font-semibold text-fg">{value === null ? '—' : value.toLocaleString('en-IN')}</span>
      {label}
    </button>
  )
}
