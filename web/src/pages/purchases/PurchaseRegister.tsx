import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Ban, CircleCheck, ClipboardCheck, FileMinus2, Search, ScrollText, TrendingDown, TrendingUp,
  Truck, Wallet, X,
} from 'lucide-react'
import type { PurchaseInvoice } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatPercent, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Chip } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'
import { panelStatus, useOnline } from './GrnEntry'
import { Figure, PanelFooter } from './parts'

/**
 * The purchase register.
 *
 * What a pharmacist comes here for is never "browse my purchases" — it is one of
 * four questions: did this bill get entered, what did I pay for this batch, what
 * is still unpaid on it, and did the rate move. So the list is newest-first, it
 * is searchable by the number printed on the distributor's own bill, it carries
 * what is still owed on every row, and the panel shows the LINES — because the
 * answer to the second question is a batch, not a total.
 *
 * Posted documents are immutable (INVARIANTS I20): there is deliberately no edit
 * affordance anywhere on this screen. A correction is a debit note, and the
 * absence of a pencil here — beside a button that raises the debit note instead
 * — is part of that rule being real.
 */

const PAGE_SIZE = 100

/** Matches --row-h at compact density; the virtualiser and the DOM must agree. */
const ROW_H = 36

/**
 * The line's expiry, however the backend chose to hand it over.
 *
 * `PurchaseLineInput.expiry` is what the operator keyed — "11/27" — but a posted
 * line comes back carrying the normalised last-day-of-month date the batch was
 * created with. Both are correct and the panel has to read either, because which
 * one arrives is the adapter's business and not this screen's.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function expiryLabel(raw: string): string {
  return ISO_DATE.test(raw) ? formatExpiry(raw) : raw
}

/** Tax as one figure. The rate-wise split belongs on the document, not the list. */
function totalTax(p: PurchaseInvoice): string {
  return D.toStr(D.sum([D.dec(p.cgst), D.dec(p.sgst), D.dec(p.igst)]), 2)
}

/** What is still owed on a bill. Never negative: an overpayment is not a debt. */
function unpaidOf(p: PurchaseInvoice): D.Decimal {
  if (p.status === 'CANCELLED') return D.ZERO
  return D.max(D.ZERO, D.sub(D.dec(p.netAmount), D.dec(p.amountPaid)))
}

type Payment = 'paid' | 'part' | 'unpaid'

function paymentOf(p: PurchaseInvoice): Payment {
  const paid = D.dec(p.amountPaid)
  if (D.isZero(paid)) return 'unpaid'
  return D.gte(paid, D.dec(p.netAmount)) ? 'paid' : 'part'
}

