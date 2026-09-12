import { useMemo } from 'react'
import {
  ArrowDownRight, ArrowUpRight, BadgeCheck, Ban, CalendarClock, CircleAlert, Coins,
  FileText, Gift, Hourglass, MapPin, Minus, Pencil, Phone, Receipt, ScrollText,
  TrendingUp, TriangleAlert, Truck, Undo2, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Money, PurchaseInvoice, Supplier, SupplierReturn } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney, formatQty } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { Sparkline } from '@/components/charts'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import {
  ageInDays, formatDate, licenceState, monthlySpend, money, rateHistory, returnsPosition,
} from './supplierInsights'
import type { Ageing, LicenceKey, LicenceState, RateRow } from './supplierInsights'

/**
 * One distributor, as a SIDE SHEET.
 *
 * A supplier master is usually shipped as a contact card, which is the wrong
 * object entirely. The questions a buyer opens this to answer are:
 *
 *   1. WHAT DO I OWE HIM, AND HOW OLD IS IT. `Supplier.outstanding` is a single
 *      number and a single number cannot be argued with the man at the counter.
 *      Ageing is derived per bill, so the conversation is "these four bills from
 *      March" and not "the computer says ninety thousand".
 *   2. WHAT DID I PAY LAST TIME. The rate on the bill in his hand is only
 *      meaningful against the rate on the last one, and nobody remembers it.
 *   3. WHAT DOES HE OWE ME BACK. Debit notes are already off the payable; expiry
 *      claims are not, and an unsettled claim is the money most shops lose.
 *   4. IS HIS PAPERWORK GOOD, AND FOR HOW MUCH LONGER. A drug licence has a
 *      date, and buying against a lapsed one puts the shop's own stock in
 *      question.
 *
 * The sheet holds no purchase query of its own: ageing, rate history and the
 * spend trend are all folds over the window the screen already loads, and
 * refetching them per selection would make arrowing down the list N+1 round
 * trips for numbers already in memory.
 */

// -------------------------------------------------------------- the sheet ---

export type PurchaseStatus = 'ready' | 'loading' | 'error'
export type ReturnsStatus = 'ready' | 'loading' | 'error'

