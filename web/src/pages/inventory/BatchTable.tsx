import { createContext, useContext, useEffect, useRef } from 'react'
import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Ban, Boxes, CircleCheck, CircleSlash, MapPin, PackageSearch, ShieldOff, Truck,
} from 'lucide-react'
import type { BatchRow, InventoryFilters, IsoDate } from '@contract'
import { isExpired, isSellable } from '@/domain/fefo'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Chip, ExpiryChip } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'

/**
 * The batch grid. A BATCH is the stock-keeping unit, not a product — the same
 * strip arrives at two MRPs and two expiries and those are two rows, because a
 * customer pays what is printed on the pack in their hand.
 *
 * Same two rules as the catalogue grid, for the same reasons: no cell may need a
 * second call (everything here is already on `BatchRow`), and the previous page
 * stays on screen while the next resolves.
 *
 * Nothing below re-derives an expiry band or a sellability rule. `bucket` and
 * `daysToExpiry` come from the server on the row, and `isSellable` is the same
 * predicate FEFO allocates with — so the Status column says exactly what the
 * allocator will do, rather than a second opinion about it.
 */

/** Matches `--row-h` at compact density; virtual rows are absolutely positioned. */
const ROW_H = 36

export type TableStatus = 'ready' | 'loading' | 'error' | 'offline' | 'denied'

/** Taken from the contract so the header buttons cannot drift from the API. */
export type SortKey = NonNullable<InventoryFilters['sort']>

interface ColMeta {
  head: string
  width: string
  align?: 'right'
  sort?: SortKey
}

const features = tableFeatures({
  columnVisibilityFeature,
  columnMeta: {} as ColMeta,
})

const helper = createColumnHelper<typeof features, BatchRow>()

interface GridHandlers {
  todayIso: IsoDate
  selected: ReadonlySet<number>
  onToggle: (row: BatchRow, index: number, range: boolean) => void
}

const GridContext = createContext<GridHandlers | null>(null)

function useGrid(): GridHandlers {
  const ctx = useContext(GridContext)
  if (!ctx) throw new Error('BatchTable cell rendered outside the grid')
  return ctx
}

const DECIMALISH = /^-?\d+(\.\d+)?$/

/** "142 TAB · 14.2 × 10x15" — the pharmacist counts strips, the ledger counts units. */
function packHint(row: BatchRow): string {
  const qty = row.batch.qtyOnHand.trim()
  const per = row.medicine.unitsPerPack
  const base = `${formatQty(qty)} ${row.medicine.baseUom}`
  if (!DECIMALISH.test(qty) || !Number.isFinite(per) || per <= 0) return base
  const packs = D.div(D.dec(qty), D.dec(String(per)))
  return `${base} · ${D.toStr(packs, 2)} × ${row.medicine.packLabel}`
}

// ----------------------------------------------------------------- columns ---

