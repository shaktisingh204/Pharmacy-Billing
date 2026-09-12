import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { nanoid } from 'nanoid'
import { Flame, PackageCheck, ShieldOff, TriangleAlert, Undo2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  CreditNote, IsoDate, PaymentMode, ReturnDisposition, SaleInvoice, SaleReturnInput,
  SaleReturnLineInput,
} from '@contract'
import { PAYMENT_MODES } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatQty } from '@/lib/format'
import { allocationKey, priceSaleReturn, REASON_MIN, returnableAllocations } from '@/api/sales'
import type { ReturnableAllocation } from '@/api/sales'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'

/**
 * A sale return, as the credit note it actually is.
 *
 * THREE THINGS THIS SCREEN REFUSES TO GUESS, and each of them is a decision the
 * person at the counter is the only one qualified to make:
 *
 *  1. HOW MUCH comes back, per line and per BATCH — capped at what was sold on
 *     that batch minus what has already been credited. The cap is enforced in
 *     `api/sales`, not here; this only has to make it visible.
 *  2. WHAT HAPPENS TO IT. A sealed strip goes back on the shelf; one that has
 *     been out of the shop's control in a customer's bag for a week may not.
 *     Defaulting that would put unsellable stock back into FEFO.
 *  3. HOW THE MONEY GOES BACK, because that is what moves the drawer and
 *     therefore the evening's cash count.
 *
 * The refund shown at the bottom is produced by `priceSaleReturn` — the very
 * function that posts it. A preview computed a second way is a preview that can
 * disagree with the document, and the number a customer is told is the number
 * they have to be paid.
 */

const DISPOSITIONS: Array<{
  value: ReturnDisposition
  label: string
  icon: LucideIcon
  help: string
}> = [
  {
    value: 'RESTOCK',
    label: 'Restock',
    icon: PackageCheck,
    /* Back to the ORIGINAL batch, never a new one: MRP is part of batch
       identity, and the strip in the customer's hand carries the price it was
       sold at. A "returns batch" would be a second row for the same goods. */
    help: 'Sealed, in date, fit to sell. Goes back on the batch it came off, at the MRP it was sold at.',
  },
  {
    value: 'QUARANTINE',
    label: 'Hold',
    icon: ShieldOff,
    help: 'Doubtful storage, a recall, or a strip you want a second look at. Blocks the WHOLE batch from allocating until it is released from Inventory.',
  },
  {
    value: 'DESTROY',
    label: 'Destroy',
    icon: Flame,
    help: 'Opened, damaged, or a cold-chain break. Recorded as received and then written off, so the shelf and the ledger both say what happened.',
  },
]

const DISPOSITION_META = new Map(DISPOSITIONS.map((d) => [d.value, d]))

const REFUND_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash from the drawer',
  UPI: 'UPI transfer back',
  CARD: 'Card reversal',
  CREDIT: 'Credited to the account',
}

const DECIMALISH = /^\d+(\.\d+)?$/

interface DraftLine {
  qty: string
  disposition: ReturnDisposition
}

/** The tender the bill was mostly settled with — the honest default for how the
 *  money goes back, and still a choice, because a card reversal is often
 *  refunded in cash at a counter. */
function dominantMode(invoice: SaleInvoice): PaymentMode {
  let best: PaymentMode = 'CASH'
  let bestAmount = D.dec('-1')
  for (const mode of PAYMENT_MODES) {
    const amount = D.sum(invoice.payments.filter((p) => p.mode === mode).map((p) => D.dec(p.amount)))
    if (D.gt(amount, bestAmount)) {
      best = mode
      bestAmount = amount
    }
  }
  return best
}

function blankDrafts(rows: readonly ReturnableAllocation[]): Record<string, DraftLine> {
  const out: Record<string, DraftLine> = {}
  for (const r of rows) out[allocationKey(r.lineId, r.batchId)] = { qty: '', disposition: 'RESTOCK' }
  return out
}

