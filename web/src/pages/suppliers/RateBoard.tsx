import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, Gift, IndianRupee, Scale, Search, Sparkles, Truck, X,
} from 'lucide-react'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney, formatQty } from '@/lib/format'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { boardSavings, formatDate, money } from './supplierInsights'
import type { CompareRow, SupplierQuote } from './supplierInsights'
import type { PurchaseStatus } from './SupplierDetail'

/**
 * The same medicine, priced across every distributor who supplies it.
 *
 * A supplier sheet can tell you what one distributor charged you last time. It
 * cannot tell you that the man down the road sells the same strip four percent
 * cheaper, and in this trade he routinely does: two agencies carry the same
 * brand, neither volunteers the other's rate, and the gap is invisible because
 * nobody keeps the two bills side by side.
 *
 * The comparison is made on LANDED COST PER PACK, not on the printed rate. A
 * distributor who wins on rate and loses on the scheme is the commonest way a
 * "cheaper" supply is dearer, and a board that ranked on the rate line would
 * recommend exactly the wrong one. Freight is in it for the same reason.
 *
 * The ranking column is not the gap, it is the MONEY: what the shop actually
 * paid above the best rate available, over the packs it actually received. That
 * turns a curiosity into a work queue you stop working when the numbers stop
 * being worth a phone call.
 */

type SortKey = 'overpaid' | 'spread' | 'name'

const SORT_LABEL: Record<SortKey, string> = {
  overpaid: 'Money left on the table',
  spread: 'Widest gap',
  name: 'Medicine (A–Z)',
}

