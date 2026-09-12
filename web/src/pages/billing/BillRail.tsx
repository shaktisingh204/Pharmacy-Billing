import { useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, CircleAlert, CircleCheck, NotebookPen, ShieldAlert,
} from 'lucide-react'
import type { Quote } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatQty } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { useHotkeys } from '@/hooks/useHotkeys'

/**
 * The bill rail: everything the operator confirms before taking money.
 *
 * The payment panel replaces this IN PLACE, so the two share a width and a
 * rhythm — a column that resized between cart and tender would slide the grid
 * sideways at the exact moment the customer is being told the total.
 *
 * COMPACT is still the brief for the SCROLLING part. What changed is the
 * hierarchy: the grand total is now a display figure rather than one more line
 * in a list of eight, because it is the one number on this screen that both
 * people at the counter are looking at. Everything above it is reference and
 * reads like reference.
 *
 * On the 1366x768 floor the total, the tax split and Pay must all be above the
 * fold with a customer, a prescriber warning and a five-rate breakup on screen
 * at once, so every reference row here is a single line and the breakup folds
 * itself away once it stops fitting.
 */

/**
 * Height of the pinned block, so `.scroll-region` can keep a focused row out
 * from under it (WCAG 2.2 SC 2.4.11). Derived from the tokens the block is
 * built out of — p-3 top and bottom, the label, the 4xl total line, its gap,
 * and the 48px Pay button — rather than measured, because a ResizeObserver here
 * would report the height one paint AFTER the row it is meant to protect has
 * already scrolled.
 */
const PINNED_H =
  'calc(2 * var(--space-3) + var(--leading-2xs) + var(--leading-4xl) + var(--space-2) + var(--space-12))'

/** Compliance and warning strips share one geometry so they stack evenly. */
const STRIP =
  'mt-2 flex gap-1.5 rounded-[var(--radius-md)] border px-2 py-1.5 text-xs'

const isZero = (money: string): boolean => D.isZero(D.dec(money))

/**
 * What the field HOLDS: digits, at most one dot, clamped to 100. Not necessarily
 * a decimal — '7.' and '.5' are keystrokes on the way to '7.5', and a field that
 * cannot hold them cannot be used to type a decimal percentage at all.
 */
function cleanPct(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '').replace(/(\.\d*)\./g, '$1')
  return D.gt(D.dec(quotablePct(cleaned)), D.HUNDRED) ? '100' : cleaned
}

/**
 * What the field MEANS, and a STRING throughout: the percentage is never
 * multiplied out here, because a second implementation of the discount is a
 * second answer for the printed bill to disagree with.
 *
 * Every half-typed form is mapped rather than passed on. D.dec THROWS on '7.',
 * on '.5' and on '', and a throw out of onChange is not a rejected keystroke —
 * it unmounts the screen and takes the bill with it.
 */
function quotablePct(pct: string): string {
  const body = pct.endsWith('.') ? pct.slice(0, -1) : pct
  if (body === '') return '0'
  return body.startsWith('.') ? `0${body}` : body
}