export function SaleReturnDialog({
  open,
  onOpenChange,
  invoice,
  creditNotes,
  storeId,
  terminalId,
  today,
  drawerCounted,
  busy,
  onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  invoice: SaleInvoice | null
  creditNotes: CreditNote[]
  storeId: number
  /** The till ISSUING the note, which is not necessarily the one that raised the
   *  bill: the cash comes out of this drawer, so this is the terminal whose day
   *  close has to carry the refund and whose CN series burns the number. */
  terminalId: number
  today: IsoDate
  /** The drawer has already been counted for today on THIS till, so cash cannot
   *  leave it — the recorded variance was computed against a position a refund
   *  would change. Every other mode is unaffected. */
  drawerCounted: boolean
  busy: boolean
  /** The parent owns the write and closes this on success, so a failure keeps
   *  the typed reason and the chosen dispositions on screen. */
  onCommit: (input: SaleReturnInput) => void
}) {
  /* Claims the narrowest scope while open: a key this dialog does not implement
     must not reach the register underneath and move the selection out from
     under the bill being credited. Radix owns Escape at the capture phase. */
  useHotkeys('modal', {}, { enabled: open })

  const rows = invoice ? returnableAllocations(invoice, creditNotes) : []
  const [drafts, setDrafts] = useState<Record<string, DraftLine>>({})
  const [reason, setReason] = useState('')
  /* Cash is the default because it is what a counter actually does — except
     once the drawer is counted, when it is the one mode that will be refused.
     Defaulting into a dead option makes the form look broken. */
  const [refundMode, setRefundMode] = useState<PaymentMode>(drawerCounted ? 'UPI' : 'CASH')
  const [idempotencyKey, setIdempotencyKey] = useState(() => nanoid())

  /* Reset during render, not in an effect: an effect would paint one frame of
     the previous bill's quantities against this bill's lines. */
  const identity = `${open ? 'o' : 'c'}:${invoice?.id ?? 0}:${creditNotes.length}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setDrafts(blankDrafts(rows))
    setReason('')
    setRefundMode(invoice ? dominantMode(invoice) : 'CASH')
    // A NEW key per opening, and the SAME key across a retry of that opening:
    // that is exactly what makes a failed post safe to press again.
    setIdempotencyKey(nanoid())
  }

  const lines: SaleReturnLineInput[] = rows.flatMap((r) => {
    const key = allocationKey(r.lineId, r.batchId)
    const draft = drafts[key]
    const raw = (draft?.qty ?? '').trim()
    if (!DECIMALISH.test(raw) || D.isZero(D.dec(raw))) return []
    return [{ lineId: r.lineId, batchId: r.batchId, qty: raw, disposition: draft?.disposition ?? 'RESTOCK' }]
  })

  const input: SaleReturnInput = {
    idempotencyKey,
    invoiceId: invoice?.id ?? 0,
    terminalId,
    reason: reason.trim(),
    refundMode,
    lines,
  }

  /* The document, priced by the same function that will post it. It throws on
     anything it would refuse, so the message under the button is the real one
     rather than a second opinion written here. */
  let priced: ReturnType<typeof priceSaleReturn> | null = null
  let problem: string | null = null
  if (invoice && lines.length > 0) {
    try {
      priced = priceSaleReturn(invoice, creditNotes, input, {
        storeId,
        operatorName: invoice.operatorName,
        issuedOn: today,
        createdAt: `${today}T00:00:00.000Z`,
      })
    } catch (err) {
      problem = (err as Error).message
    }
  }

  const holdsAnything = lines.some((l) => l.disposition === 'QUARANTINE')
  /* The reason is checked HERE as well as in `priceSaleReturn`'s sibling guard,
     because pricing deliberately ignores it — without this the button would be
     live in the one state the adapter is guaranteed to refuse, and the operator
     would learn the rule from a failure toast rather than from the form. */
  const canPost = priced !== null && reason.trim().length >= REASON_MIN && !busy

  function setLine(key: string, patch: Partial<DraftLine>) {
    setDrafts((prev) => ({ ...prev, [key]: { qty: '', disposition: 'RESTOCK', ...prev[key], ...patch } }))
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 860 }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">
              Return against <span className="mono">{invoice?.invoiceNo ?? '—'}</span>
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              The credit note reverses each line’s ORIGINAL tax — the rate that was charged on{' '}
              {invoice?.invoiceDate ?? 'the bill'}, never today’s.
            </Dialog.Description>
          </div>

          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_58px_58px_104px_232px_92px] gap-2 border-b border-border-subtle bg-subtle px-4 py-1.5">
            <span className="micro-label">Item · batch</span>
            <span className="micro-label text-right">Sold</span>
            <span className="micro-label text-right">Back</span>
            <span className="micro-label">Return qty</span>
            <span className="micro-label">What happens to it</span>
            <span className="micro-label text-right">Credit ₹</span>
          </div>

          <div className="scroll-region min-h-0 flex-1">
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-fg-muted">
                Nothing on this bill is still returnable.
              </p>
            ) : (
              rows.map((r) => {
                const key = allocationKey(r.lineId, r.batchId)
                const draft = drafts[key] ?? { qty: '', disposition: 'RESTOCK' as ReturnDisposition }
                const creditLine = priced?.note.lines.find((l) => allocationKey(l.lineId, l.batchId) === key)
                const exhausted = D.isZero(D.dec(r.returnableQty))
                return (
                  <div
                    key={key}
                    className={cn(
                      'grid grid-cols-[minmax(0,1fr)_58px_58px_104px_232px_92px] items-center gap-2 border-b border-border-subtle px-4 py-1.5',
                      exhausted && 'opacity-50',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-base font-medium text-fg" title={r.brandName}>
                        {r.brandName}
                      </div>
                      <div className="flex items-baseline gap-1.5 text-2xs text-fg-subtle">
                        <span className="mono max-w-[110px] truncate">{r.batchNo}</span>
                        <span aria-hidden>·</span>
                        <span className="mono">exp {formatExpiry(r.expiryDate)}</span>
                        <span aria-hidden>·</span>
                        <span className="num">@ {formatAmount(r.ratePerUnit)}</span>
                        <span aria-hidden>·</span>
                        <span className="num">GST {r.gstRatePct}%</span>
                      </div>
                    </div>

                    <span className="num text-sm text-fg-muted">{formatQty(r.soldQty)}</span>
                    <span className="num text-sm text-fg-muted">
                      {D.isZero(D.dec(r.returnedQty)) ? '—' : formatQty(r.returnedQty)}
                    </span>

                    <div className="flex items-center gap-1">
                      <input
                        value={draft.qty}
                        onChange={(e) => setLine(key, { qty: e.target.value })}
                        disabled={exhausted}
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`Quantity to return of ${r.brandName} from batch ${r.batchNo}`}
                        placeholder="0"
                        className="num h-[var(--control-h)] w-[58px] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-right text-base"
                      />
                      <button
                        type="button"
                        disabled={exhausted}
                        onClick={() => setLine(key, { qty: r.returnableQty })}
                        title={`Return all ${r.returnableQty} still open on this batch`}
                        className="h-[var(--control-h)] rounded-[var(--radius-md)] px-1.5 text-2xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                      >
                        All
                      </button>
                    </div>

                    <div className="flex items-center gap-1">
                      {DISPOSITIONS.map((d) => {
                        const on = draft.disposition === d.value
                        return (
                          <button
                            key={d.value}
                            type="button"
                            disabled={exhausted}
                            onClick={() => setLine(key, { disposition: d.value })}
                            title={d.help}
                            aria-pressed={on}
                            className={cn(
                              'flex h-[var(--control-h)] flex-1 items-center justify-center gap-1 rounded-[var(--radius-md)] border px-1.5 text-2xs',
                              on
                                ? 'border-accent-9 bg-accent-3 font-medium text-accent-11'
                                : 'border-border text-fg-muted hover:bg-hover hover:text-fg',
                            )}
                          >
                            <d.icon size={12} aria-hidden />
                            {d.label}
                          </button>
                        )
                      })}
                    </div>

                    <span className="num text-right text-base font-medium text-fg">
                      {creditLine ? formatAmount(creditLine.lineTotal) : <span className="text-fg-subtle">—</span>}
                    </span>
                  </div>
                )
              })
            )}
          </div>

          {holdsAnything ? (
            <div className="flex shrink-0 items-start gap-2 border-t border-border-subtle bg-warning-3 px-4 py-2">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning-11" aria-hidden />
              <p className="text-xs text-warning-11">
                Holding a batch blocks <strong>all</strong> of it, not just the units coming back — batch
                identity is (batch no, expiry, MRP), so there is nowhere else to put them. Release it from
                Inventory once the batch is cleared.
              </p>
            </div>
          ) : null}

          <div className="shrink-0 border-t border-border-subtle px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[240px] flex-1 flex-col gap-1">
                <span className="micro-label">Why it came back</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Customer bought the wrong strength; strip is sealed"
                  autoComplete="off"
                  className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="micro-label">Money goes back as</span>
                <select
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value as PaymentMode)}
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                >
                  {PAYMENT_MODES.map((m) => (
                    <option key={m} value={m} disabled={m === 'CASH' && drawerCounted}>
                      {REFUND_LABEL[m]}
                      {m === 'CASH' && drawerCounted ? ' — drawer counted' : ''}
                    </option>
                  ))}
                </select>
                {/* Said on the form, not learned from a failure toast. The
                    adapter refuses this outright; an operator who has already
                    told the customer "cash back" and then hits a red toast has
                    been let down by the screen, not by the rule. */}
                {drawerCounted ? (
                  <span className="text-2xs text-fg-subtle">
                    Today has been closed and counted on this till, so cash cannot leave the drawer.
                    Refund by card, UPI or to the account.
                  </span>
                ) : null}
              </label>

              <div className="ml-auto text-right">
                <div className="micro-label">Credit note</div>
                <div className="num text-xl font-semibold text-fg">
                  ₹{formatAmount(priced?.note.netAmount ?? '0.00')}
                </div>
                {priced ? (
                  <div className="text-2xs text-fg-subtle">
                    incl. tax reversed{' '}
                    <span className="num">
                      {formatAmount(
                        D.toStr(
                          D.sum([
                            D.dec(priced.note.cgst), D.dec(priced.note.sgst), D.dec(priced.note.igst),
                          ]),
                          2,
                        ),
                      )}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 text-xs">
                {problem ? (
                  <span role="alert" className="text-danger-11">{problem}</span>
                ) : lines.length === 0 ? (
                  <span className="text-fg-subtle">Enter a quantity against at least one line.</span>
                ) : reason.trim().length < REASON_MIN ? (
                  <span className="text-fg-subtle">
                    A credit note has to say why — an unexplained refund is indistinguishable from a till lift.
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5 text-fg-muted">
                    {lines.map((l) => {
                      const meta = DISPOSITION_META.get(l.disposition)
                      return meta ? (
                        <Chip key={`${l.lineId}-${l.batchId}`} icon={meta.icon}>
                          {formatQty(l.qty)} {meta.label.toLowerCase()}
                        </Chip>
                      ) : null
                    })}
                  </span>
                )}
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button variant="primary" disabled={!canPost} onClick={() => onCommit(input)}>
                <Undo2 /> Post credit note
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