const columns = helper.columns([
  /* Selection first, and never hidden by the narrow layout: a recall names a
     manufacturer and a date range rather than a batch, and pulling that shelf
     one row at a time is the difference between two minutes and forty. */
  helper.display({
    id: 'select',
    header: 'Select',
    meta: { head: '', width: '30px' },
    cell: (info) => <SelectCell row={info.row.original} index={info.row.index} />,
  }),
  helper.accessor((r) => r.medicine.brandName, {
    id: 'name',
    header: 'Medicine',
    meta: { head: 'Medicine', width: 'minmax(140px, 2.2fr)', sort: 'name' },
    cell: (info) => {
      const m = info.row.original.medicine
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-fg">{m.brandName}</span>
          {m.strengthText ? <span className="shrink-0 text-2xs text-fg-muted">{m.strengthText}</span> : null}
          <span className="shrink-0 text-2xs text-fg-subtle">{m.packLabel}</span>
        </span>
      )
    },
  }),
  helper.accessor((r) => r.batch.batchNo, {
    id: 'batchNo',
    header: 'Batch',
    meta: { head: 'Batch no', width: 'minmax(88px, 0.9fr)' },
    cell: (info) => (
      <span className="mono truncate text-xs text-fg" title={info.row.original.batch.batchNo}>
        {info.row.original.batch.batchNo}
      </span>
    ),
  }),
  helper.accessor((r) => r.batch.expiryDate, {
    id: 'expiry',
    header: 'Expiry',
    meta: { head: 'Expiry', width: '88px', sort: 'expiry' },
    /* The printed expiry is a MONTH. Rendering 30-11-2027 for "11/27" invites the
       operator to check it against the strip and find a mismatch that isn't one. */
    cell: (info) => (
      <ExpiryChip bucket={info.row.original.bucket} label={formatExpiry(info.row.original.batch.expiryDate)} />
    ),
  }),
  helper.accessor((r) => r.daysToExpiry, {
    id: 'days',
    header: 'Days left',
    meta: { head: 'Days', width: '56px', align: 'right' },
    cell: (info) => {
      const d = info.row.original.daysToExpiry
      return (
        <span className={cn('num text-xs', d < 0 ? 'text-danger-11' : 'text-fg-muted')}>
          {d < 0 ? `${d}` : `+${d}`}
        </span>
      )
    },
  }),
  helper.accessor((r) => r.batch.qtyOnHand, {
    id: 'qty',
    header: 'On hand',
    meta: { head: 'On hand', width: '90px', align: 'right', sort: 'qty' },
    /* Deliberately NOT a StockChip. `reorderLevel` is an item-level trigger; one
       batch holding less than it is normal and means nothing on its own. */
    cell: (info) => {
      const row = info.row.original
      return (
        <span className="flex min-w-0 items-baseline justify-end gap-1" title={packHint(row)}>
          <span className="num text-fg">{formatQty(row.batch.qtyOnHand)}</span>
          <span className="shrink-0 text-2xs text-fg-subtle">{row.medicine.baseUom}</span>
        </span>
      )
    },
  }),
  helper.accessor((r) => r.batch.mrpPerPack, {
    id: 'mrp',
    header: 'MRP per pack',
    meta: { head: 'MRP/pack ₹', width: '78px', align: 'right' },
    cell: (info) => <span className="num text-fg">{formatAmount(info.row.original.batch.mrpPerPack)}</span>,
  }),
  helper.accessor((r) => r.valueAtCost, {
    id: 'value',
    header: 'Value at cost',
    meta: { head: 'At cost ₹', width: '86px', align: 'right', sort: 'value' },
    /* Cost, not MRP. A return claim, a write-off and a shrinkage figure are all
       settled at what the shelf cost; MRP is what it would have fetched. */
    cell: (info) => (
      <span
        className="num font-medium text-fg"
        title={`At MRP ${formatMoney(info.row.original.valueAtMrp)}`}
      >
        {formatAmount(info.row.original.valueAtCost)}
      </span>
    ),
  }),
  helper.accessor((r) => r.medicine.rackLocation ?? '', {
    id: 'rack',
    header: 'Rack',
    meta: { head: 'Rack', width: '66px' },
    /* Read-only here. Rack is an ITEM attribute in every product examined, so it
       is edited once in the master rather than per batch — a rack edited on one
       batch row and not its sibling is a shelf nobody can find. */
    cell: (info) => {
      const rack = info.row.original.medicine.rackLocation
      return (
        <span
          className="flex min-w-0 items-center gap-1"
          title={rack ? `Shelf ${rack} — set in Medicines` : 'No rack set — set it in Medicines'}
        >
          <MapPin size={11} aria-hidden className={cn('shrink-0', rack ? 'text-fg-subtle' : 'text-fg-disabled')} />
          <span className={cn('mono truncate text-xs', rack ? 'text-fg-muted' : 'text-fg-disabled')}>
            {rack ?? '—'}
          </span>
        </span>
      )
    },
  }),
  helper.display({
    id: 'status',
    header: 'Status',
    meta: { head: 'Status', width: '104px' },
    cell: (info) => <StatusCell row={info.row.original} />,
  }),
])

/** What survives when the ledger sheet takes 400px. Identity, how much, when it
 *  dies, and whether it can be sold — everything dropped is in the sheet. */
const NARROW_HIDDEN = ['days', 'mrp', 'rack'] as const

const NARROW_VISIBILITY: Record<string, boolean> =
  Object.fromEntries(NARROW_HIDDEN.map((id) => [id, false]))

const WIDE_VISIBILITY: Record<string, boolean> = {}