export function RateBoard({
  rows,
  status,
  error,
  windowDays,
  onRetry,
  onOpenSupplier,
}: {
  rows: readonly CompareRow[]
  status: PurchaseStatus
  error?: string
  windowDays: number
  onRetry: () => void
  onOpenSupplier: (id: number) => void
}) {
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<SortKey>('overpaid')
  const [open, setOpen] = useState<number | null>(null)

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase()
    const list = q === ''
      ? [...rows]
      : rows.filter((r) => r.brandName.toLowerCase().includes(q)
        || r.quotes.some((s) => s.supplierName.toLowerCase().includes(q)))

    if (sort === 'name') return list.sort((a, b) => a.brandName.localeCompare(b.brandName))
    if (sort === 'spread') {
      return list.sort((a, b) => Number(b.spreadPct ?? '0') - Number(a.spreadPct ?? '0')
        || a.brandName.localeCompare(b.brandName))
    }
    // `rateBoard` already returns this order; re-sorting keeps it explicit.
    return list.sort((a, b) => D.cmp(money(b.overpaid) ?? D.ZERO, money(a.overpaid) ?? D.ZERO)
      || a.brandName.localeCompare(b.brandName))
  }, [rows, term, sort])

  const recoverable = useMemo(() => boardSavings(rows), [rows])

  if (status === 'loading') {
    return (
      <div className="card min-h-0 flex-1 overflow-hidden">
        <SkeletonRows rows={12} cols={5} />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="card flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <ErrorState
          code="PURCHASES_FAILED"
          message={error ?? 'The purchase register could not be read, so no rate can be compared against another.'}
          onRetry={onRetry}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--card-gap)]">
      <section className="card grid gap-[var(--card-px)] px-[var(--card-px)] py-[var(--card-px)] lg:grid-cols-[minmax(300px,1fr)_minmax(0,1.6fr)]">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-fg-subtle" aria-hidden />
            <span className="micro-label">Left on the table</span>
          </div>
          <div className="display-num mt-2 text-5xl text-fg">{formatMoney(recoverable)}</div>
          <p className="mt-2 text-base text-fg-muted">
            paid above the best landed rate already on offer, over the last{' '}
            {Math.round(windowDays / 30)} months of bills.
          </p>
        </div>

        <div className="flex flex-col justify-center gap-2 border-t border-border-subtle pt-4 lg:border-l lg:border-t-0 lg:pl-[var(--card-px)] lg:pt-0">
          <p className="text-sm text-fg-muted">
            {rows.length === 0
              ? 'No medicine in the window has been bought from more than one distributor, so there is nothing to compare yet.'
              : <>
                <span className="font-medium text-fg">{rows.length}</span> medicine{rows.length === 1 ? '' : 's'} in
                the window came from two or more distributors. Every row is priced on landed cost —
                freight apportioned in and the free scheme divided through — because the cheaper
                rate and the cheaper deal are routinely not the same distributor.
              </>}
          </p>
          <p className="text-xs text-fg-subtle">
            This is arithmetic on bills already received, not a projection: it is what those exact
            packs would have cost at the best rate quoted for them.
          </p>
        </div>
      </section>

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
          <div className="relative w-[280px]">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              aria-label="Find a medicine or a distributor"
              placeholder="Medicine or distributor…"
              autoComplete="off"
              spellCheck={false}
              className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-8 pr-8 text-sm placeholder:text-fg-subtle hover:border-border-strong"
            />
            {term ? (
              <button
                type="button"
                onClick={() => setTerm('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </div>

          <span className="text-sm text-fg-muted">
            {shown.length === rows.length
              ? `${rows.length} comparable`
              : `${shown.length} of ${rows.length}`}
          </span>

          <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-xs hover:border-border-strong"
            >
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>{SORT_LABEL[k]}</option>
              ))}
            </select>
          </label>
        </header>

        <div className="scroll-region min-h-0 flex-1">
          {rows.length === 0 ? (
            <EmptyState
              icon={Scale}
              title="Nothing to compare yet"
              body="A medicine appears here once two different distributors have supplied it. Until then there is one rate on record and no second one to weigh it against."
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No match"
              body={`Nothing on the board matches “${term.trim()}”. The box searches the medicine and the distributor.`}
              actionLabel="Clear search"
              onAction={() => setTerm('')}
            />
          ) : (
            <div>
              <div className={cn('sticky top-0 z-10 grid items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2', COLS)}>
                <span aria-hidden />
                <span className="micro-label">Medicine</span>
                <span className="micro-label">Cheapest landed</span>
                <span className="micro-label">Dearest landed</span>
                <span className="micro-label text-right">Gap</span>
                <span className="micro-label text-right">Overpaid ₹</span>
              </div>
              {shown.map((row) => (
                <BoardRow
                  key={row.medicineId}
                  row={row}
                  open={open === row.medicineId}
                  onToggle={() => setOpen((cur) => (cur === row.medicineId ? null : row.medicineId))}
                  onOpenSupplier={onOpenSupplier}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const COLS = 'grid-cols-[28px_minmax(160px,1.5fr)_minmax(150px,1.2fr)_minmax(150px,1.2fr)_88px_120px]'

function BoardRow({
  row, open, onToggle, onOpenSupplier,
}: {
  row: CompareRow
  open: boolean
  onToggle: () => void
  onOpenSupplier: (id: number) => void
}) {
  const overpaid = money(row.overpaid) ?? D.ZERO
  const worth = D.gt(overpaid, D.dec('100'))

  return (
    <div className="border-b border-border-subtle">
      <button
        type="button"
        data-compare-row
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'grid w-full items-center gap-3 px-[var(--card-px)] py-2.5 text-left',
          COLS,
          open ? 'bg-accent-2' : 'hover:bg-hover',
        )}
      >
        <span className="flex items-center justify-center text-fg-subtle">
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </span>

        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base font-medium text-fg">{row.brandName}</span>
          <span className="truncate text-2xs text-fg-subtle">
            {row.packLabel} · <span className="num">{formatQty(row.packsReceived)}</span> packs received
            {' '}from {row.quotes.length} distributors
          </span>
        </span>

        <QuoteCell quote={row.best} tone="best" />
        <QuoteCell quote={row.worst} tone="worst" />

        <span className="flex flex-col items-end">
          <span className="num text-sm font-medium text-fg">
            {row.spreadPct === null ? '—' : `${row.spreadPct}%`}
          </span>
          <span className="num text-2xs text-fg-subtle">{formatAmount(row.spread)}/pack</span>
        </span>

        <span className={cn('num text-right text-base', worth ? 'font-semibold text-danger-11' : 'text-fg-muted')}>
          {formatAmount(row.overpaid)}
        </span>
      </button>

      {open ? (
        <div className="border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
          <div className="grid grid-cols-[minmax(150px,1.6fr)_100px_110px_96px_1fr] gap-3 border-b border-border-subtle pb-1.5">
            <span className="micro-label">Distributor</span>
            <span className="micro-label text-right">Rate/pack ₹</span>
            <span className="micro-label text-right">Landed/pack ₹</span>
            <span className="micro-label text-right">Vs best</span>
            <span className="micro-label">Last bill</span>
          </div>
          {row.quotes.map((q) => (
            <QuoteRow key={q.supplierId} quote={q} best={row.best} onOpen={() => onOpenSupplier(q.supplierId)} />
          ))}
          <p className="mt-2.5 flex items-start gap-1.5 text-xs text-fg-subtle">
            <IndianRupee size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Landed cost carries the freight on the bill and divides the free packs through, so the
              two columns disagree exactly where a scheme is doing the work.
            </span>
          </p>
        </div>
      ) : null}
    </div>
  )
}

function QuoteCell({ quote, tone }: { quote: SupplierQuote; tone: 'best' | 'worst' }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5">
        <span
          {...(tone === 'best' ? { 'data-quote-best': '' } : { 'data-quote-worst': '' })}
          className={cn('num text-sm font-medium', tone === 'best' ? 'text-success-11' : 'text-danger-11')}
        >
          {formatAmount(quote.landedPerPack)}
        </span>
        {/* The word does the work; the colour only reinforces it. */}
        <span className="text-2xs text-fg-subtle">{tone === 'best' ? 'cheapest' : 'dearest'}</span>
      </span>
      <span className="truncate text-2xs text-fg-muted" title={quote.supplierName}>
        {quote.supplierName}
      </span>
    </span>
  )
}

function QuoteRow({
  quote, best, onOpen,
}: {
  quote: SupplierQuote
  best: SupplierQuote
  onOpen: () => void
}) {
  const isBest = quote.supplierId === best.supplierId
  const delta = D.sub(money(quote.landedPerPack) ?? D.ZERO, money(best.landedPerPack) ?? D.ZERO)
  const free = money(quote.freePacks)

  return (
    <div data-quote-row className="grid grid-cols-[minmax(150px,1.6fr)_100px_110px_96px_1fr] items-center gap-3 border-b border-border-subtle py-2 last:border-0">
      <span className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 truncate text-left text-sm font-medium text-fg hover:text-accent-11 hover:underline"
        >
          {quote.supplierName}
        </button>
        {isBest ? <Chip icon={Truck} tone="var(--success-11)">Best</Chip> : null}
        {free && D.gt(free, D.ZERO) ? (
          <Chip icon={Gift} tone="var(--success-11)">+{formatQty(quote.freePacks)} free</Chip>
        ) : null}
      </span>
      <span className="num text-sm text-fg-muted">{formatAmount(quote.ratePerPack)}</span>
      <span data-quote-landed className="num text-sm font-medium text-fg">{formatAmount(quote.landedPerPack)}</span>
      <span className={cn('num text-sm', isBest ? 'text-success-11' : 'text-danger-11')}>
        {isBest ? '—' : `+${formatAmount(D.toStr(delta, 2))}`}
      </span>
      <span className="truncate text-xs text-fg-subtle">
        {formatDate(quote.at)} · <span className="mono">{quote.supplierInvoiceNo || quote.purchaseNo}</span>
        {' · MRP '}<span className="num">{formatAmount(quote.mrpPerPack)}</span>
      </span>
    </div>
  )
}
