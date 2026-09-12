import { useState } from 'react'
import {
  BadgeIndianRupee, Cake, Coins, HandCoins, HeartPulse, MapPin, Phone, Receipt,
  ScanBarcode, ShieldAlert, ShieldCheck, TriangleAlert, UserRound, X,
} from 'lucide-react'
import type { CustomerReceipt, SaleInvoice, StoreProfile } from '@contract'
import type { CustomerRow } from '@/api/customers'
import { ageInDays, creditTaken, receivableNote, unallocatedNote } from '@/api/customers'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { AgeingBar, CreditMeter, SegmentChip, formatDay } from './CustomerTable'
import type { BillStatus } from './CustomerTable'
import { Section, StatTile } from './sheet'
import { ProfilePanel } from './ProfilePanel'
import { StatementPanel } from './StatementPanel'
import { CarePanel } from './CarePanel'
import type { CareFile } from './careFile'
import { ageOn, nextBirthday } from './careFile'
import type { PurchaseProfile } from './profile'

/**
 * One customer, as a SIDE SHEET.
 *
 * The order of this sheet is an argument, not a layout. ALLERGIES SIT ABOVE
 * EVERYTHING — above the money, above the tabs, on every tab — because they are
 * the only thing on this screen that can hurt somebody, and a strip that
 * disappears when the operator switches to the statement is a strip that is not
 * there when it matters. It carries an icon and the allergen WORDS, never a
 * colour on its own: a POS panel is matte, dim and read at an angle, and a
 * meaningful share of pharmacists cannot separate the red from the amber.
 *
 * Four tabs, and they are four different questions rather than four groupings of
 * one: what is owed, what they take, what the account did over a period, and
 * what the counter needs to know about the person. The sheet holds no query of
 * its own — every tab is a fold over the same window the screen already loaded,
 * and refetching per selection would make arrowing down the list N+1 round trips
 * for numbers already in memory.
 */

type TabId = 'account' | 'profile' | 'statement' | 'care'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'account', label: 'Account' },
  { id: 'profile', label: 'Profile' },
  { id: 'statement', label: 'Statement' },
  { id: 'care', label: 'Care' },
]

