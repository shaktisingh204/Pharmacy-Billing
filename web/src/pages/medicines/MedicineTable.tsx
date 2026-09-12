import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckSquare, MapPin, PackageSearch, Pill, Truck } from 'lucide-react'
import type { MedicineRow } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry } from '@/lib/format'
import { expiryBucket } from '@/lib/expiry'
import { isTypingTarget } from '@/lib/keys'
import { Chip, ExpiryChip, ScheduleChip, StockChip } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'
import type { SortKey } from './MedicineFilters'

/**
 * The catalogue grid.
 *
 * Two rules keep it fast, and both come from the same place — every column here
 * is already on `MedicineRow`, which `listMedicines` returns joined to its stock:
 *
 *  - No cell may need a second call. Anything that does belongs in the drawer.
 *  - The previous page's rows stay on screen while the next resolves. Dropping
 *    to a skeleton on every keystroke is the most common way a grid that IS fast
 *    manages to FEEL slow.
 *
 * Rack is a first-class column and is editable in place. Marg puts it fifth in
 * the item master, ahead of everything but identity, because "which shelf" is
 * the question the counter actually asks — and it is per-store operational
 * metadata that no historical document references, so it is safe to edit inline.
 * Anything that moves money, tax or pack arithmetic is form-only.
 */

/** Matches `--row-h` at compact density. Virtual rows are absolutely positioned,
 *  so their height has to be a number the virtualiser and the DOM agree on. */
const ROW_H = 36

export type TableStatus = 'ready' | 'loading' | 'error' | 'offline' | 'denied'

interface ColMeta {
  head: string
  width: string
  align?: 'right'
  /** Set when this header can drive the server-side sort. */
  sort?: SortKey
}

const features = tableFeatures({
  columnVisibilityFeature,
  columnMeta: {} as ColMeta,
})

const helper = createColumnHelper<typeof features, MedicineRow>()

/* Interactive cells reach their handlers through context rather than through
   `table.options.meta`: the meta slot is optional on the table type, so every
   cell would have to narrow it before it could call anything. */
interface GridHandlers {
  today: Date
  editingId: number | null
  draft: string
  savingId: number | null
  setDraft: (v: string) => void
  startEdit: (id: number, current: string) => void
  cancelEdit: () => void
  commitEdit: () => void
  selectedIds: ReadonlySet<number>
  /** `range` extends from the last row touched — a shift-click over a shelf. */
  toggleRow: (index: number, range: boolean) => void
}

const GridContext = createContext<GridHandlers | null>(null)

function useGrid(): GridHandlers {
  const ctx = useContext(GridContext)
  if (!ctx) throw new Error('MedicineTable cell rendered outside the grid')
  return ctx
}

const DECIMALISH = /^-?\d+(\.\d+)?$/

/**
 * A weighted average, and labelled as one.
 *
 * `MedicineRow` carries no master MRP — only the value of the stock at the MRP
 * each batch was received at. Two batches of the same strip legitimately carry
 * two printed MRPs, so there is no single number to show; dividing the value by
 * the quantity is the honest summary, and it is '—' when there is no stock to
 * average over rather than a confident zero.
 */
function avgMrpPerUnit(row: MedicineRow): string | null {
  if (!DECIMALISH.test(row.stockQty) || !DECIMALISH.test(row.valueAtMrp)) return null
  const qty = D.dec(row.stockQty)
  if (D.isZero(qty) || D.isNeg(qty)) return null
  return D.toStr(D.div(D.dec(row.valueAtMrp), qty), 2)
}

// ----------------------------------------------------------------- columns ---