export function PurchaseRegister({
  selectedId, onSelect, onNewGrn, onReturnAgainst,
}: {
  /** The open document, owned by the URL so a bill is a link. */
  selectedId: number | null
  onSelect: (id: number | null) => void
  onNewGrn: () => void
  /** Hands a bill to the returns tab, where a debit note has to name one. */
  onReturnAgainst: (purchaseId: number, supplierId: number) => void
}) {
  const api = useApi()
  const online = useOnline()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [term, setTerm] = useState('')
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [unpaidOnly, setUnpaidOnly] = useState(false)

  const list = useInfiniteQuery({
    queryKey: ['purchases', 'register'],
    queryFn: ({ pageParam }) =>
      api.listPurchases({ limit: PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: { nextCursor: number | null }) => last.nextCursor,
  })

  const suppliers = useQuery({ queryKey: ['suppliers', ''], queryFn: () => api.listSuppliers() })

  /* Read off the query rather than closing over it: the query object is a fresh
     identity every render, and an effect that depends on it runs every render. */
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list

  const rows = useMemo(
    () => list.data?.pages.flatMap((p) => p.rows) ?? [],
    [list.data],
  )

  const filtered = term.trim() !== '' || supplierId !== null || unpaidOnly

  /**
   * The filter runs over what has been loaded, so it keeps loading.
   *
   * `listPurchases` is a cursor page with no server-side search, so a bill
   * matching the typed number can be sitting on page four. Searching only the
   * first hundred rows and reporting "no receipts" about a bill that is
   * definitely on file is worse than a slower answer, so an active filter pulls
   * the rest of the book in behind it.
   */
  useEffect(() => {
    if (filtered && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [filtered, hasNextPage, isFetchingNextPage, fetchNextPage])

  const view = useMemo(() => {
    const needle = term.trim().toLowerCase()
    return rows.filter((r) => {
      if (supplierId !== null && r.supplierId !== supplierId) return false
      if (unpaidOnly && !D.gt(unpaidOf(r), D.ZERO)) return false
      if (needle === '') return true
      return r.purchaseNo.toLowerCase().includes(needle)
        || r.supplierInvoiceNo.toLowerCase().includes(needle)
        || r.supplierName.toLowerCase().includes(needle)
        || r.invoiceDate.includes(needle)
    })
  }, [rows, term, supplierId, unpaidOnly])

  const totals = useMemo(() => {
    let net = D.ZERO
    let unpaid = D.ZERO
    for (const r of view) {
      if (r.status === 'CANCELLED') continue
      net = D.add(net, D.dec(r.netAmount))
      unpaid = D.add(unpaid, unpaidOf(r))
    }
    return { net: D.toStr(net, 2), unpaid: D.toStr(unpaid, 2) }
  }, [view])

  const status = panelStatus(
    { isPending: list.isPending, error: list.error, hasData: list.data !== undefined },
    online,
  )

  const selectedIndex = view.findIndex((r) => r.id === selectedId)
  const selected = selectedIndex >= 0 ? view[selectedIndex] ?? null : null

  /* A document handed over from the duplicate banner is almost always on page
     one — but "almost" is not good enough when the whole point is to show the
     operator the bill they just re-keyed. Keep paging until it turns up or the
     register runs out. */
  useEffect(() => {
    if (selectedId === null || selectedIndex >= 0) return
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [selectedId, selectedIndex, hasNextPage, isFetchingNextPage, fetchNextPage])

  /* Following the URL rather than the click: a deep link and a handoff from the
     GRN both have to land the highlight on the opened row. */
  const [lastSelected, setLastSelected] = useState(selectedId)
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId)
    if (selectedIndex >= 0) setActiveIndex(selectedIndex)
  }

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => view[index]?.id ?? index,
    overscan: 12,
  })

  const items = virtualizer.getVirtualItems()
  const lastRendered = items.at(-1)?.index ?? 0

  /* Page ahead while there is still a screenful below the fold, so the operator
     never arrives at the bottom and waits. */
  useEffect(() => {
    if (view.length > 0 && lastRendered >= view.length - 20 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [lastRendered, view.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < view.length) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, view.length, virtualizer])

  const narrow = selected !== null
  const template = narrow
    ? 'minmax(96px,0.9fr) minmax(120px,1.4fr) 96px 92px 88px'
    : 'minmax(104px,0.8fr) minmax(150px,1.4fr) minmax(96px,0.7fr) 92px 44px 96px 88px 100px 96px 96px'

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target)) return
    const last = view.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0) }
    else if (e.key === 'End') { e.preventDefault(); setActiveIndex(Math.max(last, 0)) }
    else if (e.key === 'Enter') {
      const row = view[activeIndex]
      if (row) { e.preventDefault(); onSelect(row.id) }
    } else if (e.key === 'Escape' && selectedId !== null) {
      e.preventDefault()
      onSelect(null)
    }
  }

  /* The header is a ROW OF THE GRID, so it is rendered INSIDE the grid element
     rather than as a sibling above it. A row element outside the grid element
     is not a row at all: axe calls it critical, and what it means in practice is
     that a screen-reader user tabbing into this table hears a wall of numbers
     with no column names attached to any of them. */
  const headerRow = (
          <div
            role="row"
            className="sticky top-0 z-10 grid shrink-0 items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)]"
            style={{ gridTemplateColumns: template, height: 30 }}
          >
            <span role="columnheader" className="micro-label truncate">Receipt no</span>
            <span role="columnheader" className="micro-label truncate">Supplier</span>
            {!narrow ? <span role="columnheader" className="micro-label truncate">Supplier bill</span> : null}
            <span role="columnheader" className="micro-label truncate">Bill date</span>
            {!narrow ? <span role="columnheader" className="micro-label truncate text-right">Lines</span> : null}
            {!narrow ? <span role="columnheader" className="micro-label truncate text-right">Taxable ₹</span> : null}
            {!narrow ? <span role="columnheader" className="micro-label truncate text-right">GST ₹</span> : null}
            <span role="columnheader" className="micro-label truncate text-right">Net ₹</span>
            {!narrow ? <span role="columnheader" className="micro-label truncate text-right">Unpaid ₹</span> : null}
            <span role="columnheader" className="micro-label truncate">Status</span>
          </div>
  )

  return (
    <div className="flex min-h-0 flex-1 gap-[var(--card-gap)]">
      <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle px-[var(--card-px)] py-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
              <ScrollText size={17} className="text-fg-subtle" aria-hidden /> Purchase register
            </h2>
            <p className="mt-0.5 truncate text-xs text-fg-muted">
              Every batch in the shop was born on one of these. Search by their bill number, yours,
              or the distributor.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
                aria-hidden
              />
              <input
                value={term}
                onChange={(e) => { setTerm(e.target.value); setActiveIndex(0) }}
                type="search"
                aria-label="Find a receipt"
                placeholder="Bill no, receipt no or distributor…"
                className="h-10 w-[248px] rounded-[var(--radius-md)] border border-border bg-surface pl-8 pr-2.5 text-sm hover:border-border-strong"
              />
            </div>
            <select
              aria-label="Filter by supplier"
              value={supplierId ?? ''}
              onChange={(e) => {
                setSupplierId(e.target.value === '' ? null : Number(e.target.value))
                setActiveIndex(0)
              }}
              className="h-10 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
            >
              <option value="">Every distributor</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={unpaidOnly}
              onClick={() => { setUnpaidOnly((v) => !v); setActiveIndex(0) }}
              className={cn(
                'inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm font-medium',
                'transition-colors duration-[var(--dur-fast)]',
                unpaidOnly
                  ? 'border-accent-9/45 bg-accent-3 text-accent-11'
                  : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
              )}
            >
              <Wallet size={15} aria-hidden /> Unpaid only
            </button>
          </div>
        </header>

        {/* The figures the list adds up to, over whatever is being shown. A total
            that ignores the filter above it is a total nobody can reconcile. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-2.5">
          <Figure
            label={filtered ? 'Receipts shown' : 'Receipts'}
            value={
              <>
                {formatQty(view.length)}
                {filtered ? <span className="text-fg-subtle"> of {formatQty(rows.length)}</span> : null}
              </>
            }
          />
          <Figure label="Value ₹" value={formatAmount(totals.net)} />
          <Figure
            label="Still unpaid ₹"
            value={formatAmount(totals.unpaid)}
            tone={D.gt(D.dec(totals.unpaid), D.ZERO) ? 'warning' : 'default'}
          />
          {list.isFetchingNextPage ? (
            <span className="text-2xs text-fg-subtle">loading the rest of the book…</span>
          ) : null}
        </div>

        <div data-density="compact" className="flex min-h-0 flex-1 flex-col">

          {status === 'loading' ? (
            <SkeletonRows rows={12} cols={narrow ? 5 : 10} />
          ) : status === 'offline' ? (
            <OfflineState />
          ) : status === 'denied' ? (
            <PermissionDenied needs="purchases.view" />
          ) : status === 'error' ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <ErrorState
                code={list.error instanceof ApiError ? list.error.code : 'PURCHASES_FAILED'}
                message={(list.error as Error | null)?.message}
                onRetry={() => void list.refetch()}
              />
            </div>
          ) : view.length === 0 ? (
            <div className="min-h-0 flex-1 overflow-auto">
              {filtered ? (
                <EmptyState
                  icon={Search}
                  title="Nothing matches that"
                  body="The whole register has been searched, not just the first page. Clear the filters to see every receipt."
                  actionLabel="Clear the filters"
                  onAction={() => { setTerm(''); setSupplierId(null); setUnpaidOnly(false) }}
                />
              ) : (
                <EmptyState
                  icon={Truck}
                  title="No goods received yet"
                  body="Every batch in the shop is born on one of these documents — the supplier bill carries the batch, expiry, MRP and the rate that becomes your landed cost."
                  actionLabel="Record a goods receipt"
                  onAction={onNewGrn}
                />
              )}
            </div>
          ) : (
            <div
              ref={scrollRef}
              role="grid"
              tabIndex={0}
              aria-label="Purchase register"
              aria-rowcount={view.length + 1}
              onKeyDown={onKeyDown}
              data-focus-inset
              className="scroll-region min-h-0 flex-1"
            >
              {headerRow}
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {items.map((item) => {
                  const row = view[item.index]
                  if (!row) return null
                  const active = item.index === activeIndex
                  const isSelected = row.id === selectedId
                  const cancelled = row.status === 'CANCELLED'
                  const unpaid = unpaidOf(row)
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={item.index + 2}
                      aria-selected={isSelected}
                      onClick={() => { setActiveIndex(item.index); onSelect(row.id) }}
                      className={cn(
                        'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-border-subtle px-[var(--cell-px)]',
                        'transition-colors duration-[var(--dur-fast)]',
                        isSelected ? 'bg-accent-3' : active ? 'bg-accent-3/45' : 'hover:bg-hover',
                        cancelled && 'opacity-60',
                      )}
                      style={{
                        height: ROW_H,
                        transform: `translateY(${item.start}px)`,
                        gridTemplateColumns: template,
                      }}
                    >
                      {(active || isSelected) && (
                        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />
                      )}
                      <span className="mono truncate text-sm text-fg">{row.purchaseNo}</span>
                      <span className="truncate text-base font-medium" title={row.supplierName}>{row.supplierName}</span>
                      {!narrow ? <span className="mono truncate text-sm text-fg-muted">{row.supplierInvoiceNo}</span> : null}
                      <span className="num text-base text-fg-muted">{row.invoiceDate}</span>
                      {!narrow ? <span className="num text-base text-fg-muted">{row.lines.length}</span> : null}
                      {!narrow ? <span className="num text-base text-fg-muted">{formatAmount(row.taxableValue)}</span> : null}
                      {!narrow ? <span className="num text-base text-fg-muted">{formatAmount(totalTax(row))}</span> : null}
                      <span className="num text-base font-medium">{formatAmount(row.netAmount)}</span>
                      {!narrow ? (
                        <span className={cn(
                          'num text-base',
                          D.gt(unpaid, D.ZERO) ? 'font-medium text-warning-11' : 'text-fg-subtle',
                        )}>
                          {D.isZero(unpaid) ? '—' : formatAmount(D.toStr(unpaid, 2))}
                        </span>
                      ) : null}
                      <span className="flex min-w-0">
                        {cancelled
                          ? <Chip icon={Ban} tone="var(--status-expired)">Cancelled</Chip>
                          : <PaymentChip payment={paymentOf(row)} />}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <PanelFooter>
          <span>
            {status === 'ready' ? (
              <>
                <span className="num font-medium text-fg">{view.length}</span> receipt{view.length === 1 ? '' : 's'}
                {hasNextPage ? <span className="ml-2 text-fg-subtle">more on file</span> : null}
              </>
            ) : 'Purchase register'}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
          </span>
        </PanelFooter>
      </div>

      {selected ? (
        <PurchaseDetail
          doc={selected}
          onClose={() => onSelect(null)}
          onReturnAgainst={() => onReturnAgainst(selected.id, selected.supplierId)}
        />
      ) : null}
    </div>
  )
}

/** Payment state as an icon AND a word — never as a tint on the row alone. */
function PaymentChip({ payment }: { payment: Payment }) {
  if (payment === 'paid') return <Chip icon={CircleCheck} tone="var(--success-11)">Paid</Chip>
  if (payment === 'part') return <Chip icon={Wallet} tone="var(--warning-11)">Part paid</Chip>
  return <Chip icon={Wallet} tone="var(--fg-muted)">Unpaid</Chip>
}

/**
 * One received document, line by line.
 *
 * There is no edit affordance and there is not going to be one: the batches this
 * document created are already on shelves and on bills. The debit note is the
 * correction, so it is the button that is here instead.
 */
function PurchaseDetail({
  doc, onClose, onReturnAgainst,
}: {
  doc: PurchaseInvoice
  onClose: () => void
  onReturnAgainst: () => void
}) {
  const interState = !D.isZero(D.dec(doc.igst))
  const unpaid = unpaidOf(doc)
  const payment = paymentOf(doc)
  const moved = doc.lines.filter((l) => l.rateChangedFrom !== null).length

  return (
    <aside className="card flex w-[452px] shrink-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mono truncate text-lg font-semibold tracking-tight">{doc.purchaseNo}</div>
            <div className="mt-0.5 truncate text-xs text-fg-muted">
              {doc.supplierName} · their bill <span className="mono">{doc.supplierInvoiceNo}</span> · {doc.invoiceDate}
            </div>
            {/* Carries "Received against PO…" when the receipt answered an
                order, which is how "did that delivery ever come" is answered
                from the bill rather than from memory. */}
            {doc.notes ? (
              <div className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] bg-inset px-2 py-0.5 text-2xs text-fg-muted">
                <ClipboardCheck size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{doc.notes}</span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the receipt"
            className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="micro-label">Net on this bill</div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-base font-medium text-fg-muted" aria-hidden>₹</span>
              <span className="display-num text-3xl">{formatAmount(doc.netAmount)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            {doc.status === 'CANCELLED' ? (
              <Chip icon={Ban} tone="var(--status-expired)">Cancelled</Chip>
            ) : (
              <>
                <PaymentChip payment={payment} />
                <div className="num mt-1 text-xs text-fg-muted">
                  {D.isZero(unpaid)
                    ? 'settled in full'
                    : <>₹{formatAmount(D.toStr(unpaid, 2))} still owed</>}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="scroll-region min-h-0 flex-1">
        <div className="flex items-center justify-between border-b border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
          <span className="micro-label">
            {doc.lines.length} line{doc.lines.length === 1 ? '' : 's'} received
            {moved > 0 ? <span className="ml-1.5 text-warning-11">· {moved} at a new rate</span> : null}
          </span>
          <span className="micro-label">Amount ₹</span>
        </div>
        {doc.lines.map((l) => (
          /*
           * Two lines per receipt line, not eight columns.
           *
           * A 452px panel divided into columns leaves the brand name ~70px, and
           * the name is the one thing on this panel that cannot be worked out
           * from context — "Azithr…" answers nothing. Batch, expiry, packs and
           * landed cost are short, self-labelling and read perfectly well on a
           * second line underneath, so the name gets the width instead.
           */
          <div key={l.lineId} className="border-b border-border-subtle px-[var(--card-px)] py-2">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-base font-medium" title={l.brandName}>{l.brandName}</span>
              <span className="shrink-0 text-2xs text-fg-subtle">{l.packLabel}</span>
              <span className="num ml-auto shrink-0 text-base font-medium">{formatAmount(l.lineTotal)}</span>
            </div>
            <div className="mt-0.5 flex items-baseline gap-1.5 text-2xs text-fg-subtle">
              <span className="mono max-w-[92px] truncate" title={`Batch ${l.batchNo}`}>{l.batchNo}</span>
              <span aria-hidden>·</span>
              <span className="mono">exp {expiryLabel(l.expiry)}</span>
              <span aria-hidden>·</span>
              {/* Free packs are what make landed cost lower than the rate that
                  was charged, so the two sit next to each other. */}
              <span className="num">
                {formatQty(l.qtyPacks)}
                {D.gt(D.dec(l.freePacks), D.ZERO)
                  ? <span className="text-success-11"> +{formatQty(l.freePacks)} free</span>
                  : null}
                {' packs'}
              </span>
              <span className="num ml-auto shrink-0" title="Landed cost per base unit, over paid + free packs, freight included">
                landed ₹{l.landedCostPerUnit}/unit
              </span>
            </div>
            {/* The rate move, on the line it happened on. This is where "why is
                this line dearer than last time" gets answered without opening
                another bill. */}
            {l.rateChangedFrom !== null ? <RateDelta from={l.rateChangedFrom} to={l.ratePerPack} /> : null}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border-subtle px-[var(--card-px)] py-3">
        <Line label="Taxable" value={doc.taxableValue} muted />
        {interState
          ? <Line label="IGST" value={doc.igst} muted />
          : <><Line label="CGST" value={doc.cgst} muted /><Line label="SGST" value={doc.sgst} muted /></>}
        <Line label="Freight" value={doc.freight} muted />
        <Line label="Round off" value={doc.roundOff} muted />
        <Line label="Paid so far" value={doc.amountPaid} muted />
        <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-border-subtle pt-1.5">
          <span className="text-sm font-medium">Net</span>
          <span className="num text-lg font-semibold">₹{formatAmount(doc.netAmount)}</span>
        </div>

        {doc.status === 'POSTED' ? (
          <Button className="mt-3 w-full" onClick={onReturnAgainst}>
            <FileMinus2 /> Raise a debit note against this bill
          </Button>
        ) : null}
        <p className="mt-2 text-2xs leading-relaxed text-fg-subtle">
          A posted receipt is immutable. Correct it with a purchase return or a debit note, never by
          editing this document — the batches it created are already on shelves and on bills.
        </p>
      </div>
    </aside>
  )
}

/** How this line's rate compares with the last time it was bought. */
function RateDelta({ from, to }: { from: string; to: string }) {
  const before = D.dec(from)
  const now = D.dec(to)
  const up = D.gt(now, before)
  const pct = D.isZero(before)
    ? null
    : D.toStr(D.abs(D.div(D.mul(D.sub(now, before), D.HUNDRED), before)), 1)
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <div className={cn('mt-1 flex items-center gap-1 text-2xs', up ? 'text-danger-11' : 'text-success-11')}>
      <Icon size={11} aria-hidden />
      <span className="font-medium">{up ? 'Rate up' : 'Rate down'}</span>
      <span className="num">
        ₹{formatAmount(from)} → ₹{formatAmount(to)} a pack
        {pct === null ? null : <> · {formatPercent(pct)}</>}
      </span>
    </div>
  )
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex h-5 items-baseline justify-between gap-2 text-xs">
      <span className={cn('truncate', muted ? 'text-fg-muted' : 'text-fg')}>{label}</span>
      <span className={cn('num', muted && 'text-fg-muted')}>{formatAmount(value)}</span>
    </div>
  )
}
