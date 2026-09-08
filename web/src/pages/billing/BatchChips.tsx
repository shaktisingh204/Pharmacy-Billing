import type { QuoteAllocation } from '@contract'
import { cn } from '@/lib/cn'
import { formatExpiry, formatMoney } from '@/lib/format'
import { expiryBucket } from '@/lib/expiry'

/**
 * The FEFO fan-out, rendered inline under the row it belongs to.
 *
 * Every Indian competitor hides batch selection behind a modal that costs three to
 * four seconds per line. Showing the allocation inline — and making it arrow-key
 * selectable — is the single most-felt difference at the counter, because the
 * pharmacist can see WHICH strip they are about to hand over without stopping.
 */
export function BatchChips({
  allocations,
  today,
  manual,
  activeIndex,
  onSelect,
}: {
  allocations: readonly QuoteAllocation[]
  today: string
  manual: boolean
  activeIndex: number
  onSelect?: (index: number) => void
}) {
  if (allocations.length === 0) return null

  return (
    <div className="flex h-7 items-center gap-1.5 overflow-x-auto pl-9 pr-2">
      {manual && (
        <span className="mono shrink-0 rounded-[var(--radius-sm)] bg-warning-3 px-1.5 text-2xs font-medium text-warning-11">
          MANUAL
        </span>
      )}
      {allocations.map((a, i) => {
        const bucket = expiryBucket(a.expiryDate, new Date(`${today}T00:00:00`))
        const active = i === activeIndex && allocations.length > 1
        return (
          <button
            key={a.batchId}
            type="button"
            tabIndex={-1}
            onClick={() => onSelect?.(i)}
            title={`Batch ${a.batchNo}, expires ${formatExpiry(a.expiryDate)}, MRP ${formatMoney(a.mrpPerUnit)} per unit — click or press F3 to change`}
            className={cn(
              'mono flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border px-1.5 text-2xs',
              active
                ? 'border-accent-6 bg-accent-3 text-accent-11'
                : 'border-border-subtle bg-subtle text-fg-muted hover:border-border',
            )}
          >
            <span className="font-medium">{a.batchNo}</span>
            <span
              style={{
                color:
                  bucket === 'expired' || bucket === 'd30' ? 'var(--status-expiry-30)'
                  : bucket === 'd60' ? 'var(--status-expiry-60)'
                  : bucket === 'd90' ? 'var(--status-expiry-90)'
                  : bucket === 'd180' ? 'var(--status-expiry-180)'
                  : undefined,
              }}
            >
              {formatExpiry(a.expiryDate)}
            </span>
            <span>{formatMoney(a.mrpPerUnit)}</span>
            <span className="text-fg-subtle">×{Number(a.qty)}</span>
            {/* A second printed MRP for the same brand is routine after a price
                revision. It is shown, never averaged away. */}
            {a.repricedFrom && (
              <span className="rounded-[var(--radius-sm)] bg-warning-3 px-1 text-warning-11">MRP↑</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