const columns = helper.columns([
  helper.display({
    id: 'select',
    header: 'Select',
    meta: { head: '', width: '26px' },
    cell: (info) => <SelectCell row={info.row.original} index={info.row.index} />,
  }),
  helper.accessor((r) => r.medicine.brandName, {
    id: 'name',
    header: 'Medicine',
    meta: { head: 'Medicine', width: 'minmax(132px, 2.2fr)', sort: 'name' },
    cell: (info) => {
      const m = info.row.original.medicine
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-fg">{m.brandName}</span>
          {m.strengthText ? <span className="shrink-0 text-2xs text-fg-muted">{m.strengthText}</span> : null}
          <span className="shrink-0 text-2xs text-fg-subtle">{m.packLabel}</span>
          {!m.isActive ? <Chip>Inactive</Chip> : null}
        </span>
      )
    },
  }),
  helper.accessor((r) => r.medicine.compositionText, {
    id: 'composition',
    header: 'Composition',
    meta: { head: 'Composition', width: 'minmax(104px, 1.2fr)' },
    /* The substitution key, so it is visible in the grid and not buried in the
       drawer. Truncated with the full salt on hover — combination products run
       to sixty characters and no column can hold them. */
    cell: (info) => (
      <span className="truncate text-fg-muted" title={info.row.original.medicine.compositionText}>
        {info.row.original.medicine.compositionText || '—'}
      </span>
    ),
  }),
  helper.accessor((r) => r.medicine.manufacturer, {
    id: 'manufacturer',
    header: 'Manufacturer',
    meta: { head: 'Mfr', width: 'minmax(80px, 0.7fr)' },
    cell: (info) => (
      <span className="truncate text-fg-muted" title={info.row.original.medicine.manufacturer}>
        {info.row.original.medicine.manufacturer}
      </span>
    ),
  }),
  helper.accessor((r) => r.medicine.drugSchedule, {
    id: 'schedule',
    header: 'Sch',
    meta: { head: 'Sch', width: '46px' },
    cell: (info) => <ScheduleChip code={info.row.original.medicine.drugSchedule} />,
  }),
  helper.accessor((r) => r.medicine.hsnCode, {
    id: 'hsn',
    header: 'HSN',
    meta: { head: 'HSN', width: '62px' },
    cell: (info) => <span className="mono text-xs text-fg-muted">{info.row.original.medicine.hsnCode || '—'}</span>,
  }),
  helper.accessor((r) => r.stockQty, {
    id: 'stock',
    header: 'Stock',
    meta: { head: 'Stock', width: '116px', sort: 'stock' },
    cell: (info) => {
      const r = info.row.original
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <StockChip qty={Number(r.stockQty)} reorderLevel={r.medicine.reorderLevel} />
          {r.batchCount > 1 ? (
            <span className="shrink-0 text-2xs text-fg-subtle" title={`${r.batchCount} live batches`}>
              ×{r.batchCount}
            </span>
          ) : null}
        </span>
      )
    },
  }),
  helper.accessor((r) => r.nearestExpiry, {
    id: 'expiry',
    header: 'Nearest expiry',
    meta: { head: 'Expiry', width: '88px' },
    cell: (info) => <ExpiryCell iso={info.row.original.nearestExpiry} />,
  }),
  helper.accessor((r) => r.valueAtMrp, {
    id: 'mrp',
    header: 'MRP/unit',
    meta: { head: 'MRP/unit ₹', width: '74px', align: 'right' },
    cell: (info) => {
      const avg = avgMrpPerUnit(info.row.original)
      return avg === null
        ? <span className="num text-fg-subtle">—</span>
        : <span className="num text-fg">{formatAmount(avg)}</span>
    },
  }),
  helper.accessor((r) => r.valueAtMrp, {
    id: 'value',
    header: 'Value',
    meta: { head: 'Value ₹', width: '84px', align: 'right', sort: 'value' },
    cell: (info) => <span className="num font-medium text-fg">{formatAmount(info.row.original.valueAtMrp)}</span>,
  }),
  helper.display({
    id: 'rack',
    header: 'Rack',
    meta: { head: 'Rack', width: '80px' },
    cell: (info) => <RackCell row={info.row.original} />,
  }),
])

/**
 * What survives when the drawer takes 380px of the width.
 *
 * Identity, how much is left, when it dies, and where it sits — nothing else
 * fits at the 1366x768 floor, and every column dropped here is on screen in the
 * drawer that caused the squeeze. The name column is the one that must never be
 * the thing that gets squeezed.
 */
const NARROW_HIDDEN = ['composition', 'manufacturer', 'hsn', 'mrp', 'value'] as const

const NARROW_VISIBILITY: Record<string, boolean> =
  Object.fromEntries(NARROW_HIDDEN.map((id) => [id, false]))

const WIDE_VISIBILITY: Record<string, boolean> = {}

// ------------------------------------------------------------------- cells ---

/**
 * The NATIVE control, tinted.
 *
 * A hand-drawn box would have to reimplement the indeterminate state, the focus
 * ring and the platform's own hit target, and it would lose the one thing a
 * checkbox has to keep: screen readers and keyboards already know what this is.
 * `accent-color` is the whole of the styling that was needed.
 */
const CHECKBOX = 'size-[15px] shrink-0 cursor-pointer accent-[var(--accent-9)]'