export function CustomerDetail({
  row,
  profile,
  care,
  store,
  today,
  billStatus,
  billError,
  busy,
  onClose,
  onRetryBills,
  onRecordReceipt,
  onGoToBilling,
  onCareChange,
  onCareClear,
}: {
  row: CustomerRow
  profile: PurchaseProfile
  care: CareFile
  store: StoreProfile | null
  today: Date
  billStatus: BillStatus
  billError?: string
  busy: boolean
  onClose: () => void
  onRetryBills: () => void
  onRecordReceipt: () => void
  onGoToBilling: () => void
  onCareChange: (patch: Partial<CareFile>) => void
  onCareClear: () => void
}) {
  const c = row.customer
  const owes = D.gt(row.outstanding, D.ZERO)
  const [tab, setTab] = useState<TabId>('account')

  return (
    <aside
      role="complementary"
      aria-label={`${c.name} account`}
      data-density="comfortable"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="card flex w-[420px] shrink-0 flex-col overflow-hidden 2xl:w-[520px]"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3 [@media(max-height:800px)]:py-2">
        <span
          aria-hidden
          /* Decoration, and at the 1366x768 POS floor decoration costs the sheet
             a line of content it cannot spare. */
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-accent-2 text-accent-11 [@media(max-height:800px)]:hidden"
        >
          <UserRound size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-tight text-fg">{c.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            <span className={cn('mono inline-flex items-center gap-1', c.phone ? '' : 'text-warning-11')}>
              <Phone size={11} aria-hidden />{c.phone || 'No phone on file'}
            </span>
            {billStatus === 'ready' ? <SegmentChip segment={profile.segment} /> : null}
            {c.gstin ? <Chip icon={BadgeIndianRupee}>{c.gstin}</Chip> : null}
            <BirthdayChip care={care} today={today} />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close customer account"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={17} aria-hidden />
        </button>
      </header>

      {/* Above the tabs on purpose: switching to the statement must not take the
          dispensing control off the screen. */}
      <AllergyStrip allergies={c.allergies} />
      <ConditionStrip care={care} />

      <div
        role="tablist"
        aria-label="Customer sections"
        onKeyDown={(e) => {
          const i = TABS.findIndex((t) => t.id === tab)
          if (e.key === 'ArrowRight') { e.preventDefault(); setTab(TABS[(i + 1) % TABS.length]?.id ?? 'account') }
          if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(TABS[(i - 1 + TABS.length) % TABS.length]?.id ?? 'account') }
        }}
        className="flex shrink-0 gap-1 border-b border-border-subtle bg-subtle px-[var(--card-px)] pt-1.5"
      >
        {TABS.map((t) => {
          const on = t.id === tab
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`customer-tab-${t.id}`}
              aria-selected={on}
              aria-controls="customer-tabpanel"
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                'relative -mb-px h-8 rounded-t-[var(--radius-md)] px-2.5 text-xs',
                on
                  ? 'bg-surface font-semibold text-fg shadow-[inset_0_1px_0_var(--border-subtle),inset_1px_0_0_var(--border-subtle),inset_-1px_0_0_var(--border-subtle)]'
                  : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.label}
              {on ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-surface" /> : null}
            </button>
          )
        })}
      </div>

      <div
        id="customer-tabpanel"
        role="tabpanel"
        aria-labelledby={`customer-tab-${tab}`}
        className="scroll-region min-h-0 flex-1"
      >
        {tab === 'account' ? (
          <AccountTab
            row={row}
            today={today}
            billStatus={billStatus}
            billError={billError}
            onRetryBills={onRetryBills}
            onGoToBilling={onGoToBilling}
          />
        ) : tab === 'profile' ? (
          <ProfilePanel
            row={row}
            profile={profile}
            billStatus={billStatus}
            billError={billError}
            onRetryBills={onRetryBills}
            onGoToBilling={onGoToBilling}
          />
        ) : tab === 'statement' ? (
          <StatementPanel
            row={row}
            store={store}
            today={today}
            billStatus={billStatus}
            billError={billError}
            onRetryBills={onRetryBills}
          />
        ) : (
          <CarePanel
            customer={c}
            file={care}
            today={today}
            onChange={onCareChange}
            onClear={onCareClear}
          />
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2.5 [@media(max-height:800px)]:py-1.5">
        <Button
          variant="primary"
          size="sm"
          onClick={onRecordReceipt}
          disabled={!owes || busy}
          /* Disabled rather than hidden, and the title says why: a button that
             vanishes when an account clears reads as a missing feature. */
          title={owes ? undefined : `${c.name} owes nothing`}
        >
          <HandCoins /> Record receipt
        </Button>
        <Button size="sm" onClick={onGoToBilling}>
          <ScanBarcode /> New bill
        </Button>
        <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </aside>
  )
}

// ------------------------------------------------------------- account tab ---

