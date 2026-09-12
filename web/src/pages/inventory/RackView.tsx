import { useMemo, useState } from 'react'
import { AlertTriangle, Ban, ChevronDown, ChevronRight, MapPin, ShieldOff, Tag } from 'lucide-react'
import type { BatchRow } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip, ExpiryChip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import type { Basis, RackGroup } from './analysis'
import { BASIS_SUFFIX, groupByRack, valueOf } from './analysis'
import { AnalysisShell, ScopeNote, Th } from './panels'

/**
 * The shelf, in the order somebody walks it.
 *
 * Every other view on this screen is sorted by a number. This one is sorted by
 * the building: rack A-1, then A-2, then A-10 — which a plain string sort gets
 * wrong, and a walk read in the wrong order is a walk done twice.
 *
 * The rack lives on the MEDICINE, not the batch, which is why two batches of one
 * strip are always on the same shelf and why the unracked pile is a catalogue
 * gap rather than a stock problem. It is listed last and says where to fix it.
 */

export function RackView({
  rows, status, errorMessage, basis, total, filtered,
  selected, onSelectAll, onToggle, onLabels, onRetry, onOpen, onGoToMedicines, onSortByValue,
}: {
  rows: BatchRow[]
  status: 'loading' | 'error' | 'ready'
  errorMessage?: string
  basis: Basis
  total: number
  filtered: boolean
  selected: ReadonlySet<number>
  onSelectAll: (ids: number[]) => void
  onToggle: (id: number) => void
  onLabels: () => void
  onRetry: () => void
  onOpen: (row: BatchRow) => void
  onGoToMedicines: () => void
  onSortByValue?: () => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [pullOnly, setPullOnly] = useState(false)

  const groups = useMemo(() => groupByRack(rows, basis), [rows, basis])
  const shown = pullOnly ? groups.filter((g) => g.expired + g.urgent > 0) : groups
  const needsPull = groups.filter((g) => g.expired + g.urgent > 0).length
  const unracked = groups.find((g) => g.rack === null)

  const key = (g: RackGroup) => g.rack ?? '\u0000unracked'

  return (
    <AnalysisShell
      title="Rack walk"
      description={
        <>
          The same stock in the order the shop is laid out, so a shelf check is one pass with a
          list rather than a search per medicine. Within each rack the soonest expiry is first —
          that is what to pull.
        </>
      }
      controls={
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={pullOnly}
            onChange={(e) => setPullOnly(e.target.checked)}
            className="size-4 accent-[var(--accent-9)]"
          />
          Only shelves with something to pull
          <span className="num rounded-[var(--radius-full)] bg-subtle px-1.5 text-2xs text-fg-muted">
            {needsPull}
          </span>
        </label>
      }
    >
      {status === 'loading' ? (
        <SkeletonRows rows={10} cols={5} />
      ) : status === 'error' ? (
        <ErrorState code="RACK_VIEW_FAILED" message={errorMessage} onRetry={onRetry} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={pullOnly ? 'No shelf needs a pull' : 'Nothing to walk'}
          body={
            pullOnly
              ? 'Nothing in this view is expired or inside thirty days. Untick the filter to see every shelf.'
              : 'No batch in this view carries stock, so there is nothing on a shelf to go and look at.'
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border-subtle px-[var(--card-px)] py-3">
            <span className="text-sm text-fg-muted">
              <span className="num text-lg font-semibold text-fg">{groups.length - (unracked ? 1 : 0)}</span>{' '}
              racks in use
            </span>
            <span className="text-sm text-fg-muted">
              <span className="num text-lg font-semibold text-warning-11">{needsPull}</span> need a pull
            </span>
            {unracked ? (
              <span className="text-sm text-fg-muted">
                <span className="num text-lg font-semibold text-fg">{unracked.rows.length}</span>{' '}
                {unracked.rows.length === 1 ? 'batch has' : 'batches have'} no rack —{' '}
                <button
                  type="button"
                  onClick={onGoToMedicines}
                  className="rounded-[var(--radius-sm)] font-medium text-accent-11 underline-offset-2 hover:underline"
                >
                  set it in Medicines
                </button>
              </span>
            ) : null}
          </div>

          <ul aria-label="Racks">
            {shown.map((g) => {
              const id = key(g)
              const expanded = open.has(id)
              const ids = g.rows.map((r) => r.batch.id)
              const chosen = ids.filter((i) => selected.has(i)).length
              return (
                <li key={id} className="border-b border-border-subtle last:border-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-[var(--card-px)] py-2.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen((prev) => {
                        const next = new Set(prev)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] text-left hover:bg-hover"
                    >
                      {expanded
                        ? <ChevronDown size={16} aria-hidden className="shrink-0 text-fg-subtle" />
                        : <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-subtle" />}
                      {g.rack === null ? (
                        <span className="flex items-center gap-1.5 text-base font-semibold text-fg-muted">
                          <MapPin size={15} aria-hidden className="text-fg-disabled" /> No rack set
                        </span>
                      ) : (
                        <span className="mono text-lg font-semibold tracking-tight text-fg">{g.rack}</span>
                      )}
                      <span className="truncate text-2xs text-fg-subtle">
                        <span className="num">{g.skus}</span> {g.skus === 1 ? 'medicine' : 'medicines'} ·{' '}
                        <span className="num">{g.rows.length}</span>{' '}
                        {g.rows.length === 1 ? 'batch' : 'batches'} ·{' '}
                        <span className="num">{formatQty(g.units)}</span> units
                      </span>
                    </button>

                    <span className="flex shrink-0 items-center gap-1.5">
                      {g.expired > 0 ? (
                        <Chip icon={Ban} tone="var(--status-expired)">{g.expired} expired</Chip>
                      ) : null}
                      {g.urgent > 0 ? (
                        <Chip icon={AlertTriangle} tone="var(--status-expiry-30)">{g.urgent} within 30d</Chip>
                      ) : null}
                      {g.quarantined > 0 ? (
                        <Chip icon={ShieldOff} tone="var(--status-quarantine)">{g.quarantined} held</Chip>
                      ) : null}
                      <span
                        className="num w-24 text-right text-base font-semibold text-fg"
                        title={`${formatMoney(g.value)} ${BASIS_SUFFIX[basis]}`}
                      >
                        ₹{formatAmount(g.value)}
                      </span>
                    </span>
                  </div>

                  {expanded ? (
                    <div data-density="compact" className="border-t border-border-subtle bg-subtle/50">
                      <div className="flex flex-wrap items-center gap-2 px-[var(--card-px)] py-2">
                        <Button size="sm" variant="ghost" onClick={() => onSelectAll(ids)}>
                          Select all {ids.length} on this shelf
                        </Button>
                        {chosen > 0 ? (
                          <Button size="sm" onClick={onLabels}>
                            <Tag /> Print labels for {chosen}
                          </Button>
                        ) : null}
                      </div>
                      <table className="w-full border-collapse">
                        <thead>
                          <tr>
                            <Th className="w-9"><span className="sr-only">Select</span></Th>
                            <Th>Medicine</Th>
                            <Th>Batch</Th>
                            <Th>Expiry</Th>
                            <Th align="right">On hand</Th>
                            <Th align="right">₹ {basis === 'cost' ? 'at cost' : 'at MRP'}</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map((row) => {
                            const on = selected.has(row.batch.id)
                            return (
                              <tr
                                key={row.batch.id}
                                aria-selected={on}
                                onClick={() => onOpen(row)}
                                className={cn(
                                  'cursor-default border-b border-border-subtle last:border-0',
                                  on ? 'bg-accent-3' : 'hover:bg-hover',
                                )}
                              >
                                <td className="px-[var(--cell-px)] py-1.5" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={on}
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
                                <td className="px-[var(--cell-px)] py-1.5">
                                  <ExpiryChip bucket={row.bucket} label={formatExpiry(row.batch.expiryDate)} />
                                </td>
                                <td className="num px-[var(--cell-px)] py-1.5 text-sm text-fg-muted">
                                  {formatQty(row.batch.qtyOnHand)}
                                </td>
                                <td className="num px-[var(--cell-px)] py-1.5 text-sm font-medium text-fg">
                                  {formatAmount(valueOf(row, basis))}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>

          <ScopeNote
            analysed={rows.length}
            total={total}
            filtered={filtered}
            {...(onSortByValue ? { onSortByValue } : {})}
          />
        </>
      )}
    </AnalysisShell>
  )
}
