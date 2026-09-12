import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, FileText, Search, Store, TriangleAlert, Truck, X } from 'lucide-react'
import type { BatchRow, StockTransferDoc, StoreProfile } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { EmptyState, SkeletonRows } from '@/components/states'

/**
 * Sending stock to another branch.
 *
 * The commonest thing a chain does once there are two shops, and without it a
 * branch that runs out orders from a distributor while the head shop has two
 * hundred on the shelf.
 *
 * The screen's job is to make the DOCUMENT visible before anything moves. Two
 * branches on one GSTIN are one legal person and this is not a supply — it
 * travels on a delivery challan with no tax. Two GSTINs are two persons, even on
 * the same PAN, and the movement is a supply needing a tax invoice. Most
 * operators have never been told those are different, so the panel says which
 * one this is and why, before the button is pressed rather than after.
 */
export function TransferDialog({
  open, onOpenChange, currentStore,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  currentStore: StoreProfile
}) {
  const api = useApi()
  const qc = useQueryClient()

  const [toStoreId, setToStoreId] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [term, setTerm] = useState('')
  const [qty, setQty] = useState<Record<number, string>>({})

  // A dialog is exclusive: without this, F2 starts a new bill under the overlay.
  useHotkeys('modal', {}, { enabled: open })

  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api.listStores(), enabled: open })
  const stock = useQuery({
    queryKey: ['inventory', 'forTransfer', term],
    /* By NAME, not by expiry.
       Expiry-ascending is right for the inventory screen, whose job is managing
       what is about to go off — but here it filled the whole page with stock
       that cannot be sent, because the client-side expired filter runs AFTER the
       server's limit. Sorting by name also matches how the request arrives:
       somebody rings and asks for Dolo, not for whatever expires soonest. */
    queryFn: () => api.listBatches({ term: term.trim(), sort: 'name', limit: 40 }),
    enabled: open,
  })

  const others = (stores.data ?? []).filter((s) => s.id !== currentStore.id)

  /* Expired stock is left OUT of the list, not merely refused when picked.
     The shelf is sorted soonest-expiry-first — which is right, because a
     transfer should move the oldest sellable stock and keep FEFO working across
     branches — but that puts anything already out of date at the very top, so
     the first thing an operator saw was stock they could never send. Moving it
     would only relocate a write-off; the expiry-claim screen is where it goes. */
  const today = new Date().toISOString().slice(0, 10)
  const sendable = (stock.data?.rows ?? []).filter((r) => r.batch.expiryDate >= today)
  const hiddenExpired = (stock.data?.rows ?? []).length - sendable.length

  const lines = useMemo(
    () => Object.entries(qty)
      .filter(([, v]) => v.trim() !== '' && Number(v) > 0)
      .map(([batchId, v], i) => ({ lineId: `t${i + 1}`, batchId: Number(batchId), qty: v })),
    [qty],
  )

  const input = toStoreId === null || lines.length === 0
    ? null
    : {
        idempotencyKey: `trf-${currentStore.id}-${toStoreId}-${JSON.stringify(lines)}`,
        fromStoreId: currentStore.id,
        toStoreId,
        issuedOn: new Date().toISOString().slice(0, 10),
        reason: reason.trim(),
        lines,
      }

  /* Priced live so the document and the refusal both appear before the button is
     pressed. A quote consumes no number. */
  const quote = useQuery({
    queryKey: ['transferQuote', input],
    queryFn: () => api.quoteTransfer(input as NonNullable<typeof input>),
    enabled: input !== null && reason.trim().length >= 6,
    retry: false,
  })

  const post = useMutation({
    mutationFn: () => api.postTransfer(input as NonNullable<typeof input>),
    onSuccess: (doc: StockTransferDoc) => {
      toast.success(`${doc.documentNo} sent to ${doc.toStoreName}`, {
        description: `${doc.lines.length} batch${doc.lines.length === 1 ? '' : 'es'} · ₹${formatAmount(doc.totalValue)} at cost`,
      })
      setQty({})
      setReason('')
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['transfers'] })
      onOpenChange(false)
    },
    onError: (e) => {
      toast.error('Nothing was moved', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const blocker = toStoreId === null
    ? 'Choose the branch it is going to'
    : lines.length === 0
      ? 'Nothing selected to send'
      : reason.trim().length < 6
        ? 'Say why the stock is moving'
        : quote.error
          ? (quote.error instanceof ApiError ? quote.error.message : 'This cannot be priced')
          : null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgb(16_24_40/.35)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]">
          <header className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-3">
            <div className="flex items-start gap-3">
              <Truck size={18} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">
                  Send stock to another branch
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
                  Leaves {currentStore.name} and arrives on the other branch&rsquo;s shelf as the
                  same batch — same number, same expiry, same printed MRP.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-2.5 flex flex-wrap items-end gap-2">
              <span className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-subtle px-2 py-1 text-2xs text-fg-muted">
                <Store size={12} aria-hidden /> {currentStore.name}
              </span>
              <ArrowRight size={14} className="mb-1.5 text-fg-subtle" aria-hidden />
              <label className="flex min-w-[180px] flex-1 flex-col gap-1">
                <span className="micro-label">To branch</span>
                <select
                  aria-label="To branch"
                  value={toStoreId ?? ''}
                  onChange={(e) => setToStoreId(e.target.value === '' ? null : Number(e.target.value))}
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                >
                  <option value="">Choose a branch…</option>
                  {others.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} · {s.city}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[200px] flex-[2] flex-col gap-1">
                <span className="micro-label">Why it is moving</span>
                <input
                  aria-label="Why it is moving"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Kothrud is short before the weekend"
                  autoComplete="off"
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base"
                />
              </label>
            </div>

            {/* The document, and WHY — before anything moves. Most operators have
                never been told a challan and an invoice are different here. */}
            {quote.data ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2.5 py-1.5 text-2xs text-fg-muted">
                <FileText size={12} className="mt-px shrink-0" aria-hidden />
                <span>
                  <span className="font-medium text-fg">
                    {quote.data.document === 'CHALLAN' ? 'Delivery challan' : 'Tax invoice'}
                  </span>
                  {' — '}{quote.data.basis}
                </span>
              </p>
            ) : null}
          </header>

          <div className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-2.5">
            {hiddenExpired > 0 ? (
              <p className="mb-1.5 text-2xs text-fg-subtle">
                <span className="num">{hiddenExpired}</span> expired batch
                {hiddenExpired === 1 ? ' is' : 'es are'} not listed — moving those relocates a
                write-off rather than fixing a shortage.
              </p>
            ) : null}
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                type="search"
                aria-label="Find stock to send"
                placeholder="Find a batch by brand or batch number…"
                className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-3 text-base"
              />
            </div>
          </div>

          <div className="scroll-region min-h-0 flex-1 overflow-auto">
            {stock.isPending ? (
              <SkeletonRows rows={8} cols={4} />
            ) : sendable.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No stock matches that"
                body="Only this branch's sellable shelf is listed — a transfer can only send what is actually here and still in date."
              />
            ) : (
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10 bg-subtle">
                  <tr>
                    {['Medicine', 'Batch', 'Expiry', 'On hand', 'Send'].map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn(
                          'micro-label border-b border-border-subtle px-[var(--cell-px)] py-2',
                          i >= 3 ? 'text-right' : 'text-left',
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sendable.map((row: BatchRow) => (
                    <Row
                      key={row.batch.id}
                      row={row}
                      value={qty[row.batch.id] ?? ''}
                      onChange={(v) => setQty((prev) => {
                        const next = { ...prev }
                        if (v.trim() === '') delete next[row.batch.id]
                        else next[row.batch.id] = v
                        return next
                      })}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-[var(--card-px)] py-3">
            <div className="min-w-0">
              <span className="micro-label block">
                {lines.length} batch{lines.length === 1 ? '' : 'es'} at cost
              </span>
              <span className="display-num text-2xl text-fg">
                ₹{formatAmount(quote.data?.totalValue ?? '0.00')}
              </span>
              {/* Cost, not price: nothing is being sold here, and showing an MRP
                  total would make a challan look like a sale. */}
              <span className="ml-2 text-2xs text-fg-subtle">a declared value, not a price</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {blocker ? (
                <span className="flex items-center gap-1.5 text-2xs text-warning-11">
                  <TriangleAlert size={13} aria-hidden /> {blocker}
                </span>
              ) : null}
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button
                variant="primary"
                disabled={blocker !== null || post.isPending}
                onClick={() => post.mutate()}
              >
                <Truck /> Send
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({
  row, value, onChange,
}: {
  row: BatchRow
  value: string
  onChange: (v: string) => void
}) {
  const { batch, medicine } = row
  return (
    <tr className={cn('border-b border-border-subtle', value !== '' && 'bg-accent-1')}>
      <td className="max-w-0 truncate px-[var(--cell-px)] py-2 text-base text-fg" title={medicine.brandName}>
        {medicine.brandName} <span className="text-2xs text-fg-subtle">{medicine.packLabel}</span>
      </td>
      <td className="mono px-[var(--cell-px)] py-2 text-xs text-fg-muted">{batch.batchNo}</td>
      <td className="mono num px-[var(--cell-px)] py-2 text-xs text-fg-muted">
        {formatExpiry(batch.expiryDate)}
      </td>
      <td className="num px-[var(--cell-px)] py-2 text-right text-sm text-fg-muted">{batch.qtyOnHand}</td>
      <td className="px-[var(--cell-px)] py-2 text-right">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          aria-label={`Units of ${medicine.brandName} batch ${batch.batchNo} to send`}
          placeholder="0"
          className="num h-8 w-24 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-right text-base hover:border-border-strong"
        />
      </td>
    </tr>
  )
}
