import type { ReactNode } from 'react'
import {
  Ban, CircleCheck, FileText, Lock, Printer, ReceiptText, Stethoscope, Undo2, User, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreditNote, SaleInvoice } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatQty } from '@/lib/format'
import { allocationKey, returnableAllocations, rowStatus } from '@/api/sales'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { ModeChip, StatusChip } from './InvoiceTable'

/**
 * One bill, exactly as it was posted.
 *
 * THE IMMUTABILITY IS THE DESIGN. There is no pencil on this sheet, no editable
 * cell, and no greyed-out "Edit" waiting to be enabled by a permission — the
 * affordance is absent, because a disabled button is still a promise that
 * somebody, somewhere, can change a posted invoice. Three things can happen to
 * a bill and all three are documents: it can be PRINTED again, part of it can
 * be RETURNED on a credit note, or the whole thing can be CANCELLED with a
 * reason on the day it was raised (invariant I20).
 *
 * A voided bill is shown, not hidden. It keeps its number, its lines and its
 * totals, and it wears the reason it was cancelled — that is what an auditor
 * asks for, and a document that quietly disappears is what concealment looks
 * like from the outside.
 */

const STAMP = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function stamp(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : STAMP.format(t)
}

const isZero = (v: string): boolean => D.isZero(D.dec(v))

