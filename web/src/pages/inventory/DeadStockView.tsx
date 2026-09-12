import { useMemo } from 'react'
import { PartyPopper, ShieldOff, Tag } from 'lucide-react'
import type { BatchRow, IsoDate } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip, ExpiryChip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import type { Basis, BatchAge } from './analysis'
import { BASIS_SUFFIX, DEAD_DAY_OPTIONS, deadStock } from './analysis'
import { AnalysisShell, Hero, ScopeNote, Th } from './panels'

/**
 * Money that has stopped moving.
 *
 * The one report a distributor's software never volunteers, because it is an
 * argument for buying less. A pharmacy's working capital sits almost entirely in
 * stock, and the batches that quietly stopped selling are where it goes to die —
 * long before they are near enough to expiry for the expiry board to care.
 *
 * Quarantined stock is deliberately in the list. It is not moving by definition,
 * and a batch set aside for a supplier return four months ago that nobody ever
 * sent back is exactly the money this exists to find.
 *
 * There is no "write it off" button here on purpose. Dead is not expired: the
 * right answers are a discount, a branch transfer, a return to the distributor
 * or a decision to stop reordering — and each of those is somebody's judgement,
 * not a batch operation.
 */

export function DeadStockView({
  rows, ages, status, errorMessage, basis, todayIso, days, onDays, total, filtered,
  selected, onToggle, onSelectAll, onClearSelection, onLabels, onHold, onRetry, onOpen, onSortByValue,
}: {
  rows: BatchRow[]
  ages: ReadonlyMap<number, BatchAge> | null
  status: 'loading' | 'error' | 'ready'
  errorMessage?: string
  basis: Basis
  todayIso: IsoDate
  days: number
  onDays: (d: number) => void
  total: number
  filtered: boolean
  selected: ReadonlySet<number>
  onToggle: (id: number) => void
  onSelectAll: (ids: number[]) => void
  onClearSelection: () => void
  onLabels: () => void
  onHold: () => void
  onRetry: () => void
  onOpen: (row: BatchRow) => void
  onSortByValue?: () => void
}) {
  const dead = useMemo(
    () => deadStock(rows, ages ?? new Map(), basis, todayIso, days),
    [rows, ages, basis, todayIso, days],
  )

  const ids = dead.rows.map((d) => d.row.batch.id)
  const allChosen = ids.length > 0 && ids.every((id) => selected.has(id))
  const someChosen = ids.some((id) => selected.has(id))

  return (
    <AnalysisShell
      title="Dead stock"
      description={
        <>
          Batches still holding stock that nothing has left in {days} days, valued{' '}
          {BASIS_SUFFIX[basis]}. Held stock is included — a batch set aside for a return four
          months ago and never sent back is the money this list exists to find.
        </>
      }
      controls={
        <div role="group" aria-label="Idle threshold" className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border bg-subtle p-0.5">
          {DEAD_DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === days}
              onClick={() => onDays(d)}
              className={cn(
                'h-8 rounded-[var(--radius-sm)] px-2.5 text-sm transition-colors duration-[var(--dur-fast)]',
                d === days ? 'bg-surface font-semibold text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      }
    >
      {status === 'loading' ? (
        <SkeletonRows rows={10} cols={6} />
      ) : status === 'error' ? (
        <ErrorState code="DEAD_STOCK_FAILED" message={errorMessage} onRetry={onRetry} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-border-subtle px-[var(--card-px)] py-[var(--card-px)]">
            <Hero
              value={dead.value}
              basis={basis}
              caption={`Not moved in ${days} days`}
              tone={dead.rows.length > 0 ? 'var(--warning-11)' : undefined}
              sub={
                <>
                  across <span className="num font-medium text-fg">{dead.rows.length.toLocaleString('en-IN')}</span>{' '}
                  {dead.rows.length === 1 ? 'batch' : 'batches'}
                  {dead.sharePct === null ? null : (
                    <> — <span className="num font-medium text-fg">{dead.sharePct}%</span> of the
                      analysed shelf {BASIS_SUFFIX[basis]}</>
                  )}
                  . Discount it, move it to a branch that sells it, or claim it back — but decide.
                </>
              }
            />
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Units stranded" value={formatQty(dead.units)} />
              <Stat label="Batches judged" value={dead.judged.toLocaleString('en-IN')} />
              {dead.unknown > 0 ? (
                <Stat label="No ledger row" value={dead.unknown.toLocaleString('en-IN')} warn />
              ) : null}
            </dl>
          </div>

          {dead.rows.length === 0 ? (
            <EmptyState
              icon={PartyPopper}
              title={`Nothing has been idle for ${days} days`}
              body="Every batch analysed here has moved inside the window. Try a shorter threshold, or widen the filters above to look at more of the shelf."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-2">
                <label className="flex items-center gap-2 text-sm text-fg-muted">
                  <input
                    type="checkbox"
                    checked={allChosen}
                    ref={(el) => { if (el) el.indeterminate = someChosen && !allChosen }}
                    onChange={() => (allChosen ? onClearSelection() : onSelectAll(ids))}
                    aria-label={`Select all ${ids.length} dead batches`}
                    className="size-4 accent-[var(--accent-9)]"
                  />
                  Select all {ids.length}
                </label>
                <span aria-hidden className="mx-1 h-5 w-px bg-border" />
                <Button size="sm" disabled={!someChosen} onClick={onLabels}>
                  <Tag /> Print labels
                </Button>
                <Button size="sm" disabled={!someChosen} onClick={onHold}>
                  <ShieldOff /> Quarantine or release
                </Button>
                <span className="ml-auto text-2xs text-fg-subtle">
                  Nothing here is written off. Dead is not expired.
                </span>
              </div>

              <div data-density="compact">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th className="w-9"><span className="sr-only">Select</span></Th>
                      <Th>Medicine</Th>
                      <Th>Batch</Th>
                      <Th>Rack</Th>
                      <Th align="right">Idle days</Th>
                      <Th align="right">On shelf</Th>
                      <Th align="right">On hand</Th>
                      <Th align="right">₹ {basis === 'cost' ? 'at cost' : 'at MRP'}</Th>
                      <Th>Expiry</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {dead.rows.map(({ row, idle, shelf, value }) => {
                      const chosen = selected.has(row.batch.id)
                      return (
                        <tr
                          key={row.batch.id}
                          aria-selected={chosen}
                          onClick={() => onOpen(row)}
                          className={cn(
                            'cursor-default border-b border-border-subtle',
                            chosen ? 'bg-accent-3' : 'hover:bg-hover',
                          )}
                        >
                          <td className="px-[var(--cell-px)] py-1.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={chosen}
                              onChange={() => onToggle(row.batch.id)}
                              aria-label={`Select ${row.medicine.brandName} batch ${row.batch.batchNo}`}
                              className="size-4 accent-[var(--accent-9)]"
                            />
                          </td>
                          <td className="max-w-0 truncate px-[var(--cell-px)] py-1.5 text-base text-fg" title={row.medicine.brandName}>
                            {row.medicine.brandName}{' '}
                            <span className="text-2xs text-fg-subtle">{row.medicine.packLabel}</span>
                          </td>
                          <td className="mono px-[var(--cell-px)] py-1.5 text-xs text-fg-muted">{row.batch.batchNo}</td>
                          <td className="mono px-[var(--cell-px)] py-1.5 text-xs text-fg-muted">
                            {row.medicine.rackLocation ?? '—'}
                          </td>
                          <td className="num px-[var(--cell-px)] py-1.5 text-sm font-semibold text-warning-11">{idle}</td>
                          <td className="num px-[var(--cell-px)] py-1.5 text-sm text-fg-muted">{shelf ?? '—'}</td>
                          <td className="num px-[var(--cell-px)] py-1.5 text-sm text-fg-muted">
                            {formatQty(row.batch.qtyOnHand)}
                          </td>
                          <td
                            className="num px-[var(--cell-px)] py-1.5 text-sm font-medium text-fg"
                            title={`${formatMoney(value)} ${BASIS_SUFFIX[basis]}`}
                          >
                            {formatAmount(value)}
                          </td>
                          <td className="px-[var(--cell-px)] py-1.5">
                            <ExpiryChip bucket={row.bucket} label={formatExpiry(row.batch.expiryDate)} />
                          </td>
                          <td className="px-[var(--cell-px)] py-1.5">
                            {row.batch.isQuarantined ? (
                              <Chip icon={ShieldOff} tone="var(--status-quarantine)">Quarantined</Chip>
                            ) : (
                              <span className="text-2xs text-fg-subtle">On the shelf</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <ScopeNote
            analysed={rows.length}
            total={total}
            ledger
            filtered={filtered}
            {...(onSortByValue ? { onSortByValue } : {})}
          />
        </>
      )}
    </AnalysisShell>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className={cn('num mt-0.5 text-lg font-semibold', warn ? 'text-warning-11' : 'text-fg')}>{value}</dd>
    </div>
  )
}
