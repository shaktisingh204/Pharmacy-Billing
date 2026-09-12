import { useCallback, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BadgeIndianRupee, Ban, CircleAlert, FileMinus2, PackageX, Plus, Search, Trash2, TriangleAlert,
} from 'lucide-react'
import type {
  BatchRow, ReturnKind, Supplier, SupplierReturn, SupplierReturnInput, SupplierReturnLineInput,
} from '@contract'
import { ApiError, RETURN_KINDS } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatPercent } from '@/lib/format'
import {
  RETURN_KIND_ACTION, RETURN_KIND_BASIS, RETURN_KIND_LABEL, claimPosition,
} from '@/api/supplierReturns'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Figure, Meter, MoneyStat, Panel, PanelFooter } from './parts'

/**
 * Stock going back to a supplier — as TWO documents, chosen up front.
 *
 * The choice is the first control on the screen and it is not a dropdown buried
 * in a form, because it decides which document the shop issues and what the tax
 * does. CBIC Circular 72/46/2018 gives two routes for goods coming back:
 *
 *  - a DEBIT NOTE against the purchase bill, reversing the credit that bill gave;
 *  - a fresh OUTWARD TAX INVOICE for expiry and breakage, on which the shop
 *    charges tax and then waits — usually to be paid short.
 *
 * Every incumbent this was researched against models these as one "purchase
 * return" with a type flag somewhere inside, which is how a shop ends up with
 * expiry claims booked as reductions of a supplier's bill: the payable is
 * understated from the day the claim is raised, and the shortfall — the money
 * actually lost to breakage allowances — has nowhere to live at all.
 *
 * So the two are separated at the top, each carries the sentence explaining what
 * it does to the tax, and the claim side gets a position panel that keeps claim
 * value, credit received and shortfall as three numbers.
 */

const KEY = ['supplierReturns'] as const

interface Draft {
  batchId: number
  qty: string
}

