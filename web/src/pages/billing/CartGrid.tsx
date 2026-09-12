import { useEffect, useRef } from 'react'
import { ChevronsDown, ChevronsUp, NotebookPen, Trash2, TriangleAlert } from 'lucide-react'
import type { Quote, QuoteLine } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import * as D from '@/domain/decimal'
import { Kbd } from '@/components/ui/Kbd'
import { ScheduleChip } from '@/components/ui/Badge'
import { useCart } from '@/store/cart'
import { BatchChips } from './BatchChips'

/**
 * The cart.
 *
 * Tab order across a row IS the billing workflow: qty, free, discount, then off
 * the end of the row, which commits the line, re-quotes, and returns focus to the
 * search box ready for the next scan. That single rule is what makes billing feel
 * fast; anything that forces a reach for the mouse breaks the rhythm.
 *
 * This grid keeps `pos` density while the chrome around it opened up. Twenty
 * lines above the fold at 1366x768 is the constraint the whole screen is built
 * around, and it is the one place in the app where more air would cost the
 * operator a scroll mid-bill.
 */
export function CartGrid({
  quote,
  today,
  noteLineId,
  onOpenNote,
  onNoteDone,
  onEscapeToSearch,
  onOpenBatchPicker,
}: {
  quote: Quote
  today: string
  /** The row whose dispensing instruction is open for editing (Alt+M). */
  noteLineId: string | null
  onOpenNote: (lineId: string) => void
  /** `returnFocus` only when the operator finished deliberately — Enter or Esc. */
  onNoteDone: (returnFocus: boolean) => void
  onEscapeToSearch: () => void
  onOpenBatchPicker: (lineId: string) => void
}) {
  const ids = useCart((s) => s.ids)
  const byLine = new Map(quote.lines.map((l) => [l.lineId, l]))

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
            editingNote={noteLineId === id}
            onOpenNote={onOpenNote}
            onNoteDone={onNoteDone}
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
/*
 * Every fixed column is as narrow as its widest real value and not a pixel
 * wider. At the 1366 floor the centre pane is ~710px and the name cell has to
 * carry a brand, a pack, a schedule chip AND the batch/expiry the pharmacist
 * checks against the strip in their hand — so the numeric columns give up what
 * they can and the name cell divides the rest by priority (see the row).
 */
const COLS =
  'grid grid-cols-[26px_minmax(120px,1fr)_54px_40px_66px_46px_38px_86px_46px] items-center gap-1.5'

function Header() {
  return (
    /* `whitespace-nowrap` is load-bearing, not tidiness: a wrapped header label
       doubles the header's height and pushes a cart row below the fold. */
    <div className={cn(COLS, 'sticky top-0 z-10 h-8 border-b border-border bg-subtle px-2 [&>span]:whitespace-nowrap')}>
      <span className="micro-label text-center">#</span>
      <span className="micro-label">Medicine</span>
      <span className="micro-label text-right">Qty</span>
      <span className="micro-label text-right">Free</span>
      <span className="micro-label text-right">MRP</span>
      <span className="micro-label text-right">Disc%</span>
      <span className="micro-label text-right">GST%</span>
      <span className="micro-label text-right">Amount</span>
      <span />
    </div>
  )
}

function Row({
  index, lineId, quoteLine, today, editingNote, onOpenNote, onNoteDone,
  onEscapeToSearch, onOpenBatchPicker,
}: {
  index: number
  lineId: string
  quoteLine: QuoteLine | undefined
  today: string
  editingNote: boolean
  onOpenNote: (lineId: string) => void
  onNoteDone: (returnFocus: boolean) => void
  onEscapeToSearch: () => void
  onOpenBatchPicker: (lineId: string) => void
}) {
  // Atomic selector: this row re-renders when ITS line changes, not when any does.
  const line = useCart((s) => s.byId[lineId])
  const focused = useCart((s) => s.focusedLineId === lineId)
  const setQty = useCart((s) => s.setQty)
  const setFreeQty = useCart((s) => s.setFreeQty)
  const setDiscount = useCart((s) => s.setDiscount)
  const setLineNote = useCart((s) => s.setLineNote)
  const removeLine = useCart((s) => s.removeLine)
  const focusLine = useCart((s) => s.focusLine)
  const rowRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' }) }, [focused])
  useEffect(() => {
    if (editingNote) {
      noteRef.current?.focus()
      noteRef.current?.select()
    }
  }, [editingNote])

  if (!line) return null

  const alloc = quoteLine?.allocations[0]
  const short = quoteLine && Number(quoteLine.shortQty) > 0
  const gstRate = alloc?.gstRatePct ?? '—'

  /* Whether this line is being billed at something other than the chain's price.
     Compared through the decimal engine, so "7" and "7.00" are the same figure —
     a marker that fired on a re-typed identical number would be noise. */
  const offPolicy: 'over' | 'under' | null = (() => {
    /* Read defensively: this cell is mid-typing. `D.dec` throws on "1." and on
       a stray letter, and a grid that crashes while somebody keys a discount is
       far worse than a marker that waits a keystroke for a readable number. */
    let applied: D.Decimal
    let policy: D.Decimal
    try {
      applied = D.dec(line.discountPct.trim() || '0')
      policy = D.dec(line.policyPct.trim() || '0')
    } catch {
      return null
    }
    if (D.eq(applied, policy)) return null
    return D.gt(applied, policy) ? 'over' : 'under'
  })()

  return (
    <div
      ref={rowRef}
      data-line-id={lineId}
      onFocusCapture={() => focusLine(lineId)}
      className={cn('relative border-b border-border-subtle', focused && 'bg-accent-3/40')}
    >
      {/* Active row is a bar PLUS a tint — never colour alone. */}
      {focused && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}

      <div className={cn(COLS, 'px-2')} style={{ height: 'var(--cart-row-h, var(--row-h))' }}>
        <span className="num text-center text-2xs text-fg-subtle">{index}</span>

        <div className="flex min-w-0 items-center gap-1.5">
          {/*
            The name wins the squeeze. Both it and the batch chip can shrink,
            but the batch shrinks twice as fast from a smaller basis, so a
            narrow pane eats into a traceability code before it eats into the
            one string the operator is reading to confirm the right box came off
            the shelf. Pack and schedule are already at their natural width.
          */}
          <span className="min-w-0 flex-[1_1_120px] truncate text-base font-medium">{line.brandName}</span>
          <span className="shrink-0 text-2xs text-fg-subtle">{line.packLabel}</span>
          {quoteLine && <ScheduleChip code={quoteLine.drugSchedule} />}
          {alloc && quoteLine && quoteLine.allocations.length === 1 && !quoteLine.manualBatch && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onOpenBatchPicker(lineId)}
              title="Change batch (F3)"
              className="mono min-w-0 flex-[0_2_92px] truncate rounded-[var(--radius-sm)] px-1 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
            >
              {alloc.batchNo} · {alloc.expiryDate.slice(5, 7)}/{alloc.expiryDate.slice(2, 4)}
            </button>
          )}
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

        <span className="relative flex items-center justify-end gap-1">
          <Cell value={line.discountPct} onChange={(v) => setDiscount(lineId, v)} ariaLabel={`Discount for ${line.brandName}`} last onLastTab={onEscapeToSearch} />
          {/* Only when it DIFFERS from the chain's list. A marker on every line
              is a marker nobody reads; this one means "somebody changed the
              price", which is the only version of it worth a glance. Icon and a
              title, never the tint alone — this is a matte panel at an angle. */}
          {offPolicy !== null && (
            <span
              className={cn(
                'flex shrink-0 items-center',
                offPolicy === 'over' ? 'text-warning-11' : 'text-fg-subtle',
              )}
              title={offPolicy === 'over'
                ? `Deeper than the chain's ${line.policyPct}% — the difference is this counter's own`
                : `Less than the chain's ${line.policyPct}%`}
            >
              {offPolicy === 'over'
                ? <ChevronsUp size={13} aria-hidden />
                : <ChevronsDown size={13} aria-hidden />}
              <span className="sr-only">
                {offPolicy === 'over' ? 'Above' : 'Below'} the chain price list of {line.policyPct}%
              </span>
            </span>
          )}
        </span>

        <span className="num text-base text-fg-muted">{gstRate}</span>
        <span className="num text-base font-medium">{quoteLine ? formatAmount(quoteLine.lineTotal) : '—'}</span>

        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            tabIndex={-1}
            onClick={() => (editingNote ? onNoteDone(false) : onOpenNote(lineId))}
            aria-label={`${line.note ? 'Edit' : 'Add'} dispensing instruction for ${line.brandName}`}
            title="Dispensing instruction (Alt+M)"
            className={cn(
              'flex size-6 items-center justify-center rounded-[var(--radius-sm)] hover:bg-hover',
              line.note ? 'text-accent-11' : 'text-fg-subtle hover:text-fg',
            )}
          >
            <NotebookPen size={14} aria-hidden />
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => removeLine(lineId)}
            aria-label={`Remove ${line.brandName}`}
            className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-danger-3 hover:text-danger-9"
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </span>
      </div>

      {/*
        The instruction the customer is actually going to follow.
        It only takes height when there IS one — "1-0-1 after food" is written on
        maybe two lines of a twenty-line bill, and a permanently reserved strip
        would cost the cart a screen's worth of rows for the other eighteen.
      */}
      {(editingNote || line.note) && (
        <div className="flex items-start gap-1.5 border-t border-border-subtle bg-subtle/60 px-2 py-1 pl-8">
          <NotebookPen size={12} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
          {editingNote ? (
            <textarea
              ref={noteRef}
              rows={1}
              value={line.note ?? ''}
              onChange={(e) => setLineNote(lineId, e.target.value)}
              /* A blur closes the editor but must NOT pull focus back to search:
                 the operator may be on their way to the quantity cell next door. */
              onBlur={() => onNoteDone(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onNoteDone(true)
                } else if (e.key === 'Escape') {
                  // Stops here, exactly as a cell's Escape does: the billing
                  // scope's Escape steps the whole bill back a stage.
                  e.stopPropagation()
                  onNoteDone(true)
                }
              }}
              placeholder="1-0-1 after food, half tablet for the child…"
              aria-label={`Dispensing instruction for ${line.brandName}`}
              className="min-w-0 flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 py-0.5 text-xs leading-5"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{line.note}</span>
          )}
        </div>
      )}

      {/*
        The chip strip only earns its 28px when there is a CHOICE to see.
        A single-batch line spends that height restating one batch number, which on
        a twenty-line bill is 560px of nothing — over a screen's worth on the
        1366x768 floor. One batch renders inline on the row instead; a FEFO split,
        a manual override or a repriced batch still gets the full strip, because
        those are the cases the strip exists for.
      */}
      {quoteLine && (quoteLine.allocations.length > 1 || quoteLine.manualBatch) && (
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