// ------------------------------------------------------------------- cells ---

function SelectCell({ row, index }: { row: BatchRow; index: number }) {
  const { selected, onToggle } = useGrid()
  const on = selected.has(row.batch.id)
  return (
    <input
      type="checkbox"
      checked={on}
      /* The row itself opens the ledger sheet, so the tick must not. */
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onToggle(row, index, (e.nativeEvent as MouseEvent).shiftKey === true)}
      aria-label={`Select ${row.medicine.brandName} batch ${row.batch.batchNo}`}
      className="size-3.5 accent-[var(--accent-9)]"
    />
  )
}

/**
 * Allocation eligibility, not a second opinion about expiry.
 *
 * `isSellable` is the exact predicate FEFO filters on, so this column answers
 * "will the till reach this stock?". The branches below only explain the answer.
 */
function StatusCell({ row }: { row: BatchRow }) {
  const { todayIso } = useGrid()
  const b = row.batch
  if (isSellable(b, todayIso)) {
    return <Chip icon={CircleCheck} tone="var(--success-11)">Sellable</Chip>
  }
  if (b.isQuarantined) {
    return <Chip icon={ShieldOff} tone="var(--status-quarantine)">Quarantined</Chip>
  }
  if (isExpired(b, todayIso)) {
    return <Chip icon={Ban} tone="var(--status-expired)">Expired</Chip>
  }
  return <Chip icon={CircleSlash} tone="var(--status-out-of-stock)">Empty</Chip>
}

// ------------------------------------------------------------------- table ---