export function SupplierReturns({
  today, initialSupplierId, initialAgainstPurchaseId,
}: {
  today: string
  /** Handed over by the register's "raise a debit note" action. */
  initialSupplierId?: number | null
  initialAgainstPurchaseId?: number | null
}) {
  const api = useApi()
  const qc = useQueryClient()

  const [kind, setKind] = useState<ReturnKind>('PURCHASE_RETURN')
  const [supplierId, setSupplierId] = useState<number | null>(initialSupplierId ?? null)
  const [againstPurchaseId, setAgainstPurchaseId] = useState<number | null>(
    initialAgainstPurchaseId ?? null,
  )
  const [reason, setReason] = useState('')
  const [term, setTerm] = useState('')
  const [draft, setDraft] = useState<Draft[]>([])

  /* The handoff can land on an already-mounted screen. Adjusted during render
     rather than in an effect: an effect would paint one frame of the previous
     supplier's draft, and this screen's whole job is to keep a debit note
     pointed at the right bill. */
  const [lastHandoff, setLastHandoff] = useState(initialAgainstPurchaseId ?? null)
  if ((initialAgainstPurchaseId ?? null) !== lastHandoff) {
    setLastHandoff(initialAgainstPurchaseId ?? null)
    if (initialAgainstPurchaseId != null) {
      setKind('PURCHASE_RETURN')
      setAgainstPurchaseId(initialAgainstPurchaseId)
      if (initialSupplierId != null) setSupplierId(initialSupplierId)
    }
  }

  const suppliers = useQuery({
    queryKey: ['suppliers', ''],
    queryFn: () => api.listSuppliers(),
  })

  const purchases = useQuery({
    queryKey: ['purchases', 'forReturn'],
    queryFn: () => api.listPurchases({ limit: 200 }),
  })

  const stock = useQuery({
    queryKey: ['inventory', 'forReturn', term],
    /* Soonest expiry first, which is the order a claim is actually built in —
       and it puts the expired stock, the whole point of the claim side, at the
       top without needing a filter. */
    queryFn: () => api.listBatches({ term: term.trim(), sort: 'expiry', limit: 60 }),
    placeholderData: keepPreviousData,
  })

  const posted = useQuery({ queryKey: KEY, queryFn: () => api.listSupplierReturns({}) })

  /* The claim position is computed over EVERY claim, never over the filtered
     view: a shortfall figure that changes when you type in a search box is a
     figure nobody can quote to a supplier. */
  const position = useMemo(() => claimPosition(posted.data ?? []), [posted.data])

  const lines: SupplierReturnLineInput[] = useMemo(
    () => draft
      .filter((d) => d.qty.trim() !== '' && Number(d.qty) > 0)
      .map((d, i) => ({ lineId: `l${i + 1}`, batchId: d.batchId, qty: d.qty })),
    [draft],
  )

  const input: SupplierReturnInput | null = supplierId === null || lines.length === 0
    ? null
    : {
        idempotencyKey: `sr-${kind}-${supplierId}-${today}-${JSON.stringify(lines)}`,
        kind,
        supplierId,
        againstPurchaseId: kind === 'PURCHASE_RETURN' ? againstPurchaseId : null,
        issuedOn: today,
        terminalId: 1,
        reason: reason.trim(),
        lines,
      }

  /* Priced live, and a pricing failure is shown as the REASON the document
     cannot be posted rather than swallowed — an operator staring at a dead
     button with no explanation is the failure mode this replaces. */
  const quote = useQuery({
    queryKey: ['supplierReturns', 'quote', input],
    queryFn: () => api.quoteSupplierReturn(input as SupplierReturnInput),
    enabled: input !== null && reason.trim().length >= 6,
    retry: false,
    placeholderData: keepPreviousData,
  })

  const post = useMutation({
    mutationFn: (v: SupplierReturnInput) => api.postSupplierReturn(v),
    onSuccess: (doc) => {
      toast.success(`${RETURN_KIND_LABEL[doc.kind]} ${doc.documentNo} posted`, {
        description: `${doc.lines.length} batch${doc.lines.length === 1 ? '' : 'es'} · ₹${formatAmount(doc.netAmount)}`,
      })
      setDraft([])
      setReason('')
      void qc.invalidateQueries({ queryKey: KEY })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
    },
    onError: (e) => {
      toast.error('The document was not posted', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const setQty = useCallback((batchId: number, qty: string) => {
    setDraft((prev) => {
      const without = prev.filter((d) => d.batchId !== batchId)
      return qty.trim() === '' ? without : [...without, { batchId, qty }]
    })
  }, [])

  const qtyOf = (batchId: number): string =>
    draft.find((d) => d.batchId === batchId)?.qty ?? ''

  const supplierBills = (purchases.data?.rows ?? [])
    .filter((p) => supplierId === null || p.supplierId === supplierId)

  const blocker = blockerFor({
    kind,
    supplierId,
    againstPurchaseId,
    reason,
    lineCount: lines.length,
    quoteError: quote.error,
  })

  const rows = stock.data?.rows ?? []

  return (
    <div className="flex min-h-0 flex-1 gap-[var(--card-gap)]">
      <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-[var(--card-px)]">
          {/* The choice FIRST, and spelled out. It decides which document the
              shop issues and what happens to the tax, and most operators have
              never been told the two are different. */}
          <div role="radiogroup" aria-label="What kind of return" className="flex flex-wrap gap-3">
            {RETURN_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => { setKind(k); setAgainstPurchaseId(null) }}
                className={cn(
                  'flex min-w-[260px] flex-1 flex-col items-start gap-1 rounded-[var(--radius-xl)] border px-4 py-3 text-left',
                  'transition-[background-color,border-color,box-shadow] duration-[var(--dur-base)]',
                  kind === k
                    ? 'border-accent-9/45 bg-accent-1 shadow-[var(--shadow-xs)]'
                    : 'border-border bg-surface hover:border-border-strong',
                )}
              >
                <span className="flex items-center gap-2 text-base font-semibold text-fg">
                  {k === 'PURCHASE_RETURN'
                    ? <FileMinus2 size={16} aria-hidden />
                    : <PackageX size={16} aria-hidden />}
                  {RETURN_KIND_ACTION[k]}
                  {kind === k ? (
                    <span className="ml-1 rounded-[var(--radius-sm)] bg-accent-10 px-1.5 py-0.5 text-2xs font-medium text-fg-on-accent">
                      {RETURN_KIND_LABEL[k]}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs leading-relaxed text-fg-muted">{RETURN_KIND_BASIS[k]}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1">
              <span className="micro-label">Supplier</span>
              <select
                aria-label="Supplier"
                value={supplierId ?? ''}
                onChange={(e) => {
                  setSupplierId(e.target.value === '' ? null : Number(e.target.value))
                  // The bill belongs to the old supplier. Keeping it would let a
                  // debit note reduce the wrong account.
                  setAgainstPurchaseId(null)
                }}
                className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong"
              >
                <option value="">Choose a supplier…</option>
                {(suppliers.data ?? []).map((s: Supplier) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>

            {kind === 'PURCHASE_RETURN' ? (
              <label className="flex min-w-[200px] flex-1 flex-col gap-1">
                <span className="micro-label">Against bill</span>
                <select
                  aria-label="Against bill"
                  value={againstPurchaseId ?? ''}
                  onChange={(e) => setAgainstPurchaseId(e.target.value === '' ? null : Number(e.target.value))}
                  disabled={supplierId === null}
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong disabled:opacity-55"
                >
                  <option value="">Choose the bill…</option>
                  {supplierBills.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.supplierInvoiceNo} · {p.invoiceDate} · ₹{formatAmount(p.netAmount)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex min-w-[240px] flex-[2] flex-col gap-1">
              <span className="micro-label">Why it is going back</span>
              <input
                aria-label="Why it is going back"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={kind === 'PURCHASE_RETURN'
                  ? 'Wrong strength delivered against the order'
                  : 'Expired on the shelf; claiming against the manufacturer'}
                autoComplete="off"
                className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base hover:border-border-strong"
              />
            </label>
          </div>
        </div>

        <div className="shrink-0 border-b border-border-subtle bg-raised px-[var(--card-px)] py-2.5">
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              type="search"
              aria-label="Find stock to send back"
              placeholder="Find a batch by brand or batch number — soonest expiry first…"
              className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-10 pr-3 text-base hover:border-border-strong"
            />
          </div>
        </div>

        <div data-density="compact" className="scroll-region min-h-0 flex-1 overflow-auto">
          {stock.isPending ? (
            <SkeletonRows rows={10} cols={5} />
          ) : stock.error ? (
            <ErrorState
              code={stock.error instanceof ApiError ? stock.error.code : 'STOCK_FAILED'}
              message={(stock.error as Error).message}
              onRetry={() => void stock.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No stock matches that"
              body="Search by brand or batch number. Expired and quarantined batches are listed here too — those are exactly what a claim is made of."
            />
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-subtle">
                <tr>
                  {['Medicine', 'Batch', 'Expiry', 'On hand', 'Send back'].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={cn(
                        'micro-label border-b border-border-subtle px-3 py-2',
                        i >= 3 ? 'text-right' : 'text-left',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: BatchRow) => (
                  <StockRow
                    key={row.batch.id}
                    row={row}
                    today={today}
                    qty={qtyOf(row.batch.id)}
                    onQty={(v) => setQty(row.batch.id, v)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="shrink-0 border-t border-border-subtle px-[var(--card-px)] py-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-0">
              <MoneyStat
                label={`${RETURN_KIND_LABEL[kind]} · ${lines.length} batch${lines.length === 1 ? '' : 'es'}`}
                amount={quote.data?.netAmount ?? '0.00'}
                size="lg"
                hint={quote.data ? (
                  <>
                    taxable <span className="num">{formatAmount(quote.data.taxableValue)}</span>
                    {' '}· tax{' '}
                    <span className="num">
                      {formatAmount(D.toStr(D.sum([
                        D.dec(quote.data.cgst), D.dec(quote.data.sgst), D.dec(quote.data.igst),
                      ]), 2))}
                    </span>
                    {/* Purchase-side money is exclusive of tax. Said here because
                        the counter's is not, and the two screens sit in one app. */}
                    {' '}· rates are GST-exclusive
                  </>
                ) : 'Nothing priced yet — pick the batches going back.'}
              />
            </div>

            <div className="ml-auto flex items-center gap-3">
              {blocker ? (
                <span className="flex items-center gap-1.5 text-xs text-warning-11">
                  <CircleAlert size={14} aria-hidden /> {blocker}
                </span>
              ) : null}
              <Button
                variant="primary"
                size="lg"
                disabled={blocker !== null || input === null || post.isPending}
                onClick={() => { if (input) post.mutate(input) }}
              >
                <Plus /> Post {RETURN_KIND_LABEL[kind].toLowerCase()}
              </Button>
            </div>
          </div>
        </footer>
      </div>

      <ClaimsPanel
        position={position}
        docs={posted.data ?? []}
        loading={posted.isPending}
        today={today}
        onSettled={() => void qc.invalidateQueries({ queryKey: KEY })}
      />
    </div>
  )
}

/**
 * Why the post button is refused, in one line, BEFORE it is pressed.
 *
 * Every one of these is something the adapter would throw on. Learning a rule
 * from a red toast after telling a supplier's driver the goods are going back is
 * the failure this replaces.
 */
function blockerFor(v: {
  kind: ReturnKind
  supplierId: number | null
  againstPurchaseId: number | null
  reason: string
  lineCount: number
  quoteError: unknown
}): string | null {
  if (v.supplierId === null) return 'Choose a supplier'
  if (v.kind === 'PURCHASE_RETURN' && v.againstPurchaseId === null) {
    return 'A debit note has to name the bill it reduces'
  }
  if (v.lineCount === 0) return 'Nothing selected to send back'
  if (v.reason.trim().length < 6) return 'Say why it is going back'
  if (v.quoteError) {
    return v.quoteError instanceof ApiError
      ? v.quoteError.message
      : 'This cannot be priced'
  }
  return null
}

function StockRow({
  row, today, qty, onQty,
}: {
  row: BatchRow
  today: string
  qty: string
  onQty: (v: string) => void
}) {
  const { batch, medicine } = row
  const expired = batch.expiryDate <= today
  const picked = qty !== ''
  return (
    <tr className={cn('border-b border-border-subtle', picked ? 'bg-accent-1' : 'hover:bg-hover')}>
      <td className="max-w-0 truncate px-3 py-2 text-base text-fg" title={medicine.brandName}>
        {medicine.brandName}
        <span className="ml-1.5 text-2xs text-fg-subtle">{medicine.packLabel}</span>
      </td>
      <td className="mono px-3 py-2 text-xs text-fg-muted">{batch.batchNo}</td>
      <td className={cn('num px-3 py-2 text-xs', expired ? 'text-danger-11' : 'text-fg-muted')}>
        <span className="mono">{formatExpiry(batch.expiryDate)}</span>
        {/* The word AND a mark as well as the colour. These rows are read at an
            angle on a matte counter panel, and red alone does not survive that. */}
        {expired ? (
          <span className="ml-1.5 inline-flex items-center gap-1">
            <Ban size={11} aria-hidden /> expired
          </span>
        ) : null}
        {batch.isQuarantined ? (
          <span className="ml-1.5 inline-flex items-center gap-1 text-warning-11">
            <TriangleAlert size={11} aria-hidden /> held
          </span>
        ) : null}
      </td>
      <td className="num px-3 py-2 text-right text-sm text-fg-muted">{batch.qtyOnHand}</td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <input
            value={qty}
            onChange={(e) => onQty(e.target.value)}
            inputMode="decimal"
            aria-label={`Units of ${medicine.brandName} batch ${batch.batchNo} to send back`}
            placeholder="0"
            className="num h-8 w-24 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-right text-sm hover:border-border-strong"
          />
          {picked ? (
            <button
              type="button"
              onClick={() => onQty('')}
              aria-label={`Remove ${medicine.brandName} batch ${batch.batchNo}`}
              className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-danger-11"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}

/** Days since a claim was issued, on the shop's calendar. */
function ageInDays(issuedOn: string, today: string): number {
  const a = Date.parse(`${issuedOn}T00:00:00Z`)
  const b = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/**
 * The claim book: what was claimed, what came back, and what did not.
 *
 * Three numbers rather than one balance, because a shortfall and an outstanding
 * claim are different money — the first has been decided and lost to a breakage
 * allowance, the second is still chaseable. Netting them into one figure hides
 * the only number worth acting on.
 */
function ClaimsPanel({
  position, docs, loading, today, onSettled,
}: {
  position: ReturnType<typeof claimPosition>
  docs: SupplierReturn[]
  loading: boolean
  today: string
  onSettled: () => void
}) {
  const api = useApi()
  const [openId, setOpenId] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [ref, setRef] = useState('')

  const settle = useMutation({
    mutationFn: (v: { returnId: number; creditReceived: string; creditNoteRef: string }) =>
      api.settleClaim(v),
    onSuccess: (doc) => {
      const short = D.sub(D.dec(doc.netAmount), D.dec(doc.creditReceived ?? '0'))
      toast.success(`${doc.documentNo} settled`, {
        description: D.gt(short, D.ZERO)
          ? `₹${formatAmount(D.toStr(short, 2))} short of the claim — recorded, not written off quietly`
          : 'Credited in full',
      })
      setOpenId(null)
      setAmount('')
      setRef('')
      onSettled()
    },
    onError: (e) => {
      toast.error('Not recorded', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const claims = docs.filter((d) => d.kind === 'EXPIRY_CLAIM' && d.status === 'POSTED')

  /* Settled value against credit received. The one number that says whether a
     manufacturer is worth claiming from — and it is over SETTLED claims only,
     because a rate that falls whenever a new claim is raised measures the
     calendar rather than the supplier. */
  const settledValue = D.sub(D.dec(position.claimed), D.dec(position.outstanding))
  const settlementPct = D.isZero(settledValue)
    ? null
    : D.toStr(D.div(D.mul(D.dec(position.received), D.HUNDRED), settledValue), 1)

  const oldestOpen = claims
    .filter((d) => d.creditReceived === null)
    .reduce<string | null>((oldest, d) => (oldest === null || d.issuedOn < oldest ? d.issuedOn : oldest), null)

  return (
    <Panel
      className="hidden w-[344px] shrink-0 xl:flex"
      title="Expiry claims"
      icon={BadgeIndianRupee}
    >
      <div className="shrink-0 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
        <MoneyStat
          label="Waiting on a credit note"
          amount={position.outstanding}
          size="lg"
          tone={D.gt(D.dec(position.outstanding), D.ZERO) ? 'warning' : 'default'}
          /* Deliberately NOT the same sentence as the line below it. Two
             elements saying "N awaiting credit" is a reader wondering whether
             they are two different numbers. */
          hint={
            <>
              <span className="num">{position.openCount}</span> claim
              {position.openCount === 1 ? '' : 's'} still open
              {oldestOpen !== null ? (
                <> · oldest raised <span className="num">{ageInDays(oldestOpen, today)}</span> days ago</>
              ) : null}
            </>
          }
        />

        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border-subtle pt-3">
          <Figure label="Claimed" value={`₹${formatAmount(position.claimed)}`} />
          <Figure label="Received" value={`₹${formatAmount(position.received)}`} />
          {/* Shortfall carries the warning tone, because it is the one figure
              here that is already lost rather than still being chased. */}
          <Figure
            label="Short"
            value={`₹${formatAmount(position.shortfall)}`}
            tone={D.gt(D.dec(position.shortfall), D.ZERO) ? 'warning' : 'default'}
          />
        </div>

        {settlementPct !== null ? (
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="micro-label">Settled at</span>
              <span className="num text-sm font-medium text-fg">{formatPercent(settlementPct)}</span>
            </div>
            <div className="mt-1">
              <Meter
                pct={Number.parseFloat(settlementPct)}
                tone={D.gte(D.dec(settlementPct), D.dec('90')) ? 'success' : 'warning'}
                ariaLabel="Credit received as a share of the claims that have been settled"
              />
            </div>
          </div>
        ) : null}

        <p className="mt-2 text-2xs text-fg-subtle">
          <span className="num">{position.openCount}</span> awaiting credit
          {' '}(<span className="num">₹{formatAmount(position.outstanding)}</span>),{' '}
          <span className="num">{position.settledCount}</span> settled.
        </p>
      </div>

      <div data-density="comfortable" className="scroll-region min-h-0 flex-1 overflow-auto">
        {loading ? (
          <SkeletonRows rows={5} cols={2} />
        ) : claims.length === 0 ? (
          <EmptyState
            icon={PackageX}
            title="No claims raised"
            body="Expired and broken stock issued to a supplier appears here until their credit note arrives."
          />
        ) : (
          <ul>
            {claims.map((doc) => {
              const short = doc.creditReceived === null
                ? null
                : D.sub(D.dec(doc.netAmount), D.dec(doc.creditReceived))
              return (
                <li key={doc.id} className="border-b border-border-subtle px-[var(--card-px)] py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="mono truncate text-sm font-medium text-fg">{doc.documentNo}</span>
                    <span className="num ml-auto text-base font-medium text-fg">
                      ₹{formatAmount(doc.netAmount)}
                    </span>
                  </div>
                  <div className="truncate text-2xs text-fg-muted">
                    {doc.supplierName} · {doc.issuedOn}
                    {doc.creditReceived === null
                      ? <> · <span className="num">{ageInDays(doc.issuedOn, today)}</span> days open</>
                      : null}
                  </div>

                  {doc.creditReceived === null ? (
                    openId === doc.id ? (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <input
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          inputMode="decimal"
                          aria-label={`Credit received against ${doc.documentNo}`}
                          placeholder="Credit received"
                          className="num h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-right text-sm"
                        />
                        <input
                          value={ref}
                          onChange={(e) => setRef(e.target.value)}
                          aria-label={`Their credit note number for ${doc.documentNo}`}
                          placeholder="Their credit note no."
                          className="h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm"
                        />
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={settle.isPending || amount.trim() === '' || ref.trim() === ''}
                            onClick={() => settle.mutate({
                              returnId: doc.id,
                              creditReceived: amount.trim(),
                              creditNoteRef: ref.trim(),
                            })}
                          >
                            Record
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setOpenId(doc.id); setAmount(''); setRef('') }}
                        className="mt-1.5 text-xs font-medium text-accent-11 hover:underline"
                      >
                        Record their credit
                      </button>
                    )
                  ) : (
                    <div className="mt-1 flex items-baseline gap-1.5 text-2xs">
                      <span className="text-fg-muted">
                        got <span className="num">₹{formatAmount(doc.creditReceived)}</span>
                      </span>
                      {short && D.gt(short, D.ZERO) ? (
                        <span className="flex items-center gap-1 text-warning-11">
                          <TriangleAlert size={11} aria-hidden />
                          <span className="num">₹{formatAmount(D.toStr(short, 2))}</span> short
                        </span>
                      ) : (
                        <span className="text-success-11">in full</span>
                      )}
                      {doc.creditNoteRef ? (
                        <span className="mono ml-auto truncate text-fg-subtle">{doc.creditNoteRef}</span>
                      ) : null}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <PanelFooter className="text-2xs">
        <Kbd>Tab</Kbd> through the batch quantities
      </PanelFooter>
    </Panel>
  )
}