export function SupplierDetail({
  supplier,
  invoices,
  returns,
  ageing,
  today,
  purchaseStatus,
  purchaseError,
  returnsStatus,
  onClose,
  onEdit,
  onRetryPurchases,
  onRecordPurchase,
  onRaiseReturn,
  onPlanPayment,
}: {
  supplier: Supplier
  /** This supplier's bills out of the loaded window, newest first. */
  invoices: readonly PurchaseInvoice[]
  /** Debit notes and expiry claims raised against him, newest first. */
  returns: readonly SupplierReturn[]
  /** Null while the purchase window has not landed — never a zeroed stand-in. */
  ageing: Ageing | null
  today: Date
  purchaseStatus: PurchaseStatus
  purchaseError?: string
  returnsStatus: ReturnsStatus
  onClose: () => void
  onEdit: () => void
  onRetryPurchases: () => void
  onRecordPurchase: () => void
  onRaiseReturn: () => void
  onPlanPayment: () => void
}) {
  const rates = useMemo(() => rateHistory(invoices), [invoices])
  const recent = useMemo(() => invoices.slice(0, 8), [invoices])
  const spend = useMemo(() => monthlySpend(invoices, today), [invoices, today])
  const position = useMemo(() => returnsPosition(returns, today), [returns, today])
  const licence = useMemo(() => licenceState(supplier, today), [supplier, today])
  const limit = useMemo(
    () => creditBar(supplier.outstanding, supplier.creditLimit),
    [supplier.outstanding, supplier.creditLimit],
  )
  const posted = useMemo(() => returns.filter((r) => r.status === 'POSTED').slice(0, 8), [returns])

  return (
    <aside
      role="complementary"
      aria-label={`${supplier.name} details`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="card flex w-[380px] shrink-0 flex-col overflow-hidden xl:w-[480px]"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle bg-raised px-[var(--card-px)] py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-tight text-fg">{supplier.name}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip icon={CalendarClock}>
              {supplier.paymentTermsDays > 0 ? `${supplier.paymentTermsDays}-day credit` : 'Cash / on delivery'}
            </Chip>
            <LicenceChip state={licence} />
            {supplier.gstin ? null : <Chip icon={FileText} tone="var(--fg-muted)">Unregistered</Chip>}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close supplier details"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={17} aria-hidden />
        </button>
      </header>

      <div className="scroll-region min-h-0 flex-1">
        {/* The hero. One screen, one number: what this distributor is owed. */}
        <div className="border-b border-border-subtle px-[var(--card-px)] py-4">
          <div className="micro-label">Outstanding</div>
          <div
            className={cn(
              'display-num mt-1 text-4xl',
              limit?.tone === 'over' ? 'text-danger-11' : 'text-fg',
            )}
          >
            {formatMoney(supplier.outstanding)}
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {ageing && ageing.openCount > 0
              ? <>across {ageing.openCount} open bill{ageing.openCount === 1 ? '' : 's'}
                {ageing.overdueCount > 0
                  ? <>
                    {' · '}
                    {/* The count is the affordance. A buyer who reads "3 past
                        terms" wants the schedule those three sit in, and making
                        the number itself the way there beats a fourth button
                        competing for the footer of a 380px sheet. */}
                    <button
                      type="button"
                      onClick={onPlanPayment}
                      className="font-medium text-warning-11 underline decoration-warning-9/40 underline-offset-2 hover:decoration-warning-9"
                    >
                      {ageing.overdueCount} past terms — plan the payment
                    </button>
                  </>
                  : null}
                </>
              : D.gt(money(supplier.outstanding) ?? D.ZERO, D.ZERO)
                ? 'Opening balance — no bill in the loaded window to age it against'
                : 'Nothing owed to this distributor'}
          </p>

          {limit ? (
            <div className="mt-3">
              <div
                role="meter"
                aria-label="Credit used with this supplier"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={limit.valueNow}
                aria-valuetext={limit.word}
                className="h-2 w-full overflow-hidden rounded-[var(--radius-full)]"
                style={{ backgroundColor: limit.track }}
              >
                <div
                  className="h-full rounded-[var(--radius-full)]"
                  style={{ width: `${limit.width}%`, backgroundColor: limit.fill }}
                />
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2 text-xs">
                <span className={cn(limit.tone === 'over' ? 'text-danger-11' : 'text-fg-muted')}>
                  {limit.word}
                </span>
                <span className="num text-fg-subtle">
                  limit {formatAmount(supplier.creditLimit)}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-fg-subtle">No credit limit agreed with this distributor.</p>
          )}
        </div>

        <Section title="Ageing" icon={Coins} note="By bill date">
          {purchaseStatus === 'loading' ? (
            <SkeletonRows rows={4} cols={3} />
          ) : purchaseStatus === 'error' || !ageing ? (
            <ErrorState
              code="PURCHASES_FAILED"
              message={purchaseError ?? 'Purchase bills could not be read, so the payable cannot be aged.'}
              onRetry={onRetryPurchases}
            />
          ) : (
            <div className="px-[var(--card-px)] pb-4">
              <AgeingBar ageing={ageing} className="h-2.5" />

              <dl className="mt-3 grid grid-cols-[12px_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
                {ageing.buckets.map((b) => (
                  <div key={b.key} className="contents">
                    <span
                      aria-hidden
                      className="size-3 rounded-[3px]"
                      style={{ backgroundColor: b.tone }}
                    />
                    <dt className="text-sm text-fg-muted">
                      {b.label}
                      {b.count > 0 ? (
                        <span className="ml-1.5 text-2xs text-fg-subtle">
                          {b.count} bill{b.count === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </dt>
                    <dd className={cn('num text-sm', b.count > 0 ? 'text-fg' : 'text-fg-subtle')}>
                      {formatAmount(b.amount)}
                    </dd>
                  </div>
                ))}

                {ageing.unallocated ? (
                  <div className="contents">
                    <span aria-hidden className="size-3 rounded-[3px] bg-inset" />
                    <dt className="text-sm text-fg-muted">
                      {D.isNeg(D.dec(ageing.unallocated)) ? 'Paid on account' : 'Older than loaded bills'}
                      <span className="ml-1.5 text-2xs text-fg-subtle">not aged</span>
                    </dt>
                    <dd className="num text-sm text-fg-muted">{formatAmount(ageing.unallocated)}</dd>
                  </div>
                ) : null}
              </dl>

              {ageing.overdueCount > 0 ? (
                <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-3 py-2 text-sm text-danger-11">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    <span className="num font-semibold">{formatMoney(ageing.overdue)}</span> is past the
                    agreed {supplier.paymentTermsDays}-day terms
                    {' '}across {ageing.overdueCount} bill{ageing.overdueCount === 1 ? '' : 's'}
                    {ageing.oldestDays !== null ? `, the oldest ${ageing.oldestDays} days out` : ''}.
                  </span>
                </p>
              ) : ageing.openCount > 0 ? (
                <p className="mt-3 text-xs text-fg-subtle">
                  Nothing past the agreed {supplier.paymentTermsDays}-day terms
                  {ageing.oldestDays !== null ? ` — the oldest open bill is ${ageing.oldestDays} days old` : ''}.
                </p>
              ) : null}
            </div>
          )}
        </Section>

        {/* Contact and compliance in ONE block, because they are read together:
            the man who is phoned about a short delivery is the man whose licence
            copy has to be on file before the next one. */}
        <Section title="Contact and licence" icon={ScrollText}>
          <div className="px-[var(--card-px)] pb-4">
            <div className="flex flex-wrap items-center gap-2">
              {supplier.phone ? (
                <a
                  href={`tel:${supplier.phone}`}
                  className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-sm hover:border-border-strong hover:bg-hover"
                >
                  <Phone size={14} className="text-fg-subtle" aria-hidden />
                  <span className="mono">{supplier.phone}</span>
                </a>
              ) : (
                <span className="text-sm text-fg-subtle">No phone on file</span>
              )}
            </div>

            {supplier.address ? (
              <p className="mt-2.5 flex items-start gap-2 text-sm text-fg-muted">
                <MapPin size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
                {supplier.address}
              </p>
            ) : null}

            <LicencePanel supplier={supplier} state={licence} />

            <Facts
              rows={[
                { label: 'GSTIN', value: supplier.gstin ?? 'Unregistered', mono: supplier.gstin !== null },
                {
                  label: 'Terms',
                  value: supplier.paymentTermsDays > 0
                    ? `${supplier.paymentTermsDays} days from bill date`
                    : 'No credit — paid on delivery',
                },
              ]}
            />

            {!supplier.gstin ? (
              <p className="mt-1 text-xs text-fg-subtle">
                Purchases from an unregistered supplier carry no input credit — the GST on them is
                cost, not something the shop gets back.
              </p>
            ) : null}
          </div>
        </Section>

        {/* Money going the OTHER way. Kept apart from the payable on purpose —
            see `returnsPosition` for why the two must never be summed. */}
        <Section
          title="Debit notes and claims"
          icon={Undo2}
          note={position.awaitingCount > 0 ? `${position.awaitingCount} awaiting credit` : undefined}
        >
          {returnsStatus === 'loading' ? (
            <SkeletonRows rows={2} cols={3} />
          ) : returnsStatus === 'error' ? (
            <ErrorState
              code="RETURNS_FAILED"
              message="Debit notes and claims could not be read."
              onRetry={onRetryPurchases}
            />
          ) : posted.length === 0 ? (
            <EmptyState
              icon={Undo2}
              title="Nothing sent back"
              body="A debit note for goods returned, or an expiry claim for time-expired stock, will appear here with what the distributor has actually credited against it."
              actionLabel="Raise a return"
              onAction={onRaiseReturn}
            />
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-px border-y border-border-subtle bg-border-subtle">
                <MiniStat
                  label="Debit notes"
                  value={formatAmount(position.debitNotes)}
                  note={`${position.debitNoteCount} note${position.debitNoteCount === 1 ? '' : 's'} · already off the payable`}
                />
                <MiniStat
                  label="Claims awaiting credit"
                  value={formatAmount(position.awaiting)}
                  tone={D.gt(money(position.awaiting) ?? D.ZERO, D.ZERO) ? 'warning' : undefined}
                  note={position.oldestAwaitingDays !== null
                    ? `oldest ${position.oldestAwaitingDays} days out`
                    : 'nothing pending'}
                />
              </div>

              {D.gt(money(position.shortfall) ?? D.ZERO, D.ZERO) ? (
                <p className="flex items-start gap-2 border-b border-border-subtle bg-warning-3 px-[var(--card-px)] py-2 text-sm text-warning-11">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    Settled <span className="num font-semibold">{formatMoney(position.shortfall)}</span> short
                    of claim value — the breakage allowance this manufacturer applies.
                  </span>
                </p>
              ) : null}

              {posted.map((doc) => <ReturnRow key={doc.id} doc={doc} today={today} />)}
            </div>
          )}
        </Section>

        <Section
          title={`Purchase bills${recent.length > 0 ? ` · ${recent.length}` : ''}`}
          icon={Receipt}
          note={invoices.length > recent.length ? `of ${invoices.length} loaded` : undefined}
          aside={purchaseStatus === 'ready' && invoices.length > 0 ? <SpendTrend spend={spend} /> : undefined}
        >
          {purchaseStatus === 'loading' ? (
            <SkeletonRows rows={3} cols={4} />
          ) : purchaseStatus === 'error' ? (
            <ErrorState
              code="PURCHASES_FAILED"
              message={purchaseError ?? 'Purchase bills could not be read.'}
              onRetry={onRetryPurchases}
            />
          ) : recent.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="Nothing bought from here yet"
              body="Goods received against this distributor will show up here with the rate you paid."
              actionLabel="Record a purchase"
              onAction={onRecordPurchase}
            />
          ) : (
            <div>
              <div className="grid grid-cols-[1fr_58px_84px_80px] gap-2 border-y border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
                <span className="micro-label">Bill</span>
                <span className="micro-label">Age</span>
                <span className="micro-label text-right">Net ₹</span>
                <span className="micro-label text-right">Due ₹</span>
              </div>
              {recent.map((inv) => (
                <InvoiceRow key={inv.id} invoice={inv} today={today} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title={`Rates paid${rates.length > 0 ? ` · ${rates.length}` : ''}`}
          icon={TrendingUp}
          note="Vs the purchase before"
        >
          {purchaseStatus === 'loading' ? (
            <SkeletonRows rows={4} cols={3} />
          ) : purchaseStatus === 'error' ? (
            <ErrorState
              code="PURCHASES_FAILED"
              message={purchaseError ?? 'Purchase bills could not be read.'}
              onRetry={onRetryPurchases}
            />
          ) : rates.length === 0 ? (
            <EmptyState
              icon={TrendingUp}
              title="No rates on record"
              body="The rate this distributor charges appears here after the first goods receipt, and every later bill is priced against it."
            />
          ) : (
            <div>
              <div className="grid grid-cols-[1fr_88px_72px] gap-2 border-y border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
                <span className="micro-label">Medicine</span>
                <span className="micro-label text-right">Rate/pack ₹</span>
                <span className="micro-label text-right">Change</span>
              </div>
              {rates.map((r) => <RateRowView key={r.medicineId} row={r} />)}
            </div>
          )}
        </Section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <Button variant="primary" onClick={onEdit}>
          <Pencil /> Edit supplier
        </Button>
        <Button onClick={onRecordPurchase}>
          <Truck /> New purchase
        </Button>
        <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </aside>
  )
}

// ------------------------------------------------------------------ parts ---

/**
 * The stacked payable, shared with the list rows.
 *
 * Widths are geometry, not money: the amounts stay decimal strings and only the
 * ratio is ever taken to a float, because a pixel does not need paise. Zero
 * outstanding draws a flat rule rather than an empty box — a bar with nothing
 * in it reads as missing data.
 */
export function AgeingBar({
  ageing,
  className,
  described = true,
}: {
  ageing: Ageing
  className?: string
  /**
   * False inside a list row. The bar there sits within a button whose
   * accessible name is already the supplier, and folding four amounts into it
   * would make every row announce a paragraph; the row's own text line carries
   * what is overdue.
   */
  described?: boolean
}) {
  const total = money(ageing.onBills)
  const segments = total && D.gt(total, D.ZERO)
    ? ageing.buckets
      .map((b) => {
        const amount = money(b.amount)
        const width = amount && D.gt(amount, D.ZERO)
          ? D.toNumber(D.div(D.mul(amount, D.HUNDRED), total))
          : 0
        return { ...b, width }
      })
      .filter((s) => s.width > 0)
    : []

  const label = segments.length === 0
    ? 'Nothing outstanding'
    : segments.map((s) => `${s.label}: ${formatMoney(s.amount)}`).join(', ')

  return (
    <div
      {...(described
        ? { role: 'img', 'aria-label': `Payable by age. ${label}` }
        : { 'aria-hidden': true })}
      className={cn('flex w-full overflow-hidden rounded-[var(--radius-full)] bg-inset', className)}
    >
      {segments.map((s) => (
        <span
          key={s.key}
          title={`${s.label} · ${formatMoney(s.amount)}`}
          style={{ width: `${s.width}%`, backgroundColor: s.tone }}
        />
      ))}
    </div>
  )
}

const LICENCE_ICON: Record<LicenceKey, LucideIcon> = {
  missing: Ban,
  lapsed: Ban,
  expiring: CalendarClock,
  undated: CircleAlert,
  valid: BadgeCheck,
}

/** Icon AND word, never the colour alone — the rule the whole app is held to. */
export function LicenceChip({ state }: { state: LicenceState }) {
  return <Chip icon={LICENCE_ICON[state.key]} tone={state.tone}>{state.label}</Chip>
}

function LicencePanel({ supplier, state }: { supplier: Supplier; state: LicenceState }) {
  const bad = state.key === 'missing' || state.key === 'lapsed'
  const warn = state.key === 'expiring'

  return (
    <div
      className={cn(
        'mt-3 rounded-[var(--radius-lg)] border px-3 py-2.5',
        bad ? 'border-danger-9/30 bg-danger-3'
          : warn ? 'border-warning-9/30 bg-warning-3'
            : 'border-border-subtle bg-subtle',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="micro-label">Drug licence</span>
        <LicenceChip state={state} />
      </div>

      {supplier.dlNo ? (
        <div className="mono mt-1 text-base font-medium text-fg">{supplier.dlNo}</div>
      ) : (
        <p className="mt-1 text-sm text-danger-11">
          Not recorded. Every purchase bill from this distributor has to carry it, and the bill is
          the shop's only defence at inspection.
        </p>
      )}

      {supplier.dlNo ? (
        <p className={cn('mt-1 text-xs', bad ? 'text-danger-11' : warn ? 'text-warning-11' : 'text-fg-muted')}>
          {supplier.dlValidUpto
            ? state.key === 'lapsed'
              ? <>Expired on {formatDate(supplier.dlValidUpto)} — goods received against it now have no lawful source on the register.</>
              : <>Valid to {formatDate(supplier.dlValidUpto)}{state.days !== null && state.days <= 60 ? ' — ask for the renewed copy before the next delivery.' : '.'}</>
            : 'No expiry date on file. A wholesale licence runs five years, and the renewal is what gets missed.'}
        </p>
      ) : null}
    </div>
  )
}

/** Twelve months of spend beside the bills, so the trend is read with them. */
function SpendTrend({ spend }: { spend: ReadonlyArray<{ key: string; amount: Money }> }) {
  const points = spend.map((m) => D.toNumber(money(m.amount) ?? D.ZERO))
  if (points.every((p) => p === 0)) return null
  return (
    <span className="flex items-center gap-2" title="Purchases from this distributor, last 12 months">
      <span className="text-2xs text-fg-subtle">12 mo</span>
      <Sparkline points={points} width={72} height={20} />
    </span>
  )
}

function InvoiceRow({ invoice, today }: { invoice: PurchaseInvoice; today: Date }) {
  const age = ageInDays(invoice.invoiceDate, today)
  const cancelled = invoice.status !== 'POSTED'
  /* A cancelled bill owes nothing — which is exactly what `ageingOf` decides
     when it skips one. Carrying its unpaid balance into this column anyway
     would print an amber figure the ageing above deliberately excludes, and the
     two readings of one sheet must not disagree. */
  const net = cancelled ? null : money(invoice.netAmount)
  const due = net ? D.sub(net, money(invoice.amountPaid) ?? D.ZERO) : null
  const open = due !== null && D.gt(due, D.ZERO)

  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_58px_84px_80px] items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0',
        cancelled && 'opacity-55',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="mono truncate text-sm" title={invoice.supplierInvoiceNo}>
          {/* His number, not ours: it is what he reads off his own copy when the
              two of you are arguing about which bill is unpaid. */}
          {invoice.supplierInvoiceNo || invoice.purchaseNo}
        </span>
        <span className="truncate text-2xs text-fg-subtle">
          {formatDate(invoice.invoiceDate)} · {invoice.lines.length} line
          {invoice.lines.length === 1 ? '' : 's'}
          {cancelled ? ' · cancelled' : ''}
        </span>
      </span>
      <span className="text-xs text-fg-muted">{age === null ? '—' : `${age}d`}</span>
      <span className="num text-sm">{formatAmount(invoice.netAmount)}</span>
      <span className={cn('num text-sm', open ? 'font-medium text-warning-11' : 'text-fg-subtle')}>
        {cancelled ? 'Nil' : due === null ? '—' : open ? formatAmount(D.toStr(due, 2)) : 'Paid'}
      </span>
    </div>
  )
}

function ReturnRow({ doc, today }: { doc: SupplierReturn; today: Date }) {
  const claim = doc.kind === 'EXPIRY_CLAIM'
  const awaiting = claim && doc.creditReceived === null
  const age = ageInDays(doc.issuedOn, today)
  const short = claim && doc.creditReceived !== null
    ? D.sub(money(doc.netAmount) ?? D.ZERO, money(doc.creditReceived) ?? D.ZERO)
    : null

  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-2 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className="mono truncate text-sm text-fg">{doc.documentNo}</span>
          <Chip
            icon={claim ? Hourglass : Undo2}
            tone={claim ? 'var(--status-expiry-180)' : 'var(--info-11)'}
          >
            {claim ? 'Expiry claim' : 'Debit note'}
          </Chip>
        </span>
        <span className="truncate text-2xs text-fg-subtle">
          {formatDate(doc.issuedOn)}
          {doc.againstPurchaseNo ? ` · against ${doc.againstPurchaseNo}` : ''}
          {awaiting && age !== null ? ` · ${age} days awaiting credit` : ''}
          {doc.creditNoteRef ? ` · credit ${doc.creditNoteRef}` : ''}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="num text-sm text-fg">{formatAmount(doc.netAmount)}</span>
        {awaiting ? (
          <span className="text-2xs text-warning-11">Nothing credited yet</span>
        ) : claim && short !== null ? (
          <span className={cn('num text-2xs', D.gt(short, D.ZERO) ? 'text-warning-11' : 'text-success-11')}>
            {D.gt(short, D.ZERO) ? `${formatAmount(D.toStr(short, 2))} short` : 'Settled in full'}
          </span>
        ) : (
          <span className="text-2xs text-fg-subtle">Off the payable</span>
        )}
      </span>
    </div>
  )
}

function RateRowView({ row }: { row: RateRow }) {
  const n = row.changePct === null ? null : Number(row.changePct)
  const flat = n !== null && Math.abs(n) < 0.05
  const Icon = n === null || flat ? Minus : n > 0 ? ArrowUpRight : ArrowDownRight
  /* Up is bad on a purchase rate — the exact inverse of a sales tile, which is
     why the direction is spelled out here rather than reused from one. */
  const tone = n === null || flat ? 'text-fg-subtle' : n > 0 ? 'text-danger-11' : 'text-success-11'
  // Same decimal parser; a scheme quantity is not money but it is the same shape.
  const freeQty = money(row.latest.freePacks)

  return (
    <div className="grid grid-cols-[1fr_88px_72px] items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0">
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-fg" title={row.brandName}>
          {row.brandName}
        </span>
        <span className="flex items-center gap-1.5 truncate text-2xs text-fg-subtle">
          {row.packLabel}
          <span aria-hidden>·</span>
          {formatDate(row.latest.at)}
          {freeQty && D.gt(freeQty, D.ZERO) ? (
            <Chip icon={Gift} tone="var(--success-11)">
              +{formatQty(row.latest.freePacks)} free
            </Chip>
          ) : null}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="num text-sm">{formatAmount(row.latest.ratePerPack)}</span>
        {row.previous ? (
          <span className="num text-2xs text-fg-subtle line-through">
            {formatAmount(row.previous.ratePerPack)}
          </span>
        ) : null}
      </span>
      <span className={cn('flex items-center justify-end gap-0.5 text-xs', tone)}>
        <Icon size={13} aria-hidden />
        {n === null ? 'First' : flat ? 'Held' : `${n > 0 ? '+' : ''}${row.changePct}%`}
      </span>
    </div>
  )
}

function MiniStat({
  label, value, note, tone,
}: {
  label: string
  value: string
  note?: string
  tone?: 'warning'
}) {
  return (
    <div className="bg-surface px-[var(--card-px)] py-2.5">
      <div className="micro-label">{label}</div>
      <div className={cn('num mt-0.5 text-lg font-semibold', tone === 'warning' ? 'text-warning-11' : 'text-fg')}>
        {value}
      </div>
      {note ? <div className="text-2xs text-fg-muted">{note}</div> : null}
    </div>
  )
}

function Section({
  title, icon: Icon, note, aside, children,
}: {
  title: string
  icon: LucideIcon
  note?: string
  /** A small visual that belongs beside the heading, never inside the body. */
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border-subtle last:border-0">
      <header className="flex h-11 items-center gap-2 px-[var(--card-px)]">
        <Icon size={15} className="text-fg-subtle" aria-hidden />
        <span className="text-base font-medium text-fg">{title}</span>
        <span className="ml-auto flex items-center gap-3">
          {note ? <span className="text-2xs text-fg-subtle">{note}</span> : null}
          {aside}
        </span>
      </header>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: Array<{ label: string; value: string; mono?: boolean }> }) {
  return (
    <dl className="mt-3 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-sm text-fg-muted">{r.label}</dt>
          <dd className={cn('min-w-0 truncate text-sm text-fg', r.mono && 'mono')} title={r.value}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------- helpers ---

interface CreditBar {
  tone: 'ok' | 'near' | 'over'
  word: string
  width: number
  valueNow: number
  fill: string
  track: string
}

/**
 * Credit used against the limit the DISTRIBUTOR grants this shop.
 *
 * The geometry mirrors the customer credit meter in the billing panel, but the
 * meaning is inverted and so is the consequence: over the limit here does not
 * mean a customer owes too much, it means the next delivery does not arrive.
 * A missing or zero limit draws no bar at all — a meter with no maximum is a
 * lie, and "no limit agreed" is a real and common answer.
 */
function creditBar(outstanding: Money, creditLimit: Money): CreditBar | null {
  const used = money(outstanding)
  const cap = money(creditLimit)
  if (!used || !cap || !D.gt(cap, D.ZERO)) return null

  const pct = D.toNumber(D.div(D.mul(used, D.HUNDRED), cap))
  const valueNow = Math.max(0, Math.round(pct))
  const width = Math.min(100, Math.max(0, pct))

  if (D.gt(used, cap)) {
    return {
      tone: 'over',
      width: 100,
      valueNow,
      word: `Over by ${formatMoney(D.toStr(D.sub(used, cap), 2))} — supply may stop`,
      fill: 'var(--danger-9)',
      track: 'var(--danger-3)',
    }
  }
  if (pct >= 75) {
    return {
      tone: 'near',
      width,
      valueNow,
      word: `${valueNow}% used — close to the limit`,
      fill: 'var(--warning-9)',
      track: 'var(--warning-3)',
    }
  }
  return {
    tone: 'ok',
    width,
    valueNow,
    word: `${valueNow}% of the limit used`,
    fill: 'var(--success-9)',
    track: 'var(--success-3)',
  }
}
