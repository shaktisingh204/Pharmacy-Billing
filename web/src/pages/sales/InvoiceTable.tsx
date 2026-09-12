import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Ban, Banknote, CircleCheck, CreditCard, HandCoins, ReceiptText, RotateCcw, Search,
  Smartphone, Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaymentMode, SaleRegisterRow, SaleRowStatus } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Chip } from '@/components/ui/Badge'
import { Kbd } from '@/components/ui/Kbd'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'

/**
 * The invoice register.
 *
 * Nobody browses eight thousand bills. What brings a pharmacist here is one of
 * three questions — find THIS bill, what did the day take, and what came back —
 * so the grid is tuned for the first: newest first, one row per document, and
 * every column already on `SaleRegisterRow` so no cell can need a second call.
 *
 * There is deliberately no edit affordance on any row, and there is not going
 * to be one (invariant I20). A posted bill is corrected by a credit note or
 * cancelled with a reason; both are documents, and both live in the sheet.
 */

/** Matches --row-h at compact density. The virtualiser and the DOM must agree. */
const ROW_H = 36

export type TableStatus = 'ready' | 'loading' | 'error' | 'offline' | 'denied'

/** Constructed once: an Intl formatter per cell is measurable in a 150-row grid. */
const TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function clockTime(stamp: string): string {
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? '—' : TIME.format(t)
}

/**
 * Tender, as icon AND word — never as a colour alone.
 *
 * CREDIT is the only one that carries a tone, because it is the only one that
 * is not money in the drawer: a bill "paid" on credit is a receivable, and it
 * has to be distinguishable across a room from one that was settled.
 */
const MODE_META: Record<PaymentMode, { icon: LucideIcon; label: string; tone?: string }> = {
  CASH: { icon: Banknote, label: 'Cash' },
  UPI: { icon: Smartphone, label: 'UPI' },
  CARD: { icon: CreditCard, label: 'Card' },
  CREDIT: { icon: HandCoins, label: 'Credit', tone: 'var(--warning-11)' },
}

export function ModeChip({ mode }: { mode: PaymentMode }) {
  const meta = MODE_META[mode]
  return <Chip icon={meta.icon} {...(meta.tone ? { tone: meta.tone } : {})}>{meta.label}</Chip>
}

export function ModeChips({ modes }: { modes: readonly PaymentMode[] }) {
  if (modes.length === 0) return <span className="text-2xs text-fg-subtle">—</span>
  return (
    <span className="flex min-w-0 items-center gap-1">
      {modes.map((m) => <ModeChip key={m} mode={m} />)}
    </span>
  )
}

const STATUS_META: Record<SaleRowStatus, { icon: LucideIcon; label: string; tone?: string }> = {
  POSTED: { icon: CircleCheck, label: 'Posted', tone: 'var(--success-11)' },
  PART_RETURNED: { icon: Undo2, label: 'Part returned', tone: 'var(--status-expiry-60)' },
  RETURNED: { icon: RotateCcw, label: 'Returned', tone: 'var(--status-expiry-30)' },
  /* A cancelled bill stays in the register wearing this. It is not hidden and
     it is not renumbered — a document that vanishes is what an auditor reads
     as concealment, and the series still has to account for the number. */
  VOIDED: { icon: Ban, label: 'Voided', tone: 'var(--status-expired)' },
}

export function StatusChip({ status }: { status: SaleRowStatus }) {
  const meta = STATUS_META[status]
  return <Chip icon={meta.icon} {...(meta.tone ? { tone: meta.tone } : {})}>{meta.label}</Chip>
}

const WIDE = 'minmax(110px,0.85fr) 46px minmax(110px,1.3fr) 44px minmax(96px,0.7fr) 92px 118px'
const NARROW = 'minmax(104px,0.9fr) 46px minmax(96px,1.2fr) 88px 104px'