function AccountTab({
  row,
  today,
  billStatus,
  billError,
  onRetryBills,
  onGoToBilling,
}: {
  row: CustomerRow
  today: Date
  billStatus: BillStatus
  billError?: string
  onRetryBills: () => void
  onGoToBilling: () => void
}) {
  const c = row.customer
  const r = row.receivable
  const note = receivableNote(r)
  const unaged = unallocatedNote(r)
  const owes = D.gt(row.outstanding, D.ZERO)
  const bills = row.bills.slice(0, 10)
  const receipts = row.receipts.slice(0, 6)

  return (
    <div>
      <AddressLine address={c.address} />

      <div className="grid grid-cols-2 gap-px bg-border-subtle">
        <StatTile
          label="Outstanding"
          hero
          value={formatMoney(c.outstanding)}
          note={note.kind === 'open' || note.kind === 'aged'
            ? `${r.openCount} open bill${r.openCount === 1 ? '' : 's'}`
            : note.kind === 'carried' ? 'No bill to age against' : undefined}
          tone={row.credit.overLimit ? 'danger' : undefined}
        />
        <StatTile
          label="Credit limit"
          value={row.credit.meter ? formatMoney(c.creditLimit) : 'None agreed'}
          // Only when no meter follows. With one, the same sentence sits under
          // the bar two lines below and the tile was printing it twice.
          {...(row.credit.meter ? {} : { note: row.credit.word })}
          tone={row.credit.overLimit ? 'danger' : undefined}
        />
      </div>

      {row.credit.meter ? (
        <div className="border-b border-border-subtle px-[var(--card-px)] py-2.5">
          <CreditMeter standing={row.credit} className="h-1.5" label="Credit used" />
          {/* The bar carries severity; the words carry the meaning. */}
          <p className={cn(
            'mt-1.5 flex items-center gap-1 text-2xs',
            row.credit.tone === 'over' ? 'text-danger-11'
              : row.credit.tone === 'near' ? 'text-warning-11' : 'text-fg-muted',
          )}
          >
            {row.credit.tone === 'over' ? <TriangleAlert size={11} aria-hidden /> : null}
            {row.credit.word}
          </p>
        </div>
      ) : row.credit.overLimit ? (
        /* No limit was ever agreed, yet money is owed — credit nobody approved.
           It gets words and no bar, because a bar with no maximum is a lie. */
        <p className="flex items-start gap-1.5 border-b border-border-subtle bg-danger-3 px-[var(--card-px)] py-2.5 text-sm text-danger-11">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            No credit limit was agreed with {c.name}, and{' '}
            <span className="num font-semibold">{formatMoney(c.outstanding)}</span> is outstanding
            anyway. Set a limit, or take the balance now.
          </span>
        </p>
      ) : (
        <p className="border-b border-border-subtle px-[var(--card-px)] py-2 text-2xs text-fg-subtle">
          No credit limit set — cash or UPI only.
        </p>
      )}

      <Section title="Owed by age" icon={Coins} note="By bill date">
        {billStatus === 'loading' ? (
          <SkeletonRows rows={4} cols={3} />
        ) : billStatus === 'error' ? (
          <ErrorState
            code="CUSTOMER_BILLS_FAILED"
            message={billError ?? 'Bills could not be read, so the balance cannot be aged.'}
            onRetry={onRetryBills}
          />
        ) : (
          <div className="px-[var(--card-px)] pb-3">
            <AgeingBar receivable={r} className="h-2" />

            <dl className="mt-2 grid grid-cols-[10px_1fr_auto] items-center gap-x-2 gap-y-1">
              {r.buckets.map((b) => (
                <div key={b.key} className="contents">
                  <span aria-hidden className="size-2.5 rounded-[2px]" style={{ backgroundColor: b.tone }} />
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

              {/* These four numbers sit beside a total they do not add up to
                  whenever a balance predates the loaded bills or money was
                  paid on account. Naming the remainder is the only honest
                  option: dropping it makes the legend quietly wrong. */}
              {unaged ? (
                <div className="contents">
                  <span aria-hidden className="size-2.5 rounded-[2px] bg-inset" />
                  <dt className="text-sm text-fg-muted">
                    {unaged.credit ? 'Paid on account' : 'Older than the loaded bills'}
                    <span className="ml-1.5 text-2xs text-fg-subtle">not aged</span>
                  </dt>
                  {/* Unsigned. The label above already says which way the money
                      went, and printing the raw remainder put a minus beside
                      "Paid on account" — a negative payment, contradicting the
                      sentence below, which had taken the magnitude all along. */}
                  <dd className="num text-sm text-fg-muted">{formatAmount(unaged.amount)}</dd>
                </div>
              ) : null}
            </dl>

            <AgeingVerdict row={row} />
          </div>
        )}
      </Section>

      <Section
        title={`Bills${bills.length > 0 ? ` · ${bills.length}` : ''}`}
        icon={Receipt}
        note={row.bills.length > bills.length ? `of ${row.bills.length} loaded` : undefined}
      >
        {billStatus === 'loading' ? (
          <SkeletonRows rows={3} cols={4} />
        ) : billStatus === 'error' ? (
          <ErrorState
            code="CUSTOMER_BILLS_FAILED"
            message={billError ?? 'Bills could not be read.'}
            onRetry={onRetryBills}
          />
        ) : bills.length === 0 ? (
          <EmptyState
            icon={ScanBarcode}
            title="Nothing billed to this account"
            body="Bills attached to this customer show up here with the amount that went on credit."
            actionLabel="Go to Billing"
            onAction={onGoToBilling}
          />
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_44px_74px_74px] gap-2 border-b border-border-subtle px-[var(--card-px)] py-1">
              <span className="micro-label">Invoice</span>
              <span className="micro-label">Age</span>
              <span className="micro-label text-right">Net ₹</span>
              <span className="micro-label text-right">On credit ₹</span>
            </div>
            {bills.map((inv) => <BillRow key={inv.id} invoice={inv} today={today} />)}
          </div>
        )}
      </Section>

      <Section
        title={`Receipts${receipts.length > 0 ? ` · ${receipts.length}` : ''}`}
        icon={HandCoins}
        note={row.receipts.length > receipts.length ? `of ${row.receipts.length}` : undefined}
      >
        {receipts.length === 0 ? (
          <p className="px-[var(--card-px)] pb-2.5 text-sm text-fg-muted">
            {owes
              ? 'Nothing taken against this account yet.'
              : 'Nothing has been owed on this account.'}
          </p>
        ) : (
          <div>
            {receipts.map((rc) => <ReceiptRow key={rc.id} receipt={rc} />)}
          </div>
        )}
      </Section>
    </div>
  )
}

// ------------------------------------------------------------------ parts ---

/**
 * The dispensing control, and the reason this sheet exists above the money.
 *
 * Absence is stated rather than left blank. "No allergies recorded" and "we
 * never asked" look identical on a screen that simply omits the strip, and the
 * two are very different things to a pharmacist about to hand over amoxicillin.
 */
function AllergyStrip({ allergies }: { allergies: readonly string[] }) {
  if (allergies.length === 0) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
        <ShieldCheck size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="micro-label">Allergies</span>
        <span className="min-w-0 truncate text-sm text-fg-muted">None recorded — ask before dispensing.</span>
      </div>
    )
  }
  return (
    <div
      role="note"
      data-testid="allergy-strip"
      className="flex shrink-0 items-start gap-2 border-b border-danger-9/25 bg-danger-3 px-[var(--card-px)] py-2"
    >
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger-9" aria-hidden />
      <div className="min-w-0">
        {/* The word "Allergic to" and the allergens themselves, spelled out. The
            tint is a reinforcement and never the carrier of the meaning. */}
        <div className="text-sm font-semibold text-danger-11">Allergic to</div>
        <div className="text-sm text-danger-11">{allergies.join(', ')}</div>
      </div>
    </div>
  )
}

