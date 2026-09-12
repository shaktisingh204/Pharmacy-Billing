import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, FileSearch, SearchX } from 'lucide-react'
import type {
  Permission, ReportCellKind, ReportColumn, ReportGroup, ReportResult, ReportRow,
} from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatPercent, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Kbd } from '@/components/ui/Kbd'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'

/**
 * One grid for every report.
 *
 * The alternative — a component per report — is how a product ends up with ten
 * subtly different tables, three of which foot their totals over the loaded page
 * instead of the filtered set. Here the columns are DATA, so the footer, the
 * keyboard model and the CSV all read the same shape and cannot drift apart.
 *
 * Two things this grid insists on:
 *
 *  - THE FOOTER IS THE WHOLE FILTERED SET, not what has been scrolled into
 *    view. `buildReport` totals before the virtualiser ever sees a row, and
 *    getting that wrong once destroys trust in every number on the screen.
 *  - A MISSING VALUE IS AN EM DASH, never a zero. In a stock column that is the
 *    difference between "none left" and "we do not know".
 *
 * Wide reports scroll horizontally INSIDE this card. The document itself must
 * never scroll sideways — an operator cannot scroll a till.
 */

export type RunnerStatus = 'loading' | 'ready' | 'error' | 'offline' | 'denied'

/* Stable identities, so the column memos below do not recompute on every render
   while the report is still loading. */
const NO_COLUMNS: ReportColumn[] = []
const NO_ROWS: ReportRow[] = []

/** Matches --row-h at compact density; the virtualiser and the DOM must agree. */
const ROW_H = 34
const HEAD_H = 30

/* Money is the widest thing here: '12,34,567.89' at tabular figures needs every
   pixel of 112, and a column that wraps ruins the alignment tabular buys. */
const WIDTH: Record<ReportCellKind, string> = {
  text: 'minmax(148px, 1.4fr)',
  code: '128px',
  date: '104px',
  expiry: '78px',
  money: '116px',
  qty: '92px',
  pct: '76px',
  count: '84px',
  status: '132px',
}

/** `gap-2` on every row. Kept as a number because the scroller has to be sized
 *  in the same units the grid lays itself out in. */
const GAP = 8

const RIGHT: ReadonlySet<ReportCellKind> = new Set<ReportCellKind>(['money', 'qty', 'pct', 'count', 'date'])

const TONE: Record<NonNullable<ReportRow['tone']>, string> = {
  danger: 'var(--danger-11)',
  warning: 'var(--warning-11)',
  muted: 'var(--fg-subtle)',
}

const NEGATIVE = /^-/

function renderCell(value: string | null, kind: ReportCellKind) {
  if (value === null || value.trim() === '') return <span className="text-fg-subtle">—</span>
  switch (kind) {
    case 'money':
      return (
        <span className={cn('num', NEGATIVE.test(value) && 'text-danger-11')}>{formatAmount(value)}</span>
      )
    case 'qty':
      return <span className="num">{formatQty(value)}</span>
    case 'pct':
      return <span className="num">{formatPercent(value)}</span>
    case 'count':
      return <span className="num">{value}</span>
    case 'expiry':
      return <span className="mono num text-fg-muted">{formatExpiry(value)}</span>
    case 'date':
      return <span className="num text-fg-muted">{value}</span>
    case 'code':
      return <span className="mono truncate text-xs">{value}</span>
    case 'status':
      return (
        <span className="inline-flex h-5 max-w-full items-center truncate rounded-[var(--radius-sm)] bg-subtle px-1.5 text-2xs font-medium text-fg-muted">
          {value}
        </span>
      )
    case 'text':
      return <span className="truncate">{value}</span>
  }
}

/**
 * A grouped report is still ONE virtualised list.
 *
 * Rendering bands as nested scrollers is the obvious move and the wrong one: a
 * report indexed by supplier has 40 bands and 4,000 rows, and 40 independent
 * virtualisers means 40 scroll positions, no working Home/End, and a keyboard
 * model that has to know which band it is inside. Flattening headers and rows
 * into one sequence keeps every one of those behaviours identical to the flat
 * report — which is the point of grouping in place rather than in a new screen.
 */
