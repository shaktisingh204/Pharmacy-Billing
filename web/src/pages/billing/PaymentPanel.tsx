import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Banknote, CreditCard, Eraser, Landmark, Plus, QrCode, Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaymentInput, PaymentMode, Quote } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { amountInWords, changeBreakdown, TENDER_DENOMINATIONS } from '@/lib/words'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { useHotkeys } from '@/hooks/useHotkeys'

/**
 * Tender.
 *
 * This REPLACES the totals block in place rather than opening a modal. A modal at
 * the moment of payment covers the bill the customer is looking at, and every
 * dismissal costs a keystroke; the operator's eyes and hands both stay where they
 * already are.
 *
 * The three things this screen is for, in order of how often they go wrong at an
 * Indian counter:
 *  1. Counting the notes handed over. The pad tallies them, so "he gave me two
 *     five-hundreds and a hundred" is a fact on screen rather than a memory.
 *  2. Counting the change back. The figure is spelled out AND broken into the
 *     notes to pull, which is the step a queue actually watches.
 *  3. Splitting. Half UPI, half cash is the normal case, not the exception, and
 *     each leg carries its own reference for the day's reconciliation.
 */

const MODES: Array<{ mode: PaymentMode; label: string; icon: LucideIcon; key: string }> = [
  { mode: 'CASH', label: 'Cash', icon: Banknote, key: '1' },
  { mode: 'UPI', label: 'UPI', icon: QrCode, key: '2' },
  { mode: 'CARD', label: 'Card', icon: CreditCard, key: '3' },
  { mode: 'CREDIT', label: 'Khata', icon: Landmark, key: '4' },
]

/** The four the Alt accelerators cover, so the pad and the cheat sheet agree. */
const DENOM_KEY: Record<number, string> = { 500: 'Alt+5', 200: 'Alt+2', 100: 'Alt+1', 50: 'Alt+0' }

/** A reference is meaningful for these and noise for cash. */
const NEEDS_REFERENCE: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['UPI', 'CARD'])