/** Shown only when the shop has recorded something. Unlike allergies, silence
 *  here is not a safety claim — nobody is harmed by an unrecorded condition. */
function ConditionStrip({ care }: { care: CareFile }) {
  if (care.conditions.length === 0) return null
  return (
    <div
      data-testid="condition-strip"
      className="flex shrink-0 items-start gap-2 border-b border-info-9/20 bg-info-3 px-[var(--card-px)] py-1.5"
    >
      <HeartPulse size={14} className="mt-0.5 shrink-0 text-info-9" aria-hidden />
      <div className="min-w-0">
        <span className="text-sm font-semibold text-info-11">On long term </span>
        <span className="text-sm text-info-11">{care.conditions.join(', ')}</span>
      </div>
    </div>
  )
}

function BirthdayChip({ care, today }: { care: CareFile; today: Date }) {
  const birthday = nextBirthday(care.dob, today)
  const age = ageOn(care.dob, today)
  if (!birthday || age === null) return null
  if (birthday.inDays > 14) {
    return <Chip icon={Cake}>{age} yrs</Chip>
  }
  return (
    <Chip icon={Cake} tone="var(--accent-11)">
      {birthday.inDays === 0 ? `Birthday today · turns ${birthday.turning}` : `Turns ${birthday.turning} in ${birthday.inDays}d`}
    </Chip>
  )
}

