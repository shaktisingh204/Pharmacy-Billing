import { useEffect, useRef } from 'react'
import { Trash2, TriangleAlert } from 'lucide-react'
import type { Quote, QuoteLine } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Kbd } from '@/components/ui/Kbd'
import { ScheduleChip } from '@/components/ui/Badge'
import { EmptyState } from '@/components/states'
import { useCart } from '@/store/cart'
import { BatchChips } from './BatchChips'
import { ScanBarcode } from 'lucide-react'

/**
 * The cart.
 *
 * Tab order across a row IS the billing workflow: qty, free, discount, then off
 * the end of the row, which commits the line, re-quotes, and returns focus to the
 * search box ready for the next scan. That single rule is what makes billing feel
 * fast; anything that forces a reach for the mouse breaks the rhythm.
 */
export function CartGrid({
  quote,
  today,
  onEscapeToSearch,
  onOpenBatchPicker,
}: {
  quote: Quote
  today: string
  onEscapeToSearch: () => void
  onOpenBatchPicker: (lineId: string) => void
}) {
  const ids = useCart((s) => s.ids)
  const byLine = new Map(quote.lines.map((l) => [l.lineId, l]))

  if (ids.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={ScanBarcode}
          title="Scan or search to start billing"
          body="Items land here with their batch and expiry already chosen by first-expiry-first-out."
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header />
      <div className="scroll-region min-h-0 flex-1" style={{ ['--pinned-h' as string]: '0px' }}>
        {ids.map((id, i) => (
          <Row
            key={id}
            index={i + 1}
            lineId={id}
            quoteLine={byLine.get(id)}
            today={today}
            onEscapeToSearch={onEscapeToSearch}
            onOpenBatchPicker={onOpenBatchPicker}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Batch and expiry are DELIBERATELY not columns.
 *
 * The chip strip under every row already shows batch, expiry, MRP and the split
 * quantity, and it is the control that opens the picker. Repeating them here cost
 * 144px of a centre pane that is only ~540px wide at the 1366x768 design floor —
 * which collapsed the medicine name to zero and painted the row over the totals
 * rail. The name is the one column that must never be squeezed.
 */
const COLS =
  'grid grid-cols-[28px_minmax(96px,1fr)_56px_44px_72px_52px_44px_92px_28px] items-center gap-1.5'

function Header() {
  return (
    <div className={cn(COLS, 'sticky top-0 z-10 h-8 border-y border-border-subtle bg-subtle px-2')}>
      <span className="micro-label text-center">#</span>
      <span className="micro-label">Medicine</span>
      <span className="micro-label text-right">Qty</span>
      <span className="micro-label text-right">Free</span>
      <span className="micro-label text-right">MRP</span>
      <span className="micro-label text-right">Disc %</span>
      <span className="micro-label text-right">GST %</span>
      <span className="micro-label text-right">Amount</span>
      <span />
    </div>
  )
}

function Row({
  index, lineId, quoteLine, today, onEscapeToSearch, onOpenBatchPicker,
}: {
  index: number
  lineId: string
  quoteLine: QuoteLine | undefined
  today: string
  onEscapeToSearch: () => void
  onOpenBatchPicker: (lineId: string) => void
}) {
  // Atomic selector: this row re-renders when ITS line changes, not when any does.
  const line = useCart((s) => s.byId[lineId])
  const focused = useCart((s) => s.focusedLineId === lineId)
  const setQty = useCart((s) => s.setQty)
  const setFreeQty = useCart((s) => s.setFreeQty)
  const setDiscount = useCart((s) => s.setDiscount)
  const removeLine = useCart((s) => s.removeLine)
  const focusLine = useCart((s) => s.focusLine)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' }) }, [focused])

  if (!line) return null

  const alloc = quoteLine?.allocations[0]
  const short = quoteLine && Number(quoteLine.shortQty) > 0
  const gstRate = alloc?.gstRatePct ?? '—'

  return (
    <div
      ref={rowRef}
      data-line-id={lineId}
      onFocusCapture={() => focusLine(lineId)}
      className={cn('relative border-b border-border-subtle', focused && 'bg-accent-3/40')}
    >
      {/* Active row is a bar PLUS a tint — never colour alone. */}
      {focused && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}

      <div className={cn(COLS, 'px-2')} style={{ height: 'var(--row-h)' }}>
        <span className="num text-center text-2xs text-fg-subtle">{index}</span>

        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium">{line.brandName}</span>
          <span className="shrink-0 text-2xs text-fg-subtle">{line.packLabel}</span>
          {quoteLine && <ScheduleChip code={quoteLine.drugSchedule} />}
          {short && (
            <span className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-warning-3 px-1.5 text-2xs font-medium text-warning-11">
              <TriangleAlert size={11} aria-hidden /> short {Number(quoteLine.shortQty)}
              <Kbd className="ml-0.5 h-4 border-warning-9/25 bg-warning-9/10 text-warning-11">S</Kbd>
            </span>
          )}
        </div>

        <Cell
          value={line.qty}
          onChange={(v) => setQty(lineId, v)}
          onLastTab={onEscapeToSearch}
          ariaLabel={`Quantity for ${line.brandName}`}
        />
        <Cell value={line.freeQty} onChange={(v) => setFreeQty(lineId, v)} ariaLabel={`Free quantity for ${line.brandName}`} />

        <span className="num text-base">{alloc ? formatAmount(alloc.mrpPerUnit) : '—'}</span>

        <Cell value={line.discountPct} onChange={(v) => setDiscount(lineId, v)} ariaLabel={`Discount for ${line.brandName}`} last onLastTab={onEscapeToSearch} />

        <span className="num text-base text-fg-muted">{gstRate}</span>
        <span className="num text-base font-medium">{quoteLine ? formatAmount(quoteLine.lineTotal) : '—'}</span>

        <button
          type="button"
          tabIndex={-1}
          onClick={() => removeLine(lineId)}
          aria-label={`Remove ${line.brandName}`}
          className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-danger-3 hover:text-danger-9"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>

      {quoteLine && (
        <BatchChips
          allocations={quoteLine.allocations}
          today={today}
          manual={quoteLine.manualBatch}
          activeIndex={0}
          onSelect={() => onOpenBatchPicker(lineId)}
        />
      )}
    </div>
  )
}

/**
 * An inline grid cell.
 *
 * Enter advances rather than submitting: a scanner's Enter suffix landing in a
 * quantity cell must never post the bill.
 */
function Cell({
  value, onChange, ariaLabel, last, onLastTab,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  last?: boolean
  onLastTab?: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <input
      ref={ref}
      value={value}
      aria-label={ariaLabel}
      inputMode="decimal"
      data-focus-inset
      onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        // Modified Enter belongs to the shortcut layer, not to this cell.
        // Ctrl+Enter is "go to payment" and it is pressed most often from right
        // here, immediately after correcting a quantity.
        if (e.ctrlKey || e.metaKey || e.altKey) return

        if (e.key === 'Enter') {
          e.preventDefault()
          if (last) onLastTab?.()
          else (e.currentTarget.closest('[data-line-id]')?.querySelectorAll('input')[1] as HTMLInputElement | undefined)?.focus()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          e.currentTarget.blur()
        } else if (e.key === 'Tab' && last && !e.shiftKey) {
          e.preventDefault()
          onLastTab?.()
        }
      }}
      className={cn(
        'num h-7 w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1',
        'hover:border-border-subtle hover:bg-surface focus:bg-surface',
      )}
    />
  )
}