export function PaymentPanel({
  quote, onBack, onComplete, busy, allowCredit, submitRef,
}: {
  quote: Quote
  onBack: () => void
  onComplete: (payments: PaymentInput[]) => void
  busy: boolean
  allowCredit: boolean
  /**
   * Save is declared in the BILLING scope (Ctrl+S / NumpadEnter), so it cannot be
   * bound from here — a scope only ever sees its own shortcuts plus global. The
   * panel publishes its submit through this ref and the billing screen invokes it.
   */
  submitRef: React.RefObject<(() => void) | null>
}) {
  const net = D.dec(quote.netAmount)
  const [rows, setRows] = useState<PaymentInput[]>([{ mode: 'CASH', amount: quote.netAmount }])
  /**
   * What was physically handed over, note by note.
   *
   * Kept ALONGSIDE the amount rather than instead of it: the amount is the truth
   * that gets posted, and the tally is only a description of how it was reached.
   * The moment the operator types over the figure the description is no longer
   * true, so it is dropped rather than left to disagree with the total.
   */
  const [tally, setTally] = useState<Record<number, number>>({})
  const tenderRef = useRef<HTMLInputElement>(null)

  useEffect(() => { tenderRef.current?.focus(); tenderRef.current?.select() }, [])

  const paid = useMemo(() => D.sum(rows.map((r) => D.dec(r.amount || '0'))), [rows])
  const balance = D.sub(net, paid)
  const change = D.max(D.neg(balance), D.ZERO)
  const hasCredit = rows.some((r) => r.mode === 'CREDIT')
  const settled = hasCredit || D.gte(paid, net)
  const changeStr = D.toStr(change)
  /* Not memoised: nine iterations over a fixed denomination list is cheaper
     than the dependency check, and a useMemo here defeats the compiler's own. */
  const notesBack = changeBreakdown(changeStr)

  function setRow(i: number, patch: Partial<PaymentInput>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  function typeAmount(i: number, raw: string) {
    setRow(i, { amount: raw.replace(/[^\d.]/g, '') })
    if (i === 0) setTally({})
  }

  function addSplit() {
    // Auto-fill the remainder: the operator's next action is always "and the rest
    // on the other method", so typing it again is pure friction.
    const remaining = D.max(balance, D.ZERO)
    setRows((rs) => [...rs, { mode: 'UPI', amount: D.toStr(remaining) }])
  }

  function addDenom(n: number) {
    setRows((rs) => {
      const first = rs[0]
      if (!first) return rs
      const next = D.add(D.dec(first.amount || '0'), D.dec(n))
      return [{ ...first, amount: D.toStr(next) }, ...rs.slice(1)]
    })
    setTally((t) => ({ ...t, [n]: (t[n] ?? 0) + 1 }))
  }

  function exact() {
    setRow(0, { amount: quote.netAmount })
    setTally({})
  }

  function clearTender() {
    setRow(0, { amount: '0' })
    setTally({})
    tenderRef.current?.focus()
  }

  /* Scoped to 'payment', which is narrower than 'billing', so these win while the
     panel is open and release the keys the moment it closes. Wiring them to the
     panel's own onKeyDown instead would make them dead whenever focus sat
     anywhere else on the screen — including the tender field's own container. */
  useHotkeys('payment', {
    'payment.cash': () => setRow(0, { mode: 'CASH' }),
    'payment.upi': () => setRow(0, { mode: 'UPI' }),
    'payment.card': () => setRow(0, { mode: 'CARD' }),
    'payment.credit': () => { if (allowCredit) setRow(0, { mode: 'CREDIT' }) },
    'payment.exact': exact,
    'payment.split': addSplit,
    'payment.note500': () => addDenom(500),
    'payment.note200': () => addDenom(200),
    'payment.note100': () => addDenom(100),
    'payment.note50': () => addDenom(50),
    'escape': onBack,
  })

  useEffect(() => {
    submitRef.current = () => { if (settled && !busy) onComplete(rows) }
    return () => { submitRef.current = null }
  })

  const primary = rows[0]
  const tallyEntries = TENDER_DENOMINATIONS
    .map((d) => ({ value: d, count: tally[d] ?? 0 }))
    .filter((e) => e.count > 0)

  return (
    <div className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface 2xl:w-[380px]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle bg-raised px-3">
        <h2 className="text-sm font-semibold tracking-tight">Payment</h2>
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg">
          Back to cart <Kbd>Esc</Kbd>
        </button>
      </div>

      <div className="scroll-region min-h-0 flex-1 px-3 pb-3 pt-2">
        <div className="grid grid-cols-4 gap-1.5">
          {MODES.map((m) => {
            const active = primary?.mode === m.mode
            const disabled = m.mode === 'CREDIT' && !allowCredit
            return (
              <button
                key={m.mode}
                type="button"
                disabled={disabled}
                onClick={() => setRow(0, { mode: m.mode })}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border text-2xs font-medium',
                  'transition-colors duration-[var(--dur-fast)]',
                  active ? 'border-accent-9 bg-accent-3 text-accent-11' : 'border-border bg-surface hover:border-border-strong hover:bg-hover',
                  disabled && 'cursor-not-allowed opacity-40',
                )}
                title={disabled ? 'Attach a customer to bill on khata' : undefined}
              >
                <m.icon size={20} aria-hidden />
                <span>{m.label}</span>
                <Kbd className="h-4">{m.key}</Kbd>
              </button>
            )
          })}
        </div>

        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <label className="micro-label" htmlFor="tender">
              {primary?.mode === 'CREDIT' ? 'On account' : 'Tendered'}
            </label>
            <button
              type="button"
              onClick={exact}
              className="flex items-center gap-1 text-2xs text-fg-muted hover:text-fg"
            >
              Exact <Kbd>E</Kbd>
            </button>
          </div>
          <input
            id="tender"
            ref={tenderRef}
            value={primary?.amount ?? ''}
            inputMode="decimal"
            onChange={(e) => typeAmount(0, e.target.value)}
            className="num mt-1 h-14 w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-3xl font-semibold"
          />
        </div>

        {/*
          The denomination pad.
          A counter does not type "700"; it counts a five-hundred and two
          hundreds onto the tray. Tapping what was actually handed over is both
          faster and auditable — and it is the input the change breakdown below
          is checking itself against.
        */}
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {TENDER_DENOMINATIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => addDenom(d)}
              className={cn(
                'relative flex h-11 items-center justify-center rounded-[var(--radius-md)] border border-border',
                'bg-surface text-base font-medium hover:border-border-strong hover:bg-hover',
              )}
            >
              <span className="num">+{d}</span>
              {DENOM_KEY[d] && (
                <span className="absolute right-1 top-0.5 text-[9px] leading-none text-fg-subtle">
                  {DENOM_KEY[d]}
                </span>
              )}
            </button>
          ))}
        </div>

        {tallyEntries.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2 py-1.5">
            <span className="micro-label">Counted</span>
            {tallyEntries.map((e) => (
              <span key={e.value} className="num rounded-[var(--radius-sm)] bg-surface px-1.5 text-2xs text-fg-muted">
                {e.count} × ₹{e.value}
              </span>
            ))}
            <button
              type="button"
              onClick={clearTender}
              aria-label="Clear the counted notes"
              className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle hover:text-danger-9"
            >
              <Eraser size={12} aria-hidden /> Clear
            </button>
          </div>
        )}

        {primary && NEEDS_REFERENCE.has(primary.mode) && (
          <input
            value={primary.reference ?? ''}
            onChange={(e) => setRow(0, { reference: e.target.value })}
            aria-label={`${primary.mode === 'UPI' ? 'UPI' : 'Card'} reference`}
            placeholder={primary.mode === 'UPI' ? 'UPI reference (last 6 digits)' : 'Card — last 4 digits'}
            className="mono mt-2 h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2 text-xs"
          />
        )}

        {rows.slice(1).map((r, i) => (
          <div key={i + 1} className="mt-2 rounded-[var(--radius-md)] border border-border-subtle bg-subtle p-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={r.mode}
                onChange={(e) => setRow(i + 1, { mode: e.target.value as PaymentMode })}
                aria-label={`Split ${i + 2} method`}
                className="h-9 rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-xs"
              >
                {MODES.filter((m) => m.mode !== 'CREDIT' || allowCredit).map((m) => (
                  <option key={m.mode} value={m.mode}>{m.label}</option>
                ))}
              </select>
              <input
                value={r.amount}
                inputMode="decimal"
                aria-label={`Split ${i + 2} amount`}
                onChange={(e) => typeAmount(i + 1, e.target.value)}
                className="num h-9 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-sm"
              />
              <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i + 1))}
                aria-label={`Remove split ${i + 2}`} className="shrink-0 text-fg-subtle hover:text-danger-9">
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            {NEEDS_REFERENCE.has(r.mode) && (
              <input
                value={r.reference ?? ''}
                onChange={(e) => setRow(i + 1, { reference: e.target.value })}
                aria-label={`Split ${i + 2} reference`}
                placeholder={r.mode === 'UPI' ? 'UPI reference' : 'Card — last 4 digits'}
                className="mono mt-1.5 h-8 w-full rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-2xs"
              />
            )}
          </div>
        ))}

        <button type="button" onClick={addSplit}
          className="mt-2 flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg">
          <Plus size={14} aria-hidden /> Split payment <Kbd>Num −</Kbd>
        </button>
      </div>

      <div className="shrink-0 border-t border-border bg-raised p-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-fg-muted">Bill total</span>
          <span className="num font-medium">{formatAmount(quote.netAmount)}</span>
        </div>
        {D.gt(balance, D.ZERO) && !hasCredit && (
          <div className="mt-1 flex items-baseline justify-between text-xs text-danger-11">
            <span>Still due</span>
            <span className="num font-medium">{formatAmount(D.toStr(balance))}</span>
          </div>
        )}
        {hasCredit && (
          <div className="mt-1 flex items-baseline justify-between text-xs text-warning-11">
            <span>Going on khata</span>
            <span className="num font-medium">
              {formatAmount(D.toStr(D.sum(rows.filter((r) => r.mode === 'CREDIT').map((r) => D.dec(r.amount || '0')))))}
            </span>
          </div>
        )}

        {D.gt(change, D.ZERO) && (
          <div className="mt-2 rounded-[var(--radius-lg)] border border-success-9/25 bg-success-3 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-success-11">Change due</span>
              <span className="display-num text-4xl text-success-11">{formatAmount(changeStr)}</span>
            </div>
            {/* Spelled out for the same reason a cheque is: two people are about
                to agree on this number out loud, across a counter, in a queue. */}
            <p className="mt-1 text-2xs leading-snug text-success-11">{amountInWords(changeStr)}</p>
            {notesBack.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {notesBack.map((n) => (
                  <span
                    key={n.value}
                    className="num rounded-[var(--radius-sm)] border border-success-9/25 bg-surface px-1.5 text-2xs text-success-11"
                  >
                    {n.count} × ₹{n.value}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <Button variant="primary" size="xl" className="mt-2 w-full" disabled={!settled || busy} onClick={() => onComplete(rows)}>
          {busy ? 'Saving…' : 'Save & Print'}
          <Kbd className="border-transparent bg-white text-accent-11">Ctrl S</Kbd>
        </Button>
      </div>
    </div>
  )
}