export function InvoiceDetail({
  invoice,
  creditNotes,
  canVoid,
  dayIsClosed,
  busy,
  onClose,
  onPrint,
  onReturn,
  onVoid,
}: {
  invoice: SaleInvoice
  creditNotes: CreditNote[]
  /** Same-day, nothing credited against it yet. The parent asks `isVoidable`. */
  canVoid: boolean
  /** The drawer has been counted for this bill's own date. A separate reason
   *  from "too old", and the two must not be reported as each other. */
  dayIsClosed: boolean
  busy: boolean
  onClose: () => void
  onPrint: () => void
  onReturn: () => void
  onVoid: () => void
}) {
  const { quote } = invoice
  const voided = invoice.status === 'VOIDED'
  const returnable = returnableAllocations(invoice, creditNotes)
  const returnedBy = new Map(returnable.map((r) => [allocationKey(r.lineId, r.batchId), r]))
  const anythingLeft = returnable.some((r) => D.gt(D.dec(r.returnableQty), D.ZERO))
  /* The same rule the register row wears, called rather than restated: two
     copies of "is this bill closed" is one copy that eventually disagrees. */
  const status = rowStatus(invoice, creditNotes)

  return (
    <aside
      role="complementary"
      aria-label={`Invoice ${invoice.invoiceNo}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="card flex w-[420px] shrink-0 flex-col overflow-hidden xl:w-[470px]"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="mono truncate text-base font-semibold text-fg">{invoice.invoiceNo}</h2>
            <StatusChip status={status} />
          </div>
          <div className="mt-0.5 truncate text-xs text-fg-muted">
            {stamp(invoice.createdAt)} · {invoice.operatorName} · Terminal {invoice.terminalId}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the bill"
          className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="scroll-region min-h-0 flex-1">
        {voided ? (
          <div role="status" className="flex items-start gap-2 border-b border-danger-9/25 bg-danger-3 px-3.5 py-2.5">
            <Ban size={15} className="mt-0.5 shrink-0 text-danger-11" aria-hidden />
            <div className="min-w-0">
              <div className="text-sm font-medium text-danger-11">Cancelled</div>
              <p className="text-xs text-danger-11">
                {invoice.voidReason ?? 'No reason was recorded.'}
                {invoice.voidedAt ? <span className="text-danger-11"> · {stamp(invoice.voidedAt)}</span> : null}
              </p>
              {/* The stock went back when it was cancelled; saying so here stops
                  somebody "correcting" the shelf a second time. */}
              <p className="mt-1 text-2xs text-danger-11">
                The goods were returned to their batches. The number stays in the series.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-b border-border-subtle bg-subtle px-3.5 py-2">
          <User size={14} className="shrink-0 text-fg-subtle" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">
              {invoice.customerName ?? 'Walk-in customer'}
            </div>
            {invoice.customerPhone ? (
              <div className="mono truncate text-2xs text-fg-muted">{invoice.customerPhone}</div>
            ) : null}
          </div>
          {invoice.interState ? <Chip tone="var(--info-11)">Inter-state · IGST</Chip> : null}
        </div>

        {invoice.prescription ? (
          <Section title="Prescription" icon={Stethoscope}>
            <Facts
              rows={[
                { label: 'Prescriber', value: invoice.prescription.prescriberName },
                ...(invoice.prescription.prescriberRegNo
                  ? [{ label: 'Reg. no', value: invoice.prescription.prescriberRegNo, mono: true }]
                  : []),
                ...(invoice.prescription.prescriberAddress
                  ? [{ label: 'Clinic', value: invoice.prescription.prescriberAddress }]
                  : []),
                { label: 'Patient', value: invoice.prescription.patientName },
                ...(invoice.prescription.patientAddress
                  ? [{ label: 'Address', value: invoice.prescription.patientAddress }]
                  : []),
                { label: 'Dated', value: invoice.prescription.prescriptionDate },
              ]}
            />
          </Section>
        ) : null}

        <Section
          title={`Items · ${quote.lines.length}`}
          icon={ReceiptText}
          note={`Amount ₹`}
        >
          {quote.lines.map((line) =>
            /*
             * A row per ALLOCATION, not per cart line.
             *
             * One line legitimately fans across two batches with two printed
             * MRPs, and the batch is the thing a recall notice names and a
             * return is booked against. Collapsing them would hide exactly the
             * fact the sheet exists to carry.
             */
            line.allocations.map((a) => {
              const back = returnedBy.get(allocationKey(line.lineId, a.batchId))
              const returned = back && D.gt(D.dec(back.returnedQty), D.ZERO) ? back.returnedQty : null
              return (
                <div key={`${line.lineId}-${a.batchId}`} className="border-b border-border-subtle px-3.5 py-1.5 last:border-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-base font-medium text-fg" title={line.brandName}>
                      {line.brandName}
                    </span>
                    <span className="shrink-0 text-2xs text-fg-subtle">{line.packLabel}</span>
                    <span className="num ml-auto shrink-0 text-base font-medium">{formatAmount(a.lineTotal)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-fg-subtle">
                    <span className="mono max-w-[96px] truncate" title={`Batch ${a.batchNo}`}>{a.batchNo}</span>
                    <span aria-hidden>·</span>
                    <span className="mono">exp {formatExpiry(a.expiryDate)}</span>
                    <span aria-hidden>·</span>
                    <span className="num">
                      {formatQty(a.qty)}
                      {D.gt(D.dec(a.freeQty), D.ZERO)
                        ? <span className="text-success-11"> +{formatQty(a.freeQty)} free</span>
                        : null}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="num">@ {formatAmount(a.ratePerUnit)}</span>
                    <span aria-hidden>·</span>
                    <span className="num">GST {a.gstRatePct}%</span>
                    {returned ? (
                      <span className="ml-auto">
                        <Chip icon={Undo2} tone="var(--status-expiry-60)">{returned} back</Chip>
                      </span>
                    ) : null}
                  </div>
                </div>
              )
            }),
          )}
        </Section>

        <Section title="Tax, rate by rate" icon={FileText} note="As charged on this bill">
          {/* One row per DISTINCT rate. A real pharmacy bill mixes nil-rated ORS,
              5% medicines and 18% nutraceuticals, and GSTR-1 needs them apart. */}
          <div
            className="grid gap-2 border-b border-border-subtle px-3.5 py-1"
            style={{ gridTemplateColumns: invoice.interState ? '46px 1fr 1fr 1fr' : '46px 1fr 1fr 1fr 1fr' }}
          >
            <span className="micro-label">Rate</span>
            <span className="micro-label text-right">Taxable</span>
            {invoice.interState ? (
              <span className="micro-label text-right">IGST</span>
            ) : (
              <>
                <span className="micro-label text-right">CGST</span>
                <span className="micro-label text-right">SGST</span>
              </>
            )}
            <span className="micro-label text-right">Total</span>
          </div>
          {quote.taxBreakup.length === 0 ? (
            <p className="px-3.5 py-2 text-xs text-fg-muted">No rate-wise breakup was stored with this bill.</p>
          ) : (
            quote.taxBreakup.map((row) => (
              <div
                key={row.gstRatePct}
                className="grid gap-2 border-b border-border-subtle px-3.5 py-1 last:border-0"
                style={{ gridTemplateColumns: invoice.interState ? '46px 1fr 1fr 1fr' : '46px 1fr 1fr 1fr 1fr' }}
              >
                <span className="num text-sm text-fg">{row.gstRatePct}%</span>
                <span className="num text-sm text-fg-muted">{formatAmount(row.taxableValue)}</span>
                {invoice.interState ? (
                  <span className="num text-sm text-fg-muted">{formatAmount(row.igst)}</span>
                ) : (
                  <>
                    <span className="num text-sm text-fg-muted">{formatAmount(row.cgst)}</span>
                    <span className="num text-sm text-fg-muted">{formatAmount(row.sgst)}</span>
                  </>
                )}
                <span className="num text-sm font-medium text-fg">{formatAmount(row.total)}</span>
              </div>
            ))
          )}
        </Section>

        <div className="border-b border-border-subtle px-3.5 py-2">
          <Amount label="Gross" value={quote.grossAmount} muted />
          {!isZero(quote.itemDiscount) ? <Amount label="Line discount" value={quote.itemDiscount} muted /> : null}
          {!isZero(quote.billDiscount) ? (
            <Amount label={`Bill discount ${quote.billDiscountPct}%`} value={quote.billDiscount} muted />
          ) : null}
          <Amount label="Taxable" value={quote.taxableValue} muted />
          {invoice.interState ? (
            <Amount label="IGST" value={quote.igst} muted />
          ) : (
            <>
              <Amount label="CGST" value={quote.cgst} muted />
              <Amount label="SGST" value={quote.sgst} muted />
            </>
          )}
          {!isZero(quote.roundOff) ? <Amount label="Round off" value={quote.roundOff} muted /> : null}
          <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-border-subtle pt-1">
            <span className="text-sm font-medium text-fg">Net</span>
            <span className="num text-lg font-semibold text-fg">₹{formatAmount(quote.netAmount)}</span>
          </div>
        </div>

        <Section title="Payment" icon={CircleCheck}>
          <div className="px-3.5 pb-2">
            {/* A row per tender: a split bill is two facts, and the reference on
                a UPI or card row is what a dispute is settled with. */}
            {invoice.payments.map((p, i) => (
              <div key={`${p.mode}-${i}`} className="flex h-6 items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <ModeChip mode={p.mode} />
                  {p.reference ? <span className="mono truncate text-fg-subtle">{p.reference}</span> : null}
                </span>
                <span className="num text-fg">{formatAmount(p.amount)}</span>
              </div>
            ))}
            <Amount label="Tendered" value={invoice.amountPaid} muted />
            {!isZero(invoice.changeDue) ? <Amount label="Change given" value={invoice.changeDue} muted /> : null}
          </div>
        </Section>

        {creditNotes.length > 0 ? (
          <Section title={`Credit notes · ${creditNotes.length}`} icon={Undo2} note="Reverses this bill">
            {creditNotes.map((n) => (
              <div key={n.id} className="border-b border-border-subtle px-3.5 py-1.5 last:border-0">
                <div className="flex items-baseline gap-2">
                  <span className="mono truncate text-sm text-fg">{n.creditNoteNo}</span>
                  <span className="num ml-auto shrink-0 text-sm font-medium text-fg">
                    −{formatAmount(n.netAmount)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-1.5 text-2xs text-fg-subtle">
                  <span>{n.issuedOn}</span>
                  <span aria-hidden>·</span>
                  <span>refunded by {n.refundMode.toLowerCase()}</span>
                </div>
                <p className="mt-0.5 truncate text-2xs text-fg-muted" title={n.reason}>{n.reason}</p>
              </div>
            ))}
          </Section>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-border-subtle bg-subtle px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onPrint}>
            <Printer /> Reprint
            <Kbd>Ctrl P</Kbd>
          </Button>
          {!voided && anythingLeft ? (
            <Button variant="secondary" onClick={onReturn} disabled={busy}>
              <Undo2 /> Return
            </Button>
          ) : null}
          {canVoid ? (
            <Button variant="danger" onClick={onVoid} disabled={busy}>
              <Ban /> Void
            </Button>
          ) : null}
        </div>

        {/* Why the actions the operator is looking for are not here. An absent
            button with no explanation is indistinguishable from a missing
            feature, and this absence is a rule rather than an omission.

            The branches run in `checkVoidable`'s OWN order — cancelled, then
            credited, then too old — because that is the order the refusal comes
            back in. Reading them in any other order told a customer standing at
            the counter that a bill raised an hour ago came from a closed day. */}
        <p className="mt-2 flex items-start gap-1.5 text-2xs text-fg-subtle">
          <Lock size={12} className="mt-px shrink-0" aria-hidden />
          <span>
            {voided
              ? 'A cancelled bill is a permanent record. It cannot be edited, revived or renumbered.'
              : !anythingLeft && creditNotes.length > 0
                ? 'Everything on this bill has been credited back. A posted bill is never edited — the credit notes above are the correction.'
                : creditNotes.length > 0
                  ? 'A credit note already points at this bill, so it can no longer be cancelled — return the rest instead. A posted bill is never edited.'
                  : canVoid
                    ? 'A posted bill is never edited. Correct part of it with a return, or cancel the whole bill with a reason.'
                    /* checkVoidable's own order: too-old first, then the day
                       close. Reading them the other way told an operator that a
                       bill raised an hour ago came from another day. */
                    : dayIsClosed
                      ? `The drawer has been counted for ${invoice.invoiceDate}. Cancelling this bill now would leave the recorded variance quoting a figure that no longer reconciles, so correct it with a credit note instead.`
                      : `Raised on ${invoice.invoiceDate}, so it can no longer be cancelled — a bill from a closed day is corrected by a credit note, never by editing it.`}
          </span>
        </p>
      </footer>
    </aside>
  )
}

function Amount({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex h-5 items-baseline justify-between gap-2 text-xs">
      <span className={cn('truncate', muted ? 'text-fg-muted' : 'text-fg')}>{label}</span>
      <span className={cn('num', muted ? 'text-fg-muted' : 'text-fg')}>{formatAmount(value)}</span>
    </div>
  )
}

function Section({
  title, icon: Icon, note, children,
}: {
  title: string
  icon: LucideIcon
  note?: string
  children: ReactNode
}) {
  return (
    <section className="border-b border-border-subtle last:border-0">
      <header className="flex h-8 items-center gap-2 px-3.5">
        <Icon size={13} className="text-fg-subtle" aria-hidden />
        <span className="text-sm font-medium text-fg">{title}</span>
        {note ? <span className="ml-auto text-2xs text-fg-subtle">{note}</span> : null}
      </header>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: Array<{ label: string; value: string; mono?: boolean }> }) {
  return (
    <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 pb-2.5">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-xs text-fg-muted">{r.label}</dt>
          <dd className={cn('min-w-0 truncate text-sm text-fg', r.mono && 'mono')} title={r.value}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