/**
 * Ticks every row the grid has actually LOADED, and says so.
 *
 * Never "all 1,595 items". The grid is virtual and paged; a box that claimed to
 * select rows the client has not seen would hand a bulk write a set nobody has
 * looked at, and the operator would find out what was in it afterwards.
 */
function SelectAll({
  rows, selectedIds, onSelectionChange,
}: {
  rows: MedicineRow[]
  selectedIds: ReadonlySet<number>
  onSelectionChange: (next: Set<number>) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const loaded = rows.filter((r) => selectedIds.has(r.medicine.id)).length
  const all = rows.length > 0 && loaded === rows.length

  // `indeterminate` is a DOM property with no attribute, so React cannot set it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = loaded > 0 && !all
  }, [loaded, all])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      aria-label={all ? 'Clear the selection' : `Select all ${rows.length} loaded rows`}
      title={all ? 'Clear the selection' : `Select the ${rows.length} rows loaded so far`}
      onChange={() => {
        if (loaded > 0) {
          onSelectionChange(new Set())
          return
        }
        onSelectionChange(new Set(rows.map((r) => r.medicine.id)))
      }}
      className={CHECKBOX}
    />
  )
}

function SelectCell({ row, index }: { row: MedicineRow; index: number }) {
  const grid = useGrid()
  return (
    <input
      type="checkbox"
      checked={grid.selectedIds.has(row.medicine.id)}
      aria-label={`Select ${row.medicine.brandName} ${row.medicine.packLabel}`}
      /* The row opens the drawer on click, and this box is inside the row. */
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const native = e.nativeEvent as MouseEvent
        grid.toggleRow(index, native.shiftKey === true)
      }}
      className={CHECKBOX}
    />
  )
}

function ExpiryCell({ iso }: { iso: string | null }) {
  const { today } = useGrid()
  if (iso === null) return <span className="text-2xs text-fg-subtle">No stock</span>
  return <ExpiryChip bucket={expiryBucket(iso, today)} label={formatExpiry(iso)} />
}

function RackCell({ row }: { row: MedicineRow }) {
  const grid = useGrid()
  const id = row.medicine.id
  const rack = row.medicine.rackLocation
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (grid.editingId !== id) return
    /* focus() as well as select(): the keyboard is on the grid when F2 opens
       this, and an editor that is not focused takes no keystrokes and never
       fires the blur that commits it. */
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [grid.editingId, id])

  if (grid.editingId === id) {
    return (
      <input
        ref={inputRef}
        value={grid.draft}
        onChange={(e) => grid.setDraft(e.target.value)}
        /* The row opens the drawer on click, and this input is inside the row. */
        onClick={(e) => e.stopPropagation()}
        onBlur={grid.commitEdit}
        onKeyDown={(e) => {
          /* The grid owns Enter and Escape everywhere else on this screen, so the
             editor has to stop them here or committing a rack also opens a drawer. */
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); grid.commitEdit() }
          if (e.key === 'Escape') { e.preventDefault(); grid.cancelEdit() }
        }}
        aria-label={`Rack for ${row.medicine.brandName}`}
        maxLength={16}
        autoComplete="off"
        spellCheck={false}
        className="mono h-6 w-full rounded-[var(--radius-sm)] border border-accent-9 bg-surface px-1.5 text-xs"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); grid.startEdit(id, rack ?? '') }}
      title="Set the rack or bin for this item"
      className={cn(
        'group/rack flex h-6 w-full items-center gap-1 rounded-[var(--radius-sm)] px-1 text-left',
        'hover:bg-inset',
        grid.savingId === id && 'opacity-50',
      )}
    >
      <MapPin size={11} aria-hidden className={cn('shrink-0', rack ? 'text-fg-subtle' : 'text-fg-disabled')} />
      <span className={cn('mono truncate text-xs', rack ? 'text-fg' : 'text-fg-disabled')}>
        {rack ?? 'Unset'}
      </span>
    </button>
  )
}

// ------------------------------------------------------------------- table ---