export function BatchTable({
  rows,
  total,
  status,
  errorMessage,
  errorCode,
  narrow,
  todayIso,
  activeIndex,
  selectedBatchId,
  sort,
  filtered,
  fetchingMore,
  selected,
  onToggleSelect,
  onSelectLoaded,
  onActiveIndexChange,
  onOpen,
  onEscape,
  onSortChange,
  onAdjust,
  onQuarantine,
  onNeedMore,
  onRetry,
  onClearFilters,
  onGoToPurchases,
  bodyRef,
  footer,
}: {
  rows: BatchRow[]
  total: number
  status: TableStatus
  errorMessage?: string
  errorCode?: string
  /** True while the ledger sheet is open: the grid sheds its secondary columns. */
  narrow: boolean
  todayIso: IsoDate
  activeIndex: number
  selectedBatchId: number | null
  sort: SortKey
  filtered: boolean
  fetchingMore: boolean
  /** Batch ids ticked for a bulk action. */
  selected: ReadonlySet<number>
  /** `range` extends from the last tick, which is what Shift-click means here. */
  onToggleSelect: (row: BatchRow, index: number, range: boolean) => void
  /** Tick or untick everything currently loaded — never the unloaded remainder. */
  onSelectLoaded: (rows: BatchRow[], on: boolean) => void
  onActiveIndexChange: (i: number) => void
  onOpen: (row: BatchRow) => void
  onEscape: () => void
  onSortChange: (s: SortKey) => void
  onAdjust: (row: BatchRow) => void
  onQuarantine: (row: BatchRow) => void
  onNeedMore: () => void
  onRetry: () => void
  onClearFilters: () => void
  onGoToPurchases: () => void
  bodyRef: React.RefObject<HTMLDivElement | null>
  /** The bulk bar, pinned between the rows and the status line. */
  footer?: React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const columnVisibility = narrow ? NARROW_VISIBILITY : WIDE_VISIBILITY

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => String(row.batch.id),
    state: { columnVisibility },
  })

  const template = table.getVisibleFlatColumns().map((c) => c.columnDef.meta?.width ?? '1fr').join(' ')

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => rows[index]?.batch.id ?? index,
    overscan: 12,
  })

  const items = virtualizer.getVirtualItems()
  const lastRendered = items.at(-1)?.index ?? 0

  /* Fetch while a screenful still sits below the fold, so the operator never
     arrives at the bottom and waits. */
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
    const row = rows[activeIndex]

    if (e.key === 'ArrowDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'PageDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 12, last)) }
    else if (e.key === 'PageUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 12, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); onActiveIndexChange(0) }
    else if (e.key === 'End') { e.preventDefault(); onActiveIndexChange(Math.max(last, 0)) }
    else if (e.key === 'Enter') { if (row) { e.preventDefault(); onOpen(row) } }
    /* Space ticks the row under the cursor. It is the one selection gesture a
       keyboard operator can reach without leaving the grid, and it is what every
       file manager has trained the hand to expect. */
    else if (e.key === ' ') { if (row) { e.preventDefault(); onToggleSelect(row, activeIndex, e.shiftKey) } }
    else if (e.key.toLowerCase() === 'a') { if (row) { e.preventDefault(); onAdjust(row) } }
    else if (e.key.toLowerCase() === 'q') { if (row) { e.preventDefault(); onQuarantine(row) } }
    else if (e.key === 'Escape') { e.preventDefault(); onEscape() }
  }

  const headers = table.getHeaderGroups().at(0)?.headers ?? []
  const modelRows = table.getRowModel().rows
  const activeRow = rows[activeIndex]
  const grid: GridHandlers = { todayIso, selected, onToggle: onToggleSelect }
  const selectedLoaded = rows.reduce((n, r) => (selected.has(r.batch.id) ? n + 1 : n), 0)
  const allLoadedSelected = rows.length > 0 && selectedLoaded === rows.length
  const someLoadedSelected = selectedLoaded > 0

  /* The header is a ROW OF THE GRID, so it is rendered INSIDE the grid element
     rather than as a sibling above it. A row element outside the grid element
     is not a row at all: axe calls it critical, and what it means in practice is
     that a screen-reader user tabbing into this table hears a wall of numbers
     with no column names attached to any of them. */
  const headerRow = (
      <div
        role="row"
        className="sticky top-0 z-10 grid shrink-0 items-center gap-1.5 border-b border-border-subtle bg-subtle px-[var(--cell-px)]"
        style={{ gridTemplateColumns: template, height: 28 }}
      >
        {headers.map((header) => {
          const meta = header.column.columnDef.meta
          const key = meta?.sort
          const on = key !== undefined && key === sort
          return (
            <div
              key={header.id}
              role="columnheader"
              aria-sort={on ? 'other' : undefined}
              className={cn('min-w-0', meta?.align === 'right' && 'text-right')}
            >
              {header.column.id === 'select' ? (
                <input
                  type="checkbox"
                  checked={allLoadedSelected}
                  ref={(el) => { if (el) el.indeterminate = someLoadedSelected && !allLoadedSelected }}
                  onChange={() => onSelectLoaded(rows, !allLoadedSelected)}
                  /* "Loaded", not "matching": the grid pages, and a tick that
                     silently claimed nine hundred unseen batches is how a bulk
                     quarantine goes wrong. */
                  aria-label={`Select all ${rows.length} loaded batches`}
                  title={`Select all ${rows.length} loaded batches`}
                  className="size-3.5 accent-[var(--accent-9)]"
                />
              ) : key === undefined ? (
                <span className="micro-label block truncate">{meta?.head}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSortChange(key)}
                  title={`Sort by ${meta?.head ?? ''}`}
                  className={cn(
                    'micro-label max-w-full truncate rounded-[var(--radius-sm)] px-1 py-0.5 hover:bg-hover hover:text-fg',
                    on && 'text-accent-11',
                  )}
                >
                  {meta?.head}
                  {on ? <span aria-hidden className="ml-1">▾</span> : null}
                </button>
              )}
            </div>
          )
        })}
      </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {status === 'loading' ? (
        <SkeletonRows rows={14} cols={narrow ? 7 : 10} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="inventory.view" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : rows.length === 0 ? (
        <Empty filtered={filtered} onClearFilters={onClearFilters} onGoToPurchases={onGoToPurchases} />
      ) : (
        <GridContext.Provider value={grid}>
          <div
            ref={(el) => {
              scrollRef.current = el
              bodyRef.current = el
            }}
            role="grid"
            tabIndex={0}
            aria-label="Batches on hand"
            aria-rowcount={total + 1}
            aria-activedescendant={activeRow ? `batch-row-${activeRow.batch.id}` : undefined}
            onKeyDown={onKeyDown}
            data-focus-inset
            className="scroll-region min-h-0 flex-1"
          >
            {headerRow}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((item) => {
                const row = modelRows[item.index]
                if (!row) return null
                const data = row.original
                const active = item.index === activeIndex
                const open = data.batch.id === selectedBatchId
                const ticked = selected.has(data.batch.id)
                const blocked = data.batch.isQuarantined || data.bucket === 'expired'
                return (
                  <div
                    key={row.id}
                    id={`batch-row-${data.batch.id}`}
                    role="row"
                    aria-rowindex={item.index + 2}
                    /* Selection means the TICK, which is what a bulk action will
                       act on. The open batch is a different idea and gets
                       `aria-current` instead of borrowing this one. */
                    aria-selected={ticked}
                    aria-current={open ? 'true' : undefined}
                    data-index={item.index}
                    onClick={() => { onActiveIndexChange(item.index); onOpen(data) }}
                    className={cn(
                      'absolute inset-x-0 top-0 grid cursor-default items-center gap-1.5 border-b border-border-subtle px-[var(--cell-px)]',
                      'transition-colors duration-[var(--dur-fast)]',
                      ticked ? 'bg-accent-2' : open ? 'bg-accent-3' : active ? 'bg-accent-3/45' : 'hover:bg-hover',
                      /* Dimmed, never hidden. Blocked stock is still stock, and it
                         is the stock somebody has to make a decision about. */
                      /* A tint, never `opacity`. Fading the whole row takes its
                         text down with it — a blocked batch was rendering its
                         strength, pack and rack at 2.3-2.8:1, so the rows a
                         pharmacist most needs to read were the least readable
                         on the page. The row still reads as set aside. */
                      blocked && 'bg-inset',
                    )}
                    style={{
                      height: ROW_H,
                      transform: `translateY(${item.start}px)`,
                      gridTemplateColumns: template,
                    }}
                  >
                    {/* Active row is a bar AND a tint — never a tint alone. */}
                    {(active || open || ticked) && (
                      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />
                    )}
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        role="gridcell"
                        className={cn(
                          'flex min-w-0 items-center text-base',
                          cell.column.columnDef.meta?.align === 'right' && 'justify-end',
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </GridContext.Provider>
      )}

      {footer}

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-muted">
        <span>
          {status === 'ready' ? (
            <>
              <span className="num font-medium text-fg">{rows.length}</span>
              {rows.length < total ? <> of <span className="num">{total}</span></> : null} batch{total === 1 ? '' : 'es'}
              {fetchingMore ? <span className="ml-2 text-fg-subtle">loading more…</span> : null}
            </>
          ) : (
            'Batches'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> ledger</span>
          <span className="flex items-center gap-1"><Kbd>Space</Kbd> select</span>
          <span className="flex items-center gap-1"><Kbd>A</Kbd> adjust</span>
          <span className="flex items-center gap-1"><Kbd>Q</Kbd> quarantine</span>
          <span className="flex items-center gap-1"><Kbd>/</Kbd> search</span>
        </span>
      </div>
    </div>
  )
}

function Empty({
  filtered, onClearFilters, onGoToPurchases,
}: {
  filtered: boolean
  onClearFilters: () => void
  onGoToPurchases: () => void
}) {
  /* An empty stock screen is almost never "add a batch". Stock is born on a goods
     receipt, which carries the batch, expiry, MRP and rate together — keying a
     batch by hand here would create stock with no document behind it, which is
     exactly the row a stock audit cannot explain. */
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {filtered ? (
        <EmptyState
          icon={PackageSearch}
          title="No batch matches this view"
          body={
            <>
              Nothing on hand satisfies every filter above. Drop one of them — an empty
              expiry bucket is good news, not a missing screen.
              <span className="mt-2 flex justify-center">
                <Button variant="ghost" onClick={onGoToPurchases}><Truck /> Go to Purchases</Button>
              </span>
            </>
          }
          actionLabel="Clear all filters"
          onAction={onClearFilters}
        />
      ) : (
        <EmptyState
          icon={Boxes}
          title="Nothing in stock"
          body="Batches are created by a goods receipt — the supplier invoice carries the batch number, expiry, MRP and rate that a batch needs to exist at all."
          actionLabel="Record a goods receipt"
          onAction={onGoToPurchases}
        />
      )}
    </div>
  )
}