type Item =
  | { kind: 'band'; group: ReportGroup; open: boolean }
  | { kind: 'row'; row: ReportRow }

function flatten(
  groups: readonly ReportGroup[],
  rows: readonly ReportRow[],
  collapsed: ReadonlySet<string>,
): Item[] {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const items: Item[] = []
  for (const group of groups) {
    const open = !collapsed.has(group.key)
    items.push({ kind: 'band', group, open })
    if (!open) continue
    for (const key of group.rowKeys) {
      const row = byKey.get(key)
      if (row) items.push({ kind: 'row', row })
    }
  }
  return items
}

export function ReportRunner({
  result,
  status,
  needs,
  errorCode,
  errorMessage,
  filtered,
  onRetry,
  onClearFilters,
}: {
  result: ReportResult | null
  status: RunnerStatus
  /** The gate this report is refused on. Named so the reader can ask for the
   *  permission that exists rather than one nobody can grant. */
  needs: Permission
  errorCode?: string
  errorMessage?: string
  /** Drives the empty state's wording: no data at all reads differently from
   *  a filter that excluded everything, and only one of them has a fix. */
  filtered: boolean
  onRetry: () => void
  onClearFilters: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const columns = result?.columns ?? NO_COLUMNS
  const rows = result?.rows ?? NO_ROWS
  const groups = result?.groups ?? null

  /* Collapsed BANDS, not band indexes. A key survives re-running the report,
     so narrowing the dates does not silently re-open the six suppliers the
     reader had folded away to see the other four. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const items = useMemo(
    () => (groups === null ? null : flatten(groups, rows, collapsed)),
    [groups, rows, collapsed],
  )
  /** What the grid actually walks — bands and rows, or just rows. */
  const count = items?.length ?? rows.length

  const template = useMemo(
    () => columns.map((c) => WIDTH[c.kind]).join(' '),
    [columns],
  )
  /* Every track at its minimum PLUS the gutters and the row's own padding.
     Leaving those out sized the scroller short of the grid inside it, so on a
     wide report — customer outstanding is fifteen columns — the sticky header
     and the totals bar ran out of background a hundred-odd pixels before the
     last column, and rows scrolled through the total underneath it. */
  const minWidth = useMemo(() => {
    const tracks = columns.reduce(
      (acc, c) => acc + (c.kind === 'text' ? 148 : Number.parseInt(WIDTH[c.kind], 10)),
      0,
    )
    return `calc(${tracks + GAP * Math.max(columns.length - 1, 0)}px + 2 * var(--cell-px))`
  }, [columns])

  /* A new report or a new filter puts the highlight back at the top, adjusted
     during render so the grid never paints one frame pointing at a stale row. */
  const identity = `${result?.reportId ?? ''}|${rows.length}|${rows[0]?.key ?? ''}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setActiveIndex(0)
  }

  /* Switching the column grouped on throws the folds away. Keeping them would
     apply supplier names to a manufacturer index, where a stale key either
     matches nothing or — worse — matches a band the reader never folded. */
  const groupIdentity = result?.groupBy ?? ''
  const [lastGroup, setLastGroup] = useState(groupIdentity)
  if (groupIdentity !== lastGroup) {
    setLastGroup(groupIdentity)
    setCollapsed(new Set())
  }

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => {
      const item = items?.[index]
      if (item) return item.kind === 'band' ? `band:${item.group.key}` : item.row.key
      return rows[index]?.key ?? index
    },
    overscan: 14,
  })

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < count) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, count, virtualizer])

  function toggleBand(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target)) return
    const last = count - 1
    const here = items?.[activeIndex]
    if (here?.kind === 'band' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      toggleBand(here.group.key)
      return
    }
    /* ← and → fold and unfold, matching the tree convention every file manager
       and every outliner uses. Without them a keyboard reader can reach a band
       and has no way to open it that is not Enter, which they have to guess. */
    if (here?.kind === 'band' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const wantOpen = e.key === 'ArrowRight'
      if (here.open !== wantOpen) { e.preventDefault(); toggleBand(here.group.key) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0) }
    else if (e.key === 'End') { e.preventDefault(); setActiveIndex(Math.max(last, 0)) }
    else if (e.key === 'PageDown') { e.preventDefault(); setActiveIndex(Math.min(activeIndex + 20, last)) }
    else if (e.key === 'PageUp') { e.preventDefault(); setActiveIndex(Math.max(activeIndex - 20, 0)) }
  }

  const hasTotals = result !== null && columns.some((c) => result.totals[c.key] !== undefined)

  return (
    <div className="card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {status === 'loading' ? (
        <SkeletonRows rows={14} cols={6} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs={needs} />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode ?? 'REPORT_FAILED'} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="Nothing matches these filters"
              body="The report ran; the filters excluded every row. Clearing them shows the whole period."
              actionLabel="Clear filters"
              onAction={onClearFilters}
            />
          ) : (
            <EmptyState
              icon={FileSearch}
              title="No entries in this period"
              body={`${result?.title ?? 'This report'} found nothing between ${result?.from ?? ''} and ${result?.to ?? ''}. Widen the dates, or check that the documents were posted.`}
            />
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          aria-label={`${result?.title ?? 'Report'} rows`}
          aria-rowcount={count + 1}
          onKeyDown={onKeyDown}
          data-focus-inset
          className="scroll-region min-h-0 flex-1 overflow-x-auto"
          /* The totals bar is pinned inside this scroller, so the focused row
             has to be able to clear it (WCAG 2.2 SC 2.4.11). */
          style={{ ['--pinned-h' as string]: `${ROW_H}px` }}
        >
          <div style={{ minWidth }}>
            <div
              role="row"
              className="sticky top-0 z-10 grid items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)]"
              style={{ gridTemplateColumns: template, height: HEAD_H }}
            >
              {columns.map((c) => (
                <span
                  key={c.key}
                  role="columnheader"
                  title={c.hint}
                  className={cn('micro-label truncate', RIGHT.has(c.kind) && 'text-right', c.hint && 'cursor-help')}
                >
                  {c.label}
                </span>
              ))}
            </div>

            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = items?.[item.index]
                const active = item.index === activeIndex
                if (entry?.kind === 'band') {
                  return (
                    <BandRow
                      key={`band:${entry.group.key}`}
                      group={entry.group}
                      open={entry.open}
                      columns={columns}
                      template={template}
                      rowIndex={item.index + 2}
                      active={active}
                      offset={item.start}
                      onToggle={() => { setActiveIndex(item.index); toggleBand(entry.group.key) }}
                    />
                  )
                }
                const row = entry?.kind === 'row' ? entry.row : rows[item.index]
                if (!row) return null
                return (
                  <div
                    key={row.key}
                    role="row"
                    aria-rowindex={item.index + 2}
                    onClick={() => setActiveIndex(item.index)}
                    className={cn(
                      'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-border-subtle px-[var(--cell-px)]',
                      active ? 'bg-accent-3/45' : 'hover:bg-hover',
                      row.tone === 'muted' && 'opacity-60',
                      /* Rows under a band are inset, so a band header and its
                         members read as one block rather than as an alternating
                         stripe. The inset is on padding, never on the grid
                         template — shifting the tracks would take every number
                         out of line with the totals bar below it. */
                      items !== null && 'pl-[calc(var(--cell-px)+14px)]',
                    )}
                    style={{
                      height: ROW_H,
                      transform: `translateY(${item.start}px)`,
                      gridTemplateColumns: template,
                    }}
                  >
                    {row.tone ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 w-[3px]"
                        style={{ background: TONE[row.tone] }}
                      />
                    ) : null}
                    {columns.map((c) => (
                      <span
                        key={c.key}
                        role="gridcell"
                        className={cn('flex min-w-0 text-base', RIGHT.has(c.kind) ? 'justify-end' : 'items-center')}
                        title={c.kind === 'text' ? (row.cells[c.key] ?? undefined) : undefined}
                      >
                        {renderCell(row.cells[c.key] ?? null, c.kind)}
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>

            {hasTotals && result ? <TotalsRow columns={columns} result={result} template={template} /> : null}
          </div>
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-3 text-2xs text-fg-muted">
        <span>
          {status === 'ready' && result ? (
            <>
              <span className="num font-medium text-fg">{rows.length.toLocaleString('en-IN')}</span>
              {' '}row{rows.length === 1 ? '' : 's'}
              {groups ? (
                <>
                  {' in '}
                  <span className="num font-medium text-fg">{groups.length}</span>
                  {' group'}{groups.length === 1 ? '' : 's'}
                </>
              ) : null}
              {' · totals below are for every row in this view'}
            </>
          ) : (
            result?.title ?? 'Report'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          {groups ? (
            <span className="flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd> fold</span>
          ) : null}
          <span className="flex items-center gap-1"><Kbd>/</Kbd> search</span>
          <span className="flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>E</Kbd> export</span>
        </span>
      </div>
    </div>
  )
}

/**
 * The footer, pinned inside the same scroller as the grid so it tracks the
 * horizontal position of the columns it is totalling. A totals bar that does not
 * move with its columns is worse than none at all.
 */
function TotalsRow({
  columns, result, template,
}: {
  columns: ReportColumn[]
  result: ReportResult
  template: string
}) {
  return (
    <div
      role="row"
      className="sticky bottom-0 z-10 grid items-center gap-2 border-t border-border bg-surface px-[var(--cell-px)] shadow-[0_-1px_0_var(--border-subtle)]"
      style={{ gridTemplateColumns: template, height: ROW_H }}
    >
      {columns.map((c, i) => {
        const total = result.totals[c.key]
        /* Every child of a row has to BE a cell. Bare spans left the footer as a
           row with nothing in it, which axe reports as critical and which costs
           a screen-reader user the totals line — the one row on a report that
           people actually read out loud. */
        if (total === undefined || total === null) {
          return (
            <span key={c.key} role="gridcell" className="micro-label truncate text-fg">
              {i === 0 ? 'Total' : ''}
            </span>
          )
        }
        return (
          <span key={c.key} role="gridcell" className="flex min-w-0 justify-end text-base font-semibold">
            {renderCell(total, c.kind)}
          </span>
        )
      })}
    </div>
  )
}

/**
 * One band header, carrying its own subtotals in the columns they belong to.
 *
 * This is the whole reason grouping is worth building. Marg's equivalent prints
 * a band label and makes you read down to a footer for the figure; putting the
 * subtotal in the same column as the numbers it sums means the eye compares
 * bands without arithmetic — which supplier, which manufacturer, which rate.
 *
 * The subtotals come from `ReportGroup.totals`, computed by the same rule as the
 * page footer: only columns declared `total`. A percentage therefore stays blank
 * here rather than being averaged, because the mean of a column of margins is
 * not the margin of the band and a plausible wrong number is worse than none.
 */
function BandRow({
  group, open, columns, template, rowIndex, active, offset, onToggle,
}: {
  group: ReportGroup
  open: boolean
  columns: readonly ReportColumn[]
  template: string
  rowIndex: number
  active: boolean
  offset: number
  onToggle: () => void
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'absolute inset-x-0 top-0 grid cursor-pointer items-center gap-2 border-b border-border px-[var(--cell-px)]',
        active ? 'bg-accent-3' : 'bg-subtle hover:bg-accent-3/45',
      )}
      style={{ height: ROW_H, transform: `translateY(${offset}px)`, gridTemplateColumns: template }}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />
      {columns.map((c, i) => {
        const total = group.totals[c.key]
        if (i === 0) {
          return (
            <span key={c.key} role="gridcell" className="flex min-w-0 items-center gap-1.5">
              <Chevron size={13} className="shrink-0 text-fg-muted" aria-hidden />
              <span className="truncate text-base font-semibold text-fg" title={group.label}>
                {group.label}
              </span>
              {/* The count is what tells the reader a band is worth opening, and
                  it is the one figure a collapsed band must never hide. */}
              <span className="num shrink-0 rounded-[var(--radius-sm)] bg-surface px-1 text-2xs text-fg-muted">
                {group.count}
              </span>
            </span>
          )
        }
        if (total === undefined || total === null) return <span key={c.key} aria-hidden />
        return (
          <span key={c.key} role="gridcell" className="flex min-w-0 justify-end text-base font-semibold">
            {renderCell(total, c.kind)}
          </span>
        )
      })}
    </div>
  )
}
