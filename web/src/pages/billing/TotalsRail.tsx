import { CircleAlert, ShieldAlert, UserPlus, X } from 'lucide-react'
import type { Customer, Quote } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * The right rail. Everything the operator must confirm before taking money, in
 * the order they confirm it: who, what is flagged, what the tax is, what is owed.
 */
export function TotalsRail({
  quote, customer, onAttachCustomer, onClearCustomer, onPay, onPrescription, hasH1,
  prescriptionDone, quoteError,
}: {
  quote: Quote
  /** Set when the quote itself failed. The bill must never show a total in that case. */
  quoteError: Error | null
  customer: Customer | null
  onAttachCustomer: () => void
  onClearCustomer: () => void
  onPay: () => void
  onPrescription: () => void
  hasH1: boolean
  prescriptionDone: boolean
}) {
  const canPay = quote.lines.length > 0 && quoteError === null
  const blocking = quote.warnings.filter((w) => w.blocking && w.code !== 'SCHEDULE_H1')

  return (
    <div className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface 2xl:w-[380px]">
      <div className="scroll-region min-h-0 flex-1 p-3">
        <CustomerCard customer={customer} onAttach={onAttachCustomer} onClear={onClearCustomer} />

        {quoteError && (
          <div
            data-testid="quote-error"
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-3 py-2 text-sm text-danger-11"
          >
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">This bill could not be priced.</strong>{' '}
              {quoteError.message} Do not take payment until it is resolved.
            </span>
          </div>
        )}

        {hasH1 && (
          <button
            type="button"
            onClick={onPrescription}
            className={cn(
              'mt-3 flex w-full items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm',
              prescriptionDone
                ? 'border-success-9/25 bg-success-3 text-success-11'
                : 'border-schedule-h1/30 hover:border-schedule-h1/60',
            )}
            style={prescriptionDone ? undefined : { backgroundColor: 'color-mix(in srgb, var(--schedule-h1) 10%, transparent)', color: 'var(--schedule-h1)' }}
          >
            <ShieldAlert size={16} aria-hidden />
            <span className="flex-1">
              {prescriptionDone ? 'Schedule H1 details recorded' : 'Schedule H1 — prescriber and patient required'}
            </span>
            <Kbd>Alt+O</Kbd>
          </button>
        )}

        {blocking.map((w, i) => (
          <div key={i} className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>{w.message}</span>
          </div>
        ))}

        {quote.taxBreakup.length > 0 && (
          <div className="mt-4">
            <div className="micro-label mb-1">GST breakup</div>
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-border-subtle">
              <div className="grid grid-cols-[48px_1fr_1fr_1fr] gap-1 bg-subtle px-2 py-1">
                <span className="micro-label">Rate</span>
                <span className="micro-label text-right">Taxable</span>
                <span className="micro-label text-right">{quote.igst !== '0.00' ? 'IGST' : 'CGST'}</span>
                <span className="micro-label text-right">{quote.igst !== '0.00' ? '' : 'SGST'}</span>
              </div>
              {/* One row per DISTINCT rate: a real pharmacy bill mixes nil-rated ORS,
                  5% medicines and 18% nutraceuticals, and the filing needs them apart. */}
              {quote.taxBreakup.map((r) => (
                <div key={r.gstRatePct} className="grid grid-cols-[48px_1fr_1fr_1fr] gap-1 border-t border-border-subtle px-2 py-1 text-xs">
                  <span className="num text-left">{r.gstRatePct}%</span>
                  <span className="num">{formatAmount(r.taxableValue)}</span>
                  <span className="num">{formatAmount(quote.igst !== '0.00' ? r.igst : r.cgst)}</span>
                  <span className="num">{quote.igst !== '0.00' ? '' : formatAmount(r.sgst)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 space-y-1">
          <Line label="Gross" value={quote.grossAmount} testid="total-gross" />
          {quote.itemDiscount !== '0.00' && <Line label="Item discount" value={`-${quote.itemDiscount}`} tone="success" />}
          {quote.billDiscount !== '0.00' && <Line label={`Bill discount ${quote.billDiscountPct}%`} value={`-${quote.billDiscount}`} tone="success" />}
          <Line label="Taxable" value={quote.taxableValue} muted testid="total-taxable" />
          {quote.igst !== '0.00'
            ? <Line label="IGST" value={quote.igst} muted testid="total-igst" />
            : <><Line label="CGST" value={quote.cgst} muted testid="total-cgst" /><Line label="SGST" value={quote.sgst} muted testid="total-sgst" /></>}
          {/* Always shown, even at zero: an unexplained rupee is the most common
              counter dispute there is. */}
          <Line label="Round off" value={quote.roundOff} muted testid="total-roundoff" />
        </div>
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-base font-medium text-fg-muted">Total</span>
          {quoteError ? (
            <span className="text-xl font-semibold text-danger-11">Unpriced</span>
          ) : (
            <span className="num text-3xl font-semibold tracking-tight" data-testid="total-net">
              <span className="text-[0.68em] text-fg-muted">₹</span>
              {formatAmount(quote.netAmount)}
            </span>
          )}
        </div>
        <Button variant="primary" size="xl" className="w-full" disabled={!canPay} onClick={onPay}>
          Pay
          <Kbd className="border-white/25 bg-white/15 text-white">Ctrl ↵</Kbd>
        </Button>
      </div>
    </div>
  )
}

function Line({ label, value, muted, tone, testid }: { label: string; value: string; muted?: boolean; tone?: 'success'; testid?: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm" data-testid={testid}>
      <span className={muted ? 'text-fg-muted' : 'text-fg'}>{label}</span>
      <span className={cn('num', muted && 'text-fg-muted', tone === 'success' && 'text-success-11')}>
        {formatAmount(value)}
      </span>
    </div>
  )
}

function CustomerCard({ customer, onAttach, onClear }: { customer: Customer | null; onAttach: () => void; onClear: () => void }) {
  if (!customer) {
    return (
      <button
        type="button"
        onClick={onAttach}
        className="flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted hover:border-border-strong hover:bg-hover hover:text-fg"
      >
        <UserPlus size={16} aria-hidden />
        <span className="flex-1 text-left">Walk-in customer</span>
        <Kbd>Alt+U</Kbd>
      </button>
    )
  }
  return (
    <div className="rounded-[var(--radius-md)] border border-border p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium">{customer.name}</div>
          <div className="mono text-xs text-fg-muted">{customer.phone}</div>
        </div>
        <button type="button" onClick={onClear} aria-label="Remove customer" className="text-fg-subtle hover:text-fg">
          <X size={14} aria-hidden />
        </button>
      </div>
      {Number(customer.outstanding) > 0 && (
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-fg-muted">Outstanding</span>
          <span className="num font-medium text-warning-11">{formatMoney(customer.outstanding)}</span>
        </div>
      )}
      {/* A dispensing safety control, not decoration: it must be impossible to miss. */}
      {customer.allergies.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 rounded-[var(--radius-sm)] bg-danger-3 px-2 py-1.5 text-xs text-danger-11">
          <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span><strong className="font-semibold">Allergic:</strong> {customer.allergies.join(', ')}</span>
        </div>
      )}
    </div>
  )
}
