import { useMemo } from 'react'
import { Hourglass } from 'lucide-react'
import type { BatchRow, IsoDate } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { ExpiryChip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import type { Basis, BatchAge } from './analysis'
import { BASIS_SUFFIX, idleDays, shelfDays, summariseAgeing, valueOf } from './analysis'
import { AnalysisShell, Hero, ScopeNote, ShareBar, Th } from './panels'

/**
 * Stock ageing, read off the ledger rather than guessed from the expiry date.
 *
 * The two are not the same question and confusing them is the classic pharmacy
 * reporting mistake: a batch expiring in 2028 that nothing has touched since
 * March is dead money with two years left to run, and an expiry report will
 * never mention it. So "age" here means DAYS SINCE ANYTHING LEFT THIS BATCH —
 * `lastIssuedAt` on the ledger — and a batch that has never issued ages from the
 * day it arrived.
 *
 * A goods receipt onto an existing lot deliberately does NOT reset the clock. It
 * is movement, but it is movement in the wrong direction, and letting it count
 * would hide slow stock behind the act of buying more of it.
 */

/** Enough to work a shelf from; the whole list lives in the grid. */
const OLDEST_SHOWN = 40

export function AgeingView({
  rows, ages, status, errorMessage, basis, todayIso, total, filtered, onRetry, onOpen, onSortByValue,
}: {
  rows: BatchRow[]
  ages: ReadonlyMap<number, BatchAge> | null
  status: 'loading' | 'error' | 'ready'
  errorMessage?: string
  basis: Basis
  todayIso: IsoDate
  total: number
  filtered: boolean
  onRetry: () => void
  onOpen: (row: BatchRow) => void
  onSortByValue?: () => void
}) {
  const summary = useMemo(
    () => summariseAgeing(rows, ages ?? new Map(), basis, todayIso),
    [rows, ages, basis, todayIso],
  )

  /* The two slowest bands, which is the number an owner asks for: money that has
     not moved in a quarter. Read off the bands so the headline can never
     disagree with the distribution under it. */
  const stale = useMemo(() => {
    const slow = summary.bands.filter((b) => b.band.max > 90)
    return D.toStr(D.sum(slow.map((b) => D.dec(b.value))), 2)
  }, [summary])

  const oldest = useMemo(() => {
    if (ages === null) return []
    return rows
      .map((row) => ({ row, idle: idleDays(ages.get(row.batch.id), todayIso) }))
      .filter((r): r is { row: BatchRow; idle: number } => r.idle !== null)
      .sort((a, b) => b.idle - a.idle || a.row.batch.id - b.row.batch.id)
      .slice(0, OLDEST_SHOWN)
  }, [rows, ages, todayIso])

  return (
    <AnalysisShell
      title="Stock ageing"
      description={
        <>
          How long each batch has SAT — days since anything last left it, read off the stock
          ledger. Not the same question as expiry: a lot with two years to run that nothing has
          touched since March is dead money the expiry board will never mention.
        </>
      }
    >
      {status === 'loading' ? (
        <SkeletonRows rows={10} cols={6} />
      ) : status === 'error' ? (
        <ErrorState code="AGEING_FAILED" message={errorMessage} onRetry={onRetry} />
      ) : summary.agedBatches === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="Nothing here could be aged"
          body="Ageing is read from the stock ledger, and none of the batches in this view has a movement on file. A batch that appeared without a movement is a reconciliation fault, not an old one."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-border-subtle px-[var(--card-px)] py-[var(--card-px)]">
            <Hero
              value={stale}
              basis={basis}
              caption="Sitting longer than 90 days"
              tone={D.gt(D.dec(stale), D.ZERO) ? 'var(--viz-seq-6)' : undefined}
              sub={
                <>
                  {BASIS_SUFFIX[basis]}, across{' '}
                  <span className="num font-medium text-fg">
                    {summary.bands.filter((b) => b.band.max > 90).reduce((n, b) => n + b.batches, 0)}
                  </span>{' '}
                  batches. The oldest has not moved in{' '}
                  <span className="num font-medium text-fg">{summary.oldestDays ?? '—'}</span> days.
                </>
              }
            />
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Aged" value={`${summary.agedBatches.toLocaleString('en-IN')} batches`} />
              <Stat label="Units on hand" value={formatQty(summary.agedUnits)} />
              <Stat label={`Value ${BASIS_SUFFIX[basis]}`} value={formatMoney(summary.agedValue)} />
              {summary.unknown > 0 ? (
                <Stat
                  label="No ledger row"
                  value={`${summary.unknown.toLocaleString('en-IN')} batches`}
                  warn
                />
              ) : null}
            </dl>
          </div>

          <div className="flex flex-col gap-2.5 border-b border-border-subtle px-[var(--card-px)] py-[var(--card-px)]">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="micro-label">Where the money is sitting</h3>
              {/* The opposite of the expiry board, and worth saying: these bands
                  are disjoint, so they do add up to the analysed shelf. */}
              <span className="text-2xs text-fg-subtle">Bands do not overlap — these add up</span>
            </div>
            {summary.bands.map((b) => (
              <div key={b.band.key} className="grid grid-cols-[minmax(120px,1.4fr)_minmax(90px,3fr)_auto] items-center gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-fg">{b.band.label}</span>
                  <span className="truncate text-2xs text-fg-subtle">{b.band.note}</span>
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <ShareBar pct={b.sharePct} tone={b.band.tone} />
                  <span className="text-2xs text-fg-muted">
                    <span className="num font-medium text-fg">{b.batches}</span>
                    {b.batches === 1 ? ' batch' : ' batches'} ·{' '}
                    <span className="num">{formatQty(b.units)}</span> units
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="num text-base font-semibold text-fg">₹{formatAmount(b.value)}</span>
                  <span className="num text-2xs text-fg-subtle">{b.sharePct ?? '—'}%</span>
                </span>
              </div>
            ))}
          </div>

          <div data-density="compact">
            <table className="w-full border-collapse">
              <caption className="px-[var(--card-px)] py-2 text-left text-2xs text-fg-subtle">
                The {Math.min(OLDEST_SHOWN, oldest.length)} slowest batches in this view. Open one to
                read its ledger.
              </caption>
              <thead>
                <tr>
                  <Th>Medicine</Th>
                  <Th>Batch</Th>
                  <Th>Rack</Th>
                  <Th align="right">Idle days</Th>
                  <Th align="right">On shelf</Th>
                  <Th align="right">On hand</Th>
                  <Th align="right">₹ {basis === 'cost' ? 'at cost' : 'at MRP'}</Th>
                  <Th>Expiry</Th>
                </tr>
              </thead>
              <tbody>
                {oldest.map(({ row, idle }) => {
                  const shelf = ages === null ? null : shelfDays(ages.get(row.batch.id), todayIso)
                  return (
                    <tr
                      key={row.batch.id}
                      onClick={() => onOpen(row)}
                      className="cursor-default border-b border-border-subtle hover:bg-hover"
                    >
                      <td className="max-w-0 truncate px-[var(--cell-px)] py-1.5 text-base text-fg" title={row.medicine.brandName}>
                        {row.medicine.brandName}{' '}
                        <span className="text-2xs text-fg-subtle">{row.medicine.packLabel}</span>
                      </td>
                      <td className="mono px-[var(--cell-px)] py-1.5 text-xs text-fg-muted">{row.batch.batchNo}</td>
                      <td className="mono px-[var(--cell-px)] py-1.5 text-xs text-fg-muted">
                        {row.medicine.rackLocation ?? '—'}
                      </td>
                      <td className="num px-[var(--cell-px)] py-1.5 text-sm font-medium text-fg">{idle}</td>
                      <td className="num px-[var(--cell-px)] py-1.5 text-sm text-fg-muted">{shelf ?? '—'}</td>
                      <td className="num px-[var(--cell-px)] py-1.5 text-sm text-fg-muted">
                        {formatQty(row.batch.qtyOnHand)}
                      </td>
                      <td className="num px-[var(--cell-px)] py-1.5 text-sm font-medium text-fg">
                        {formatAmount(valueOf(row, basis))}
                      </td>
                      <td className="px-[var(--cell-px)] py-1.5">
                        <ExpiryChip bucket={row.bucket} label={formatExpiry(row.batch.expiryDate)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

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
