import { useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, CreditCard, Landmark, Plus, QrCode, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaymentInput, PaymentMode, Quote } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
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
 */

const MODES: Array<{ mode: PaymentMode; label: string; icon: LucideIcon; key: string }> = [
  { mode: 'CASH', label: 'Cash', icon: Banknote, key: '1' },
  { mode: 'UPI', label: 'UPI', icon: QrCode, key: '2' },
  { mode: 'CARD', label: 'Card', icon: CreditCard, key: '3' },
  { mode: 'CREDIT', label: 'Khata', icon: Landmark, key: '4' },
]

const DENOMS = [500, 200, 100, 50] as const

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
  const tenderRef = useRef<HTMLInputElement>(null)

  useEffect(() => { tenderRef.current?.focus(); tenderRef.current?.select() }, [])

  const paid = useMemo(() => D.sum(rows.map((r) => D.dec(r.amount || '0'))), [rows])
  const balance = D.sub(net, paid)
  const change = D.max(D.neg(balance), D.ZERO)
  const hasCredit = rows.some((r) => r.mode === 'CREDIT')
  const settled = hasCredit || D.gte(paid, net)

  function setRow(i: number, patch: Partial<PaymentInput>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
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
    'payment.exact': () => setRow(0, { amount: quote.netAmount }),
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

  return (
    <div className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface 2xl:w-[380px]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-base font-medium">Payment</h2>
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
          Back to cart <Kbd>Esc</Kbd>
        </button>
      </div>

      <div className="scroll-region min-h-0 flex-1 p-3">
        <div className="grid grid-cols-2 gap-2">
          {MODES.map((m) => {
            const active = rows[0]?.mode === m.mode
            const disabled = m.mode === 'CREDIT' && !allowCredit
            return (
              <button
                key={m.mode}
                type="button"
                disabled={disabled}
                onClick={() => setRow(0, { mode: m.mode })}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border text-sm font-medium',
                  'transition-colors duration-[var(--dur-fast)]',
                  active ? 'border-accent-9 bg-accent-3 text-accent-11' : 'border-border bg-surface hover:border-border-strong hover:bg-hover',
                  disabled && 'cursor-not-allowed opacity-40',
                )}
                title={disabled ? 'Attach a customer to bill on khata' : undefined}
              >
                <m.icon size={20} aria-hidden />
                <span className="flex items-center gap-1">{m.label} <Kbd>{m.key}</Kbd></span>
              </button>
            )
          })}
        </div>

        <div className="mt-4">
          <label className="micro-label mb-1 block" htmlFor="tender">Tendered</label>
          <input
            id="tender"
            ref={tenderRef}
            value={rows[0]?.amount ?? ''}
            inputMode="decimal"
            onChange={(e) => setRow(0, { amount: e.target.value.replace(/[^\d.]/g, '') })}
            className="num h-12 w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-2xl font-semibold"
          />
          <div className="mt-2 flex gap-1.5">
            <button type="button" onClick={() => setRow(0, { amount: quote.netAmount })}
              className="rounded-[var(--radius-sm)] border border-border px-2 py-1 text-xs hover:bg-hover">
              Exact <Kbd className="ml-1">E</Kbd>
            </button>
            {DENOMS.map((d) => (
              <button key={d} type="button" onClick={() => addDenom(d)}
                className="num rounded-[var(--radius-sm)] border border-border px-2 py-1 text-xs hover:bg-hover">
                +{d}
              </button>
            ))}
          </div>
        </div>

        {rows.slice(1).map((r, i) => (
          <div key={i + 1} className="mt-2 flex items-center gap-2">
            <select
              value={r.mode}
              onChange={(e) => setRow(i + 1, { mode: e.target.value as PaymentMode })}
              className="h-9 rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-sm"
            >
              {MODES.filter((m) => m.mode !== 'CREDIT' || allowCredit).map((m) => (
                <option key={m.mode} value={m.mode}>{m.label}</option>
              ))}
            </select>
            <input
              value={r.amount}
              inputMode="decimal"
              onChange={(e) => setRow(i + 1, { amount: e.target.value.replace(/[^\d.]/g, '') })}
              className="num h-9 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2"
            />
            <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i + 1))}
              aria-label="Remove split" className="text-fg-subtle hover:text-danger-9">
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        ))}

        <button type="button" onClick={addSplit}
          className="mt-2 flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
          <Plus size={14} aria-hidden /> Split payment <Kbd>Num −</Kbd>
        </button>
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="text-fg-muted">Bill total</span>
          <span className="num font-medium">{formatAmount(quote.netAmount)}</span>
        </div>
        {D.gt(balance, D.ZERO) && !hasCredit && (
          <div className="mb-2 flex items-baseline justify-between text-sm text-danger-11">
            <span>Still due</span>
            <span className="num font-medium">{formatAmount(D.toStr(balance))}</span>
          </div>
        )}
        {D.gt(change, D.ZERO) && (
          <div className="mb-2 flex items-baseline justify-between rounded-[var(--radius-md)] bg-success-3 px-3 py-2">
            <span className="text-base font-medium text-success-11">Change due</span>
            <span className="num text-4xl font-semibold text-success-11">{formatAmount(D.toStr(change))}</span>
          </div>
        )}
        <Button variant="primary" size="xl" className="w-full" disabled={!settled || busy} onClick={() => onComplete(rows)}>
          {busy ? 'Saving…' : 'Save & Print'}
          <Kbd className="border-white/25 bg-white/15 text-white">Ctrl S</Kbd>
        </Button>
      </div>
    </div>
  )
}
