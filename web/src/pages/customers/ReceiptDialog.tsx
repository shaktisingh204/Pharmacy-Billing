import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { ArrowRight, HandCoins, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { CustomerReceiptInput, ReceiptMode } from '@contract'
import type { CustomerRow } from '@/api/customers'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * Money taken against an account.
 *
 * Three refusals, and the dialog says which one it is applying rather than
 * greying a button and leaving the operator to guess:
 *
 *  - ZERO records a payment that did not happen and settles nothing.
 *  - NEGATIVE is a refund. It moves money the other way and needs the opposite
 *    document; allowed here it would let a "receipt" silently increase a debt.
 *  - MORE THAN THE BALANCE is an advance — a real thing a customer does, with
 *    its own GST treatment as a receipt voucher against a supply not yet made.
 *    Quietly driving the account negative would hide it, and the next bill would
 *    be discounted by money nobody could trace.
 *
 * The same three rules are enforced in `api/customers.prepareReceipt`, which is
 * what actually writes. This is the courteous copy: the adapter's is the one
 * that cannot be got around, exactly as the sale side re-quotes server-side
 * rather than trusting a total the screen sent.
 *
 * The typed amount NEVER becomes a JS number. It is compared as a decimal and
 * handed on as the string it was typed as.
 */

/**
 * Deliberately accepts a leading minus.
 *
 * Rejecting it at the parse step would answer a typed "−500" with "that is not
 * an amount", which is both unhelpful and untrue — it is an amount, it is the
 * wrong DIRECTION. Letting it parse is what lets the dialog say so.
 */
const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/

/** A typed unicode minus is a minus; three of them reach a keyboard. */
const normaliseAmount = (raw: string): string => raw.trim().replace(/[−–—]/g, '-')

const MODES: Array<{ value: ReceiptMode; label: string; hint: string }> = [
  { value: 'CASH', label: 'Cash', hint: 'Counted into the drawer' },
  { value: 'UPI', label: 'UPI', hint: 'Reference from the app' },
  { value: 'CARD', label: 'Card', hint: 'Approval code from the terminal' },
]

/** A round sum is what actually gets handed over; the balance is the other one. */
const QUICK: string[] = ['500', '1000', '2000', '5000']

export function ReceiptDialog({
  open,
  onOpenChange,
  row,
  busy,
  onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  row: CustomerRow | null
  busy: boolean
  /** The parent owns the write and closes this on success, so a failed save
   *  keeps the typed amount on screen instead of throwing it away. */
  onCommit: (input: CustomerReceiptInput) => void
}) {
  const [amountText, setAmountText] = useState('')
  const [mode, setMode] = useState<ReceiptMode>('CASH')
  const [reference, setReference] = useState('')

  /* Reset during render rather than in an effect: an effect paints one frame of
     the previous customer's amount against this customer's name. */
  const identity = `${open ? 'o' : 'c'}:${row?.customer.id ?? 0}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setAmountText('')
    setMode('CASH')
    setReference('')
  }

  /* Claims the narrowest scope while open, so a key this dialog does not
     implement cannot reach the grid underneath and move the selection out from
     under the account being settled. */
  useHotkeys('modal', {}, { enabled: open })

  const c = row?.customer ?? null
  const balance = row ? row.outstanding : D.ZERO
  const typed = normaliseAmount(amountText)
  const amount = AMOUNT_RE.test(typed) ? D.dec(typed) : null

  const problem: string | null =
    typed === ''
      ? null
      : amount === null
        ? 'That is not an amount. Type rupees, for example 500 or 500.50.'
        : D.isNeg(amount)
          ? 'A receipt cannot be negative. Money going the other way is a refund, and that is a different document.'
          : D.isZero(amount)
            ? 'A receipt of nothing settles nothing. Close this instead.'
            : D.gt(amount, balance)
              ? `That is more than the ${formatMoney(D.toStr(balance, 2))} outstanding. Take the balance, or record the excess as an advance.`
              : null

  const valid = c !== null && amount !== null && problem === null && D.gt(amount, D.ZERO)
  const after = valid && amount ? D.sub(balance, amount) : null

  function commit() {
    if (!valid || !c || busy) return
    const ref = reference.trim()
    onCommit({
      customerId: c.id,
      // The string as typed, never a number that has been through IEEE-754.
      amount: typed,
      mode,
      ...(ref ? { reference: ref } : {}),
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          data-density="comfortable"
          style={{ width: 540 }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
            <Dialog.Title className="text-xl font-semibold tracking-tight">Record a receipt</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              This posts a document and the balance follows from it. It is not an edit of the
              outstanding figure.
            </Dialog.Description>
          </div>

          {c ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
              <span className="text-base font-medium text-fg">{c.name}</span>
              <span className="mono text-xs text-fg-muted">{c.phone || 'No phone'}</span>
              <span className="ml-auto flex items-baseline gap-1.5">
                <span className="micro-label">Outstanding</span>
                <span className="display-num text-xl text-fg">{formatMoney(c.outstanding)}</span>
              </span>
            </div>
          ) : null}

          {/* Allergies have nothing to do with money, and that is the point: this
              overlay covers the sheet where the strip lives, and a customer's
              record is not allowed to lose it just because a dialog is open. */}
          {c && c.allergies.length > 0 ? (
            <p
              role="note"
              className="flex items-start gap-2 border-b border-danger-9/25 bg-danger-3 px-[var(--card-px)] py-1.5 text-2xs text-danger-11"
            >
              <ShieldAlert size={13} className="mt-px shrink-0 text-danger-9" aria-hidden />
              <span><span className="font-semibold">Allergic to</span> {c.allergies.join(', ')}</span>
            </p>
          ) : null}

          <div className="space-y-3 p-[var(--card-px)]">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-3">
              <label className="block">
                <span className="micro-label mb-1 block">
                  Amount received<span className="text-danger-9"> *</span>
                </span>
                <input
                  autoFocus
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && valid) { e.preventDefault(); commit() } }}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="500"
                  aria-label="Amount received in rupees"
                  aria-invalid={problem !== null}
                  aria-describedby="receipt-problem"
                  className={cn(
                    'num h-[var(--control-h)] w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-lg',
                    problem === null ? 'border-border hover:border-border-strong' : 'border-danger-9',
                  )}
                />
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {QUICK.map((q) => (
                    <QuickButton key={q} value={q} balance={balance} onPick={setAmountText} />
                  ))}
                  <button
                    type="button"
                    onClick={() => setAmountText(D.toStr(balance, 2))}
                    disabled={!D.gt(balance, D.ZERO)}
                    className="inline-flex h-6 items-center rounded-[var(--radius-full)] border border-accent-6 bg-accent-3 px-2 text-2xs font-medium text-accent-11 hover:border-accent-9 disabled:opacity-50"
                  >
                    Full balance
                  </button>
                </span>
              </label>

              <fieldset className="min-w-0">
                <legend className="micro-label mb-1">How it came in</legend>
                <div className="flex gap-1">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      aria-pressed={mode === m.value}
                      onClick={() => setMode(m.value)}
                      className={cn(
                        'h-[var(--control-h)] flex-1 rounded-[var(--radius-md)] border text-sm',
                        mode === m.value
                          ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                          : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  aria-label="Payment reference"
                  placeholder={MODES.find((m) => m.value === mode)?.hint}
                  autoComplete="off"
                  spellCheck={false}
                  className="mono mt-1.5 h-8 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm placeholder:text-fg-subtle hover:border-border-strong"
                />
              </fieldset>
            </div>

            {/* The preview. Nothing is committed until the operator has seen the
                balance this leaves behind, because that is the number the
                customer is going to be told. */}
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-3 py-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
                <span className="text-fg-muted">Outstanding now</span>
                <span className="num text-fg">{formatAmount(D.toStr(balance, 2))}</span>

                <span className="text-fg-muted">This receipt</span>
                <span className={cn('num', amount === null ? 'text-fg-subtle' : 'text-success-11')}>
                  {amount === null ? '—' : `− ${formatAmount(D.toStr(amount, 2))}`}
                </span>

                <span className="col-span-2 my-0.5 h-px bg-border-subtle" />

                <span className="flex items-center gap-1.5 font-medium text-fg">
                  <ArrowRight size={13} aria-hidden className="text-fg-subtle" /> Balance after
                </span>
                <span className={cn('num font-semibold', after === null ? 'text-fg-subtle' : 'text-fg')}>
                  {after === null ? '—' : formatAmount(D.toStr(after, 2))}
                </span>
              </div>
            </div>

            <p id="receipt-problem" role={problem === null ? undefined : 'alert'} className="min-h-4">
              {problem === null ? (
                <span className="text-2xs text-fg-subtle">
                  A receipt is not tied to one bill. It clears the account oldest bill first, and
                  the ageing on the account will show it that way.
                </span>
              ) : (
                <span className="flex items-start gap-1.5 text-2xs text-danger-11">
                  <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
                  {problem}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
            <span className="text-2xs text-fg-subtle">
              Posts one receipt. It cannot be edited afterwards — only offset by another document.
            </span>
            <Button className="ml-auto" onClick={() => onOpenChange(false)}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button variant="primary" disabled={!valid || busy} onClick={commit}>
              <HandCoins /> {busy ? 'Posting…' : 'Take receipt'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Offered only while it would be a legal receipt: a chip that fills the box
 *  with an amount the dialog then refuses is a trap, not a shortcut. */
function QuickButton({
  value, balance, onPick,
}: {
  value: string
  balance: D.Decimal
  onPick: (v: string) => void
}) {
  const over = D.gt(D.dec(value), balance)
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      disabled={over}
      className="num inline-flex h-6 items-center rounded-[var(--radius-full)] border border-border bg-surface px-2 text-2xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {formatAmount(value)}
    </button>
  )
}