/** The sentence under the buckets. Same decision the row makes, said at length. */
function AgeingVerdict({ row }: { row: CustomerRow }) {
  const note = receivableNote(row.receivable)
  const oldest = row.receivable.oldestDays

  if (note.kind === 'aged') {
    return (
      <p className="mt-2 flex items-start gap-1.5 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-2.5 py-1.5 text-sm text-danger-11">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="num font-semibold">{formatMoney(note.amount ?? '0')}</span> has been owed
          for more than ninety days across {note.count} bill{note.count === 1 ? '' : 's'}
          {oldest !== null ? `, the oldest ${oldest} days out` : ''}.
          {note.carried ? (
            <> A further <span className="num font-semibold">{formatMoney(note.carried)}</span> has
            no loaded bill behind it and is in none of the buckets above.</>
          ) : null}
        </span>
      </p>
    )
  }
  if (note.kind === 'carried' || note.kind === 'unreadable') {
    return (
      <p className="mt-2 flex items-start gap-1.5 rounded-[var(--radius-md)] border border-warning-9/25 bg-warning-3 px-2.5 py-1.5 text-sm text-warning-11">
        <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          {note.kind === 'unreadable'
            ? 'This balance is not a readable amount, so nothing can be set against it. It needs correcting at source.'
            : <>
                <span className="num font-semibold">{formatMoney(note.amount ?? '0')}</span> is owed
                with no loaded bill behind it — a balance carried in, or bills older than the window
                above. It is real money; it simply cannot be aged here.
              </>}
        </span>
      </p>
    )
  }
  if (note.kind === 'open') {
    return (
      <>
        <p className="mt-2 text-2xs text-fg-subtle">
          Nothing past ninety days
          {oldest !== null ? ` — the oldest open bill is ${oldest} days old` : ''}.
        </p>
        {/* Said at length, because the buckets above genuinely do not contain
            it and a reader adding them up will otherwise find them short. */}
        {note.carried ? (
          <p className="mt-1.5 flex items-start gap-1.5 rounded-[var(--radius-md)] border border-warning-9/25 bg-warning-3 px-2.5 py-1.5 text-sm text-warning-11">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              A further <span className="num font-semibold">{formatMoney(note.carried)}</span> is
              owed with no loaded bill behind it, so it appears in none of the buckets above.
            </span>
          </p>
        ) : null}
      </>
    )
  }
  if (note.kind === 'onAccount') {
    return (
      <p className="mt-2 text-2xs text-fg-subtle">
        Settled. <span className="num">{formatMoney(note.amount ?? '0')}</span> of the loaded bills
        was cleared by receipts.
      </p>
    )
  }
  return <p className="mt-2 text-2xs text-fg-subtle">Nothing due on this account.</p>
}

function BillRow({ invoice, today }: { invoice: SaleInvoice; today: Date }) {
  const age = ageInDays(invoice.invoiceDate, today)
  const voided = invoice.status !== 'POSTED'
  // A voided bill owes nothing — which is exactly what `receivableOf` decides
  // when it skips one. Carrying its credit into this column anyway would print a
  // figure the ageing above deliberately excludes.
  const credit = voided ? null : creditTaken(invoice)
  const onCredit = credit !== null && D.gt(credit, D.ZERO)
  const items = invoice.quote.lines.length

  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_44px_74px_74px] items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0',
        voided && 'opacity-55',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="mono truncate text-sm" title={invoice.invoiceNo}>{invoice.invoiceNo}</span>
        <span className="truncate text-2xs text-fg-subtle">
          {formatDay(invoice.invoiceDate)} · {items} item{items === 1 ? '' : 's'}
          {voided ? ' · voided' : ''}
        </span>
      </span>
      <span className="text-2xs text-fg-muted">{age === null ? '—' : `${age}d`}</span>
      <span className="num text-sm text-fg-muted">{formatAmount(invoice.quote.netAmount)}</span>
      <span className={cn('num text-sm', onCredit ? 'font-medium text-warning-11' : 'text-fg-subtle')}>
        {voided ? 'Nil' : onCredit ? formatAmount(D.toStr(credit, 2)) : 'Paid'}
      </span>
    </div>
  )
}

function ReceiptRow({ receipt }: { receipt: CustomerReceipt }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0">
      <span className="flex min-w-0 flex-col">
        <span className="mono truncate text-sm" title={receipt.receiptNo}>{receipt.receiptNo}</span>
        <span className="truncate text-2xs text-fg-subtle">
          {formatDay(receipt.date)} · {receipt.mode}
          {receipt.reference ? ` · ${receipt.reference}` : ''}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="num text-sm font-medium text-success-11">{formatAmount(receipt.amount)}</span>
        <span className="num text-2xs text-fg-subtle">left {formatAmount(receipt.balanceAfter)}</span>
      </span>
    </div>
  )
}

/** Shown only when there is one; an empty row is noise in a sheet this dense,
 *  and the header already carries every identifier that matters. */
function AddressLine({ address }: { address: string | null }) {
  if (!address) return null
  return (
    <p className="flex items-start gap-1.5 border-b border-border-subtle px-[var(--card-px)] py-2 text-sm text-fg-muted">
      <MapPin size={13} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
      {address}
    </p>
  )
}