export function MedicineTable({
  rows,
  total,
  status,
  errorMessage,
  errorCode,
  narrow,
  today,
  activeIndex,
  selectedId,
  sort,
  filtered,
  fetchingMore,
  selectedIds,
  onSelectionChange,
  onActiveIndexChange,
  onOpen,
  onEscape,
  onSortChange,
  onRackSave,
  onNeedMore,
  onRetry,
  onClearFilters,
  onCreate,
  onGoToPurchases,
  bodyRef,
}: {
  rows: MedicineRow[]
  total: number
  status: TableStatus
  errorMessage?: string
  errorCode?: string
  /** True while the drawer is open: the grid sheds its secondary columns. */
  narrow: boolean
  today: Date
  activeIndex: number
  selectedId: number | null
  sort: SortKey
  filtered: boolean
  fetchingMore: boolean
  /** Ids ticked for a bulk edit. Owned by the screen, which does the writing. */
  selectedIds: ReadonlySet<number>
  onSelectionChange: (next: Set<number>) => void
  onActiveIndexChange: (i: number) => void
  onOpen: (row: MedicineRow) => void
  onEscape: () => void
  onSortChange: (s: SortKey) => void
  onRackSave: (id: number, rack: string) => void
  onNeedMore: () => void
  onRetry: () => void
  onClearFilters: () => void
  onCreate: () => void
  onGoToPurchases: () => void
  bodyRef: React.RefObject<HTMLDivElement | null>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [savingId, setSavingId] = useState<number | null>(null)

  const columnVisibility = narrow ? NARROW_VISIBILITY : WIDE_VISIBILITY

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => String(row.medicine.id),
    state: { columnVisibility },
  })

  const template = table.getVisibleFlatColumns().map((c) => c.columnDef.meta?.width ?? '1fr').join(' ')

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => rows[index]?.medicine.id ?? index,
    overscan: 12,
  })

  const items = virtualizer.getVirtualItems()
  const lastRendered = items.at(-1)?.index ?? 0

  /* Fetch the next page while there is still a screenful of rows below the fold,
     so the operator never arrives at the bottom and waits. */
  useEffect(() => {
    if (rows.length > 0 && lastRendered >= rows.length - 24) onNeedMore()
  }, [lastRendered, rows.length, onNeedMore])

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < rows.length) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, rows.length, virtualizer])

  /* The anchor a shift-click extends FROM. A ref, not state: it is read during
     the click that uses it and must never cause a render of its own. */
  const anchorRef = useRef<number | null>(null)

  const toggleRow = (index: number, range: boolean) => {
    const row = rows[index]
    if (!row) return
    const next = new Set(selectedIds)
    const anchor = anchorRef.current
    if (range && anchor !== null) {
      const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor]
      // A range always ADDS. Extending a selection and having it silently clear
      // what the earlier clicks put in it is how twenty ticks are lost at once.
      for (let i = lo; i <= hi; i++) {
        const r = rows[i]
        if (r) next.add(r.medicine.id)
      }
    } else {
      const id = row.medicine.id
      if (next.has(id)) next.delete(id)
      else next.add(id)
      anchorRef.current = index
    }
    onSelectionChange(next)
  }

  const grid: GridHandlers = {
    today,
    editingId,
    draft,
    savingId,
    selectedIds,
    toggleRow,
    setDraft,
    startEdit: (id, current) => { setEditingId(id); setDraft(current) },
    cancelEdit: () => setEditingId(null),
    commitEdit: () => {
      if (editingId === null) return
      const id = editingId
      const row = rows.find((r) => r.medicine.id === id)
      setEditingId(null)
      if (!row || draft.trim() === (row.medicine.rackLocation ?? '')) return
      setSavingId(id)
      onRackSave(id, draft.trim())
      window.setTimeout(() => setSavingId((s) => (s === id ? null : s)), 400)
    },
  }

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
    } else if (e.key === ' ') {
      /* Space ticks the row under the highlight. Enter opens, Space selects —
         which is how a shelf gets marked up without the hand leaving the arrow
         keys, and it is the same pairing every file manager uses. */
      e.preventDefault()
      toggleRow(activeIndex, e.shiftKey)
    } else if (e.key === 'F2') {
      /* Marg's F2 is "modify this item". Here it edits the one field that is safe
         to change without a form, which is where the focus already is. */
      const row = rows[activeIndex]
      if (row) { e.preventDefault(); grid.startEdit(row.medicine.id, row.medicine.rackLocation ?? '') }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
    }
  }

  const headers = table.getHeaderGroups().at(0)?.headers ?? []
  const modelRows = table.getRowModel().rows
  const activeRow = rows[activeIndex]

  /* The header is a ROW OF THE GRID, so it is built here and rendered INSIDE the
     grid element rather than above it.
     It used to be a `role="row"` sibling of `role="grid"`, which axe flags as
     critical and which is worse than it sounds: a row outside its grid is not a
     row at all, so a screen-reader user tabbing into the catalogue got eleven
     unlabelled columns of numbers. The other states below render no header
     because there is nothing for it to head. */
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
                <SelectAll
                  rows={rows}
                  selectedIds={selectedIds}
                  onSelectionChange={onSelectionChange}
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
        <SkeletonRows rows={14} cols={narrow ? 7 : 11} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="inventory.view" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : rows.length === 0 ? (
        <Empty filtered={filtered} onClearFilters={onClearFilters} onCreate={onCreate} onGoToPurchases={onGoToPurchases} />
      ) : (
        <GridContext.Provider value={grid}>
          <div
            ref={(el) => {
              scrollRef.current = el
              bodyRef.current = el
            }}
            role="grid"
            tabIndex={0}
            aria-label="Medicine catalogue"
            aria-rowcount={total + 1}
            aria-activedescendant={activeRow ? `medicine-row-${activeRow.medicine.id}` : undefined}
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
                const selected = data.medicine.id === selectedId
                const ticked = selectedIds.has(data.medicine.id)
                return (
                  <div
                    key={row.id}
                    id={`medicine-row-${data.medicine.id}`}
                    role="row"
                    aria-rowindex={item.index + 2}
                    aria-selected={selected}
                    data-index={item.index}
                    data-ticked={ticked ? '' : undefined}
                    onClick={() => { onActiveIndexChange(item.index); onOpen(data) }}
                    className={cn(
                      'absolute inset-x-0 top-0 grid cursor-default items-center gap-1.5 border-b border-border-subtle px-[var(--cell-px)]',
                      'transition-colors duration-[var(--dur-fast)]',
                      selected ? 'bg-accent-3' : active ? 'bg-accent-3/45' : ticked ? 'bg-accent-1' : 'hover:bg-hover',
                      !data.medicine.isActive && 'opacity-60',
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

      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-muted">
        <span className="flex items-center gap-2">
          {status === 'ready' ? (
            <>
              <span className="num font-medium text-fg">{rows.length.toLocaleString('en-IN')}</span>
              {rows.length < total ? <> of <span className="num">{total.toLocaleString('en-IN')}</span></> : null} item{total === 1 ? '' : 's'}
              {fetchingMore ? <span className="ml-2 text-fg-subtle">loading more…</span> : null}
              {selectedIds.size > 0 ? (
                <span className="flex items-center gap-1 rounded-[var(--radius-full)] bg-accent-3 px-2 py-0.5 font-medium text-accent-11">
                  <CheckSquare size={11} aria-hidden />
                  <span className="num">{selectedIds.size}</span> ticked
                </span>
              ) : null}
            </>
          ) : (
            'Catalogue'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>Space</Kbd> tick</span>
          <span className="flex items-center gap-1"><Kbd>F2</Kbd> rack</span>
          <span className="flex items-center gap-1"><Kbd>/</Kbd> search</span>
        </span>
      </div>
    </div>
  )
}

function Empty({
  filtered, onClearFilters, onCreate, onGoToPurchases,
}: {
  filtered: boolean
  onClearFilters: () => void
  onCreate: () => void
  onGoToPurchases: () => void
}) {
  /* The empty state has to answer "so what do I do now?", and for an item master
     the honest answer is almost never "type one in". A medicine is normally born
     on a goods receipt: the supplier's invoice already carries the brand, pack,
     batch, expiry, MRP and HSN, so entering it there fills the master AND the
     stock in one pass. Manual entry is the exception, and it reads as one. */
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {filtered ? (
        <EmptyState
          icon={PackageSearch}
          title="Nothing matches this view"
          body={
            <>
              No item satisfies every filter above. Drop one of them, or record the goods
              receipt that would create it.
              <span className="mt-2 flex items-center justify-center gap-2">
                <Button variant="secondary" onClick={onGoToPurchases}><Truck /> Go to Purchases</Button>
                <Button variant="ghost" onClick={onCreate}>Add it by hand</Button>
              </span>
            </>
          }
          actionLabel="Clear all filters"
          onAction={onClearFilters}
        />
      ) : (
        <EmptyState
          icon={Pill}
          title="The catalogue is empty"
          body={
            <>
              Medicines are normally created by a goods receipt — the supplier invoice already
              carries the brand, pack, batch, expiry, MRP and HSN, so keying it in Purchases
              fills the master and the opening stock together.
              <span className="mt-2 flex justify-center">
                <Button variant="ghost" onClick={onCreate}>Or add one item by hand</Button>
              </span>
            </>
          }
          actionLabel="Record a goods receipt"
          onAction={onGoToPurchases}
        />
      )}
    </div>
  )
}
