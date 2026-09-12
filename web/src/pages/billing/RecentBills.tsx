import { useState } from 'react'
import { Popover } from 'radix-ui'
import {
  Ban, Banknote, CircleCheck, CreditCard, History, Landmark, Printer, QrCode,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaymentMode, SaleInvoice } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Kbd } from '@/components/ui/Kbd'
import { useHotkeys } from '@/hooks/useHotkeys'

/**
 * The last few bills, reprintable where they were raised.
 *
 * "Reprint the last one" is the single most common thing asked of a counter
 * after the customer has walked three steps away, and today it means leaving
 * the till for the Sales register — which discards the bill in progress if one
 * has been started. Ctrl+P already reprints the bill THIS session posted; this
 * covers the other cases: the previous shift's, the one two customers ago, and
 * the one the paper jammed on.
 */

const MODE_ICON: Record<PaymentMode, LucideIcon> = {
  CASH: Banknote, UPI: QrCode, CARD: CreditCard, CREDIT: Landmark,
}

const MODE_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Khata',
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function RecentBillRow({
  invoice, onReprint, dense,
}: {
  invoice: SaleInvoice
  onReprint: (invoice: SaleInvoice) => void
  /** The header popover runs tighter than the counter-home strip. */
  dense?: boolean
}) {
  const voided = invoice.status === 'VOIDED'
  const modes = [...new Set(invoice.payments.map((p) => p.mode))]

  return (
    <div
      className={cn(
        'group flex items-center gap-3 border-b border-border-subtle last:border-0',
        dense ? 'h-11 px-3' : 'h-12 px-4',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-baseline gap-2">
          <span className="mono shrink-0 text-xs font-medium">{invoice.invoiceNo}</span>
          <span className="num shrink-0 text-2xs text-fg-subtle">{timeOf(invoice.createdAt)}</span>
          {/* Status is a word AND an icon — a voided bill reprints, and the
              person holding the paper has to be able to tell which it is. */}
          {voided && (
            <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-danger-11">
              <Ban size={11} aria-hidden /> Voided
            </span>
          )}
        </div>
        <span className="truncate text-2xs text-fg-muted">
          {invoice.customerName ?? 'Walk-in'} · {invoice.quote.lines.length}{' '}
          {invoice.quote.lines.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      <span className="flex shrink-0 items-center gap-1">
        {modes.map((m) => {
          const Icon = MODE_ICON[m]
          return (
            <span key={m} className="flex items-center gap-1 text-2xs text-fg-muted">
              <Icon size={12} aria-hidden /> {MODE_LABEL[m]}
            </span>
          )
        })}
      </span>

      <span className={cn('num shrink-0 text-sm font-medium', voided && 'text-fg-subtle line-through')}>
        {formatAmount(invoice.quote.netAmount)}
      </span>

      <button
        type="button"
        onClick={() => onReprint(invoice)}
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border',
          'px-2 py-1 text-2xs font-medium text-fg-muted',
          'hover:border-border-strong hover:bg-hover hover:text-fg',
        )}
      >
        <Printer size={13} aria-hidden /> Reprint
      </button>
    </div>
  )
}

export function RecentBillsList({
  invoices, loading, onReprint, dense, emptyHint,
}: {
  invoices: SaleInvoice[]
  loading: boolean
  onReprint: (invoice: SaleInvoice) => void
  dense?: boolean
  emptyHint: string
}) {
  if (loading) {
    return <p className="px-4 py-6 text-center text-xs text-fg-subtle">Reading today&rsquo;s register…</p>
  }
  if (invoices.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-fg-subtle">{emptyHint}</p>
  }
  return (
    <div>
      {invoices.map((inv) => (
        <RecentBillRow key={inv.id} invoice={inv} onReprint={onReprint} dense={dense} />
      ))}
    </div>
  )
}

/** The header affordance. Alt+R, and the same list the counter home shows. */
export function RecentBillsButton({
  invoices, loading, onReprint,
}: {
  invoices: SaleInvoice[]
  loading: boolean
  onReprint: (invoice: SaleInvoice) => void
}) {
  const [open, setOpen] = useState(false)

  useHotkeys('billing', { 'bill.recent': () => setOpen((v) => !v) })
  /* Exclusive while it is up, exactly as DoctorBar's popover is: otherwise
     Escape closes this AND steps the bill back a stage. */
  useHotkeys('modal', {}, { enabled: open })

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-border',
            'bg-surface px-3 text-sm text-fg-muted',
            'hover:border-border-strong hover:bg-hover hover:text-fg',
          )}
        >
          <History size={15} aria-hidden />
          Recent bills
          <Kbd>Alt+R</Kbd>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[440px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle bg-subtle px-4 py-2">
            <CircleCheck size={14} className="text-fg-subtle" aria-hidden />
            <span className="micro-label">Posted today</span>
            <span className="ml-auto text-2xs text-fg-subtle">Reprint never opens the drawer</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <RecentBillsList
              invoices={invoices}
              loading={loading}
              onReprint={onReprint}
              dense
              emptyHint="No bills posted today yet."
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