export function BillRail({
  quote, quoteError, itemCount, hasH1, prescriptionDone, onPrescription,
  billDiscountPct, onBillDiscount, billNote, onBillNote, billNoteRef, onPay, discountRef,
}: {
  quote: Quote
  quoteError: Error | null
  itemCount: number
  /** Compliance strip: the cart holds Schedule H1 lines. */
  hasH1: boolean
  prescriptionDone: boolean
  onPrescription: () => void
  billDiscountPct: string
  onBillDiscount: (pct: string) => void
  /** A remark carried onto the saved bill and shown on the customer display. */
  billNote: string
  onBillNote: (note: string) => void
  /** Focus target for Alt+M outside the grid. */
  billNoteRef?: React.RefObject<HTMLInputElement | null>
  onPay: () => void
  /** Focus target for F4 (bill discount). */
  discountRef?: React.RefObject<HTMLInputElement | null>
}) {
  const fallbackRef = useRef<HTMLInputElement>(null)
  const inputRef = discountRef ?? fallbackRef

  /* The prop is the PRICED percentage, so a controlled field reading it straight
     back can never hold a trailing dot: '7.' quotes as 7 and returns as '7', and
     the operator can never type '7.5'. The draft holds the keystroke, and the
     prop takes the field back the moment the two stop meaning the same number —
     which is how starting a new bill clears a discount left mid-edit. */
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null && quotablePct(draft) !== billDiscountPct) setDraft(null)

  /* The F4 hint has to be true. The billing screen owns the key whenever it hands
     the rail a focus target; when it does not, the rail claims F4 itself rather
     than printing a shortcut nobody has bound. Two 'billing' bindings for one id
     would fight and the child would silently win, so this is `enabled` and not a
     guard inside the handler. */
  useHotkeys('billing', {
    'bill.discount': () => { inputRef.current?.focus(); inputRef.current?.select() },
  }, { enabled: discountRef === undefined })

  const interState = !isZero(quote.igst)
  /*
   * Blocking warnings gate Pay, not just the red strip.
   *
   * postSale rejects any non-H1 blocking warning, so leaving Pay enabled walked
   * the operator all the way through tendering cash before refusing the bill —
   * money in the drawer and nothing to hand over. SCHEDULE_H1 is already excluded
   * from `blocking`; the compliance strip owns that case and resolves it.
   */
  const blocking = quote.warnings.filter((w) => w.blocking && w.code !== 'SCHEDULE_H1')
  const canPay = quote.lines.length > 0 && quoteError === null && blocking.length === 0
  const units = D.toStr(D.sum(quote.lines.map((l) => D.dec(l.allocatedQty))), 3)
  const saved = D.add(D.dec(quote.itemDiscount), D.dec(quote.billDiscount))

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface 2xl:w-[380px]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle bg-raised px-3">
        <h2 className="text-sm font-semibold tracking-tight">This bill</h2>
        <span className="text-2xs text-fg-muted">
          <span className="num">{itemCount}</span> {itemCount === 1 ? 'item' : 'items'} ·{' '}
          <span className="num">{formatQty(units)}</span> units
        </span>
      </div>

      <div
        className="scroll-region min-h-0 flex-1 px-3 pb-3 pt-1"
        style={{ ['--pinned-h' as string]: PINNED_H }}
      >
        {quoteError && (
          <div data-testid="quote-error" role="alert" className={cn(STRIP, 'border-danger-9/25 bg-danger-3 text-danger-11')}>
            <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">Could not be priced.</strong> {quoteError.message}{' '}
              Do not take payment.
            </span>
          </div>
        )}

        {hasH1 && (
          <button
            type="button"
            onClick={onPrescription}
            className={cn(
              STRIP, 'w-full items-center text-left',
              prescriptionDone
                ? 'border-success-9/25 bg-success-3 text-success-11'
                : 'border-schedule-h1/30 hover:border-schedule-h1/60',
            )}
            /* The H1 tint has no Tailwind colour of its own — it is a schedule
               token, mixed here rather than added to the palette as a one-off. */
            style={prescriptionDone ? undefined : {
              backgroundColor: 'color-mix(in srgb, var(--schedule-h1) 10%, transparent)',
              color: 'var(--schedule-h1)',
            }}
          >
            {prescriptionDone
              ? <CircleCheck size={13} className="shrink-0" aria-hidden />
              : <ShieldAlert size={13} className="shrink-0" aria-hidden />}
            <span className="flex-1 truncate">
              {prescriptionDone ? 'Schedule H1 recorded' : 'Schedule H1 — record prescriber'}
            </span>
            <Kbd>Alt+O</Kbd>
          </button>
        )}

        {blocking.map((w, i) => (
          <div
            key={`${w.code}:${w.lineId ?? i}`}
            role="alert"
            className={cn(STRIP, 'border-danger-9/25 bg-danger-3 text-danger-11')}
          >
            <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
            <span>{w.message}</span>
          </div>
        ))}

        <div className="mt-2 flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2">
          <label htmlFor="bill-discount" className="micro-label flex-1">Bill discount</label>
          <input
            id="bill-discount"
            ref={inputRef}
            value={draft ?? billDiscountPct}
            inputMode="decimal"
            onChange={(e) => {
              const next = cleanPct(e.target.value)
              setDraft(next)
              onBillDiscount(quotablePct(next))
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            className="num h-7 w-12 rounded-[var(--radius-sm)] border border-border bg-surface px-1 text-sm"
          />
          <span className="text-xs text-fg-muted">%</span>
          <Kbd>F4</Kbd>
        </div>

        {/*
          The remark that follows the bill off the counter.
          It is printed on the receipt and shown on the customer's screen, which
          is why it is a field on the rail and not a sticky note on the monitor:
          "deliver at 6", "son will collect the balance" and "cash paid by the
          neighbour" are the three things a counter forgets between customers.
        */}
        <div className="mt-2 flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2">
          <NotebookPen size={14} className="shrink-0 text-fg-subtle" aria-hidden />
          <input
            id="bill-note"
            ref={billNoteRef}
            value={billNote}
            onChange={(e) => onBillNote(e.target.value)}
            /* Named on the control itself: the only thing that could carry a
               <label for> here is the icon, and an aria-hidden glyph gives an
               input no accessible name at all. */
            aria-label="Bill remark"
            placeholder="Bill remark — delivery, who collects, what to tell them"
            maxLength={140}
            className="h-7 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1 text-xs placeholder:text-fg-subtle hover:border-border focus:border-border focus:bg-surface"
          />
          <Kbd>Alt+M</Kbd>
        </div>

        <TaxBreakup quote={quote} interState={interState} />

        <div className="mt-3 border-t border-border-subtle pt-2">
          <Line label="Gross" value={quote.grossAmount} testid="total-gross" />
          {/* A zero discount line is noise on a rail this tight. Round off is the
              one exception below: an unexplained rupee is the most common counter
              dispute there is, and a missing line is what makes it unexplained. */}
          {!isZero(quote.itemDiscount) && <Line label="Item discount" value={`-${quote.itemDiscount}`} tone="success" />}
          {!isZero(quote.billDiscount) && <Line label={`Bill discount ${quote.billDiscountPct}%`} value={`-${quote.billDiscount}`} tone="success" />}
          <Line label="Taxable" value={quote.taxableValue} muted testid="total-taxable" />
          {interState
            ? <Line label="IGST" value={quote.igst} muted testid="total-igst" />
            : <><Line label="CGST" value={quote.cgst} muted testid="total-cgst" /><Line label="SGST" value={quote.sgst} muted testid="total-sgst" /></>}
          <Line label="Round off" value={quote.roundOff} muted testid="total-roundoff" />
        </div>

        {/* The customer hears this figure across the counter; it is worth a line. */}
        {D.gt(saved, D.ZERO) && (
          <p className="mt-2 flex items-center justify-between rounded-[var(--radius-md)] bg-success-3 px-2 py-1 text-xs font-medium text-success-11">
            <span>Customer saves</span>
            <span className="num">{formatAmount(D.toStr(saved))}</span>
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-raised p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="micro-label">Total payable</span>
          {isZero(quote.roundOff) ? null : (
            <span className="text-2xs text-fg-subtle">rounded</span>
          )}
        </div>
        {/* A till must never display a total it did not compute. */}
        <div className="mt-1 text-right" data-testid="total-net">
          {quoteError
            ? <span className="text-2xl font-semibold text-danger-11">Unpriced</span>
            : (
              <span className="display-num text-4xl">
                <span className="mr-0.5 text-[0.5em] font-medium text-fg-muted">₹</span>
                {formatAmount(quote.netAmount)}
              </span>
            )}
        </div>
        <Button variant="primary" size="xl" className="mt-2 w-full" disabled={!canPay} onClick={onPay}>
          Pay
          <Kbd className="border-transparent bg-white text-accent-11">Ctrl ↵</Kbd>
        </Button>
      </div>
    </aside>
  )
}

/**
 * The rate-wise breakup, one row per DISTINCT rate: a real pharmacy bill mixes
 * nil-rated ORS, 5% medicines and 18% nutraceuticals and the filing needs them
 * apart. Past three rates it collapses — five rows of table between the operator
 * and the grand total is how the total ends up below the fold.
 */
function TaxBreakup({ quote, interState }: { quote: Quote; interState: boolean }) {
  const rates = quote.taxBreakup.length
  /* null means "nobody has decided yet", so the default keeps tracking the cart
     as rates come and go, and one click still pins it open for the rest of the bill. */
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? rates <= 3

  if (rates === 0) return null
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <div className="mt-2 overflow-hidden rounded-[var(--radius-md)] border border-border-subtle">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
        /* Flush inside the rounded, overflow-hidden frame, so an offset ring is
           clipped away to nothing and the control looks unfocusable. */
        data-focus-inset
        className="flex h-7 w-full items-center gap-1 bg-subtle px-2 hover:bg-inset"
      >
        <Chevron size={12} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="micro-label">GST breakup ({rates} {rates === 1 ? 'rate' : 'rates'})</span>
      </button>

      {expanded && (
        <div>
          <div className={cn(gstCols(interState), 'border-t border-border-subtle px-2 py-1')}>
            <span className="micro-label">Rate</span>
            <span className="micro-label text-right">Taxable</span>
            <span className="micro-label text-right">{interState ? 'IGST' : 'CGST'}</span>
            {!interState && <span className="micro-label text-right">SGST</span>}
          </div>
          {quote.taxBreakup.map((r) => (
            <div
              key={r.gstRatePct}
              data-testid="gst-row"
              className={cn(gstCols(interState), 'border-t border-border-subtle px-2 py-0.5 text-2xs')}
            >
              <span className="num text-left">{r.gstRatePct}%</span>
              <span className="num">{formatAmount(r.taxableValue)}</span>
              <span className="num">{formatAmount(interState ? r.igst : r.cgst)}</span>
              {!interState && <span className="num">{formatAmount(r.sgst)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** IGST drops a column rather than leaving an empty one holding the width open. */
function gstCols(interState: boolean): string {
  return interState
    ? 'grid grid-cols-[34px_1fr_1fr] items-center gap-1'
    : 'grid grid-cols-[34px_1fr_1fr_1fr] items-center gap-1'
}

function Line({ label, value, muted, tone, testid }: {
  label: string
  value: string
  muted?: boolean
  tone?: 'success'
  testid?: string
}) {
  return (
    <div className="flex h-6 items-baseline justify-between gap-2 text-xs" data-testid={testid}>
      <span className={cn('truncate', muted ? 'text-fg-muted' : 'text-fg')}>{label}</span>
      <span className={cn('num', muted && 'text-fg-muted', tone === 'success' && 'text-success-11')}>
        {formatAmount(value)}
      </span>
    </div>
  )
}