export function InvoiceTable({
  rows,
  total,
  status,
  errorMessage,
  errorCode,
  narrow,
  activeIndex,
  selectedId,
  filtered,
  emptyTitle,
  fetchingMore,
  onActiveIndexChange,
  onOpen,
  onEscape,
  onNeedMore,
  onRetry,
  onClearFilters,
  onNewBill,
  bodyRef,
}: {
  rows: SaleRegisterRow[]
  total: number
  status: TableStatus
  errorMessage?: string
  errorCode?: string
  /** True while the sheet is open: the grid sheds its secondary columns. */
  narrow: boolean
  activeIndex: number
  selectedId: number | null
  filtered: boolean
  /** A whole sentence, composed by the screen: only it knows the range. */
  emptyTitle: string
  fetchingMore: boolean
  onActiveIndexChange: (i: number) => void
  onOpen: (row: SaleRegisterRow) => void
  onEscape: () => void
  onNeedMore: () => void
  onRetry: () => void
  onClearFilters: () => void
  onNewBill: () => void
  bodyRef: React.RefObject<HTMLDivElement | null>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const template = narrow ? NARROW : WIDE

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 12,
  })

  const items = virtualizer.getVirtualItems()
  const lastRendered = items.at(-1)?.index ?? 0

  /* Page ahead while there is still a screenful below the fold, so the operator
     never arrives at the bottom and waits. */
  useEffect(() => {
    if (rows.length > 0 && lastRendered >= rows.length - 24) onNeedMore()
  }, [lastRendered, rows.length, onNeedMore])

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < rows.length) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, rows.length, virtualizer])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target)) return
    const last = rows.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'PageDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 12, last)) }
    else if (e.key === 'PageUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 12, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); onActiveIndexChange(0) }
    else if (e.key === 'End') { e.preventDefault(); onActiveIndexChange(Math.max(last, 0)) }
    else if (e.key === 'Enter') {
      const row = rows[activeIndex]
      if (row) { e.preventDefault(); onOpen(row) }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
    }
  }

  const activeRow = rows[activeIndex]

  /* The header is a ROW OF THE GRID, so it is rendered INSIDE the grid element
     rather than as a sibling above it. A row element outside the grid element
     is not a row at all: axe calls it critical, and what it means in practice is
     that a screen-reader user tabbing into this table hears a wall of numbers
     with no column names attached to any of them. */
  const headerRow = (
      <div
        role="row"
        className="sticky top-0 z-10 grid shrink-0 items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)]"
        style={{ gridTemplateColumns: template, height: 28 }}
      >
        <span role="columnheader" className="micro-label truncate">Invoice</span>
        <span role="columnheader" className="micro-label truncate">Time</span>
        <span role="columnheader" className="micro-label truncate">Customer</span>
        {/* "Lines", because the cell holds `lineCount`. Headed 'Items' it told
            the reader that a 2-line bill of 40 strips was 2 items, which is the
            same word the Bills tile uses for units dispensed and a different
            number. Naming the cell after what it counts is the whole fix. */}
        {!narrow ? <span role="columnheader" className="micro-label truncate text-right">Lines</span> : null}
        {!narrow ? <span role="columnheader" className="micro-label truncate">Paid by</span> : null}
        <span role="columnheader" className="micro-label truncate text-right">Net ₹</span>
        <span role="columnheader" className="micro-label truncate">Status</span>
      </div>
  )

  return (
    <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">

      {status === 'loading' ? (
        <SkeletonRows rows={14} cols={narrow ? 5 : 7} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="reports.sales" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered ? (
            <EmptyState
              icon={Search}
              title="No bill matches this view"
              body="Nothing in this range satisfies every filter above. Widen the dates, or drop a filter — a bill is never deleted, so if it was raised it is still here."
              actionLabel="Clear the filters"
              onAction={onClearFilters}
            />
          ) : (
            <EmptyState
              icon={ReceiptText}
              title={emptyTitle}
              body="Every sale posted at the counter lands here the moment it is saved, with its batches, its tax breakup and its payments."
              actionLabel="Go to billing"
              onAction={onNewBill}
            />
          )}
        </div>
      ) : (
        <div
          ref={(el) => {
            scrollRef.current = el
            bodyRef.current = el
          }}
          role="grid"
          tabIndex={0}
          aria-label="Invoice register"
          aria-rowcount={total + 1}
          aria-activedescendant={activeRow ? `invoice-row-${activeRow.id}` : undefined}
          onKeyDown={onKeyDown}
          data-focus-inset
          className="scroll-region min-h-0 flex-1"
        >
          {headerRow}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index]
              if (!row) return null
              const active = item.index === activeIndex
              const selected = row.id === selectedId
              const voided = row.status === 'VOIDED'
              return (
                <div
                  key={row.id}
                  id={`invoice-row-${row.id}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={selected}
                  onClick={() => { onActiveIndexChange(item.index); onOpen(row) }}
                  className={cn(
                    'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-border-subtle px-[var(--cell-px)]',
                    'transition-colors duration-[var(--dur-fast)]',
                    selected ? 'bg-accent-3' : active ? 'bg-accent-3/45' : 'hover:bg-hover',
                    voided && 'opacity-65',
                  )}
                  style={{
                    height: ROW_H,
                    transform: `translateY(${item.start}px)`,
                    gridTemplateColumns: template,
                  }}
                >
                  {/* Active row is a bar AND a tint — never a tint alone. */}
                  {(active || selected) && (
                    <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />
                  )}

                  {/* Every direct child of a row is a CELL. Bare spans left each
                      row empty as far as a screen reader was concerned — the
                      register read as ninety rows of nothing. */}
                  <span
                    role="gridcell"
                    className={cn('mono truncate text-sm text-fg', voided && 'line-through decoration-1')}
                    title={row.invoiceNo}
                  >
                    {row.invoiceNo}
                  </span>
                  <span role="gridcell" className="num text-sm text-fg-muted">{clockTime(row.createdAt)}</span>
                  <span role="gridcell" className="flex min-w-0 items-baseline gap-1.5">
                    {row.customerName ? (
                      <span className="truncate text-base text-fg" title={row.customerPhone ?? undefined}>
                        {row.customerName}
                      </span>
                    ) : (
                      /* Most counter sales are anonymous. Saying so plainly beats
                         an empty cell that reads as missing data. */
                      <span className="truncate text-base text-fg-subtle">Walk-in</span>
                    )}
                  </span>
                  {!narrow ? <span role="gridcell" className="num text-sm text-fg-muted">{row.lineCount}</span> : null}
                  {!narrow ? <span role="gridcell"><ModeChips modes={row.modes} /></span> : null}
                  <span role="gridcell" className="num text-base font-medium text-fg">{formatAmount(row.netAmount)}</span>
                  <span role="gridcell" className="flex min-w-0 items-center gap-1">
                    <StatusChip status={row.status} />
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-3 text-2xs text-fg-muted">
        <span>
          {status === 'ready' ? (
            <>
              <span className="num font-medium text-fg">{rows.length}</span>
              {rows.length < total ? <> of <span className="num">{total}</span></> : null}
              {' '}bill{total === 1 ? '' : 's'}
              {fetchingMore ? <span className="ml-2 text-fg-subtle">loading more…</span> : null}
            </>
          ) : (
            'Invoice register'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>/</Kbd> find</span>
        </span>
      </div>
    </div>
  )
}
