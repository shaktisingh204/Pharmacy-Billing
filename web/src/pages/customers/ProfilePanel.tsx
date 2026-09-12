import { AlarmClock, Pill, Repeat, ScanBarcode, Stethoscope, TrendingUp } from 'lucide-react'
import type { CustomerRow } from '@/api/customers'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney, formatQty } from '@/lib/format'
import { Chip, ScheduleChip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Section, StatTile } from './sheet'
import { formatDay, refillWords } from './CustomerTable'
import type { BillStatus } from './CustomerTable'
import type { ItemHistory, PurchaseProfile } from './profile'

/**
 * What this person actually takes.
 *
 * The order is the argument. REFILLS COME FIRST because they are the only thing
 * on this tab that expires: a chronic patient whose strip ran out four days ago
 * is a phone call to make today, and a shop that scrolls past it to read a
 * lifetime-spend figure has read the wrong number. Money is underneath, where a
 * summary belongs.
 *
 * Every projected date shows its BASIS beside it — how many refills it was
 * derived from and whether the gaps agreed. A prediction whose working is hidden
 * gets believed once, found wrong once, and ignored from then on.
 */

export function ProfilePanel({
  row,
  profile,
  billStatus,
  billError,
  onRetryBills,
  onGoToBilling,
}: {
  row: CustomerRow
  profile: PurchaseProfile
  billStatus: BillStatus
  billError?: string
  onRetryBills: () => void
  onGoToBilling: () => void
}) {
  if (billStatus === 'loading') return <SkeletonRows rows={7} cols={3} />
  if (billStatus === 'error') {
    return (
      <ErrorState
        code="CUSTOMER_BILLS_FAILED"
        message={billError ?? 'Bills could not be read, so nothing can be said about what this customer buys.'}
        onRetry={onRetryBills}
      />
    )
  }
  if (profile.bills === 0) {
    return (
      <EmptyState
        icon={ScanBarcode}
        title="Nothing billed to this account yet"
        body="What a customer buys, how often they refill it and when they are next due are all read off their bills. Attach this customer to a bill and it starts here."
        actionLabel="Go to Billing"
        onAction={onGoToBilling}
      />
    )
  }

  const top = profile.items.slice(0, 8)

  return (
    <div>
      {/* Two tiles, not three. A display figure needs room to be a display
          figure, and at 420px a third column turns ₹65,012.50 into an ellipsis —
          which is the one thing a headline number must never be. */}
      <div className="grid grid-cols-2 gap-px bg-border-subtle">
        <StatTile
          label="Spent here"
          value={formatMoney(profile.spend)}
          hero
          note={profile.average ? `${formatMoney(profile.average)} a bill on average` : undefined}
        />
        <StatTile
          label="Bills"
          value={String(profile.bills)}
          note={profile.voided > 0
            ? `${profile.voided} voided, excluded`
            : `${formatQty(profile.units)} units dispensed`}
        />
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle px-[var(--card-px)] py-2 text-sm text-fg-muted">
        <TrendingUp size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        {profile.first ? <>Buying here since <span className="font-medium text-fg">{formatDay(profile.first)}</span></> : null}
        {profile.visitCycle ? (
          <>
            · visits about every{' '}
            <span className="num font-medium text-fg">{profile.visitCycle.days}</span> days
          </>
        ) : null}
        {profile.daysSince !== null ? (
          <>· last here {profile.daysSince === 0 ? 'today' : `${profile.daysSince} day${profile.daysSince === 1 ? '' : 's'} ago`}</>
        ) : null}
      </p>

      <Section
        title="Refills due"
        icon={AlarmClock}
        note={profile.refills.length > 0 ? `${profile.refills.length} on a cycle` : undefined}
      >
        {profile.refills.length === 0 ? (
          <p className="px-[var(--card-px)] pb-3 text-sm text-fg-muted">
            Nothing here repeats on a cycle yet. A medicine needs three separate purchases before a
            next-refill date can be projected from them — two dates are one gap, and one gap is a
            guess.
          </p>
        ) : (
          <ul className="pb-1">
            {profile.refills.slice(0, 6).map((item) => (
              <RefillRow key={item.medicineId} item={item} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Most bought" icon={Pill} note={`${profile.items.length} medicine${profile.items.length === 1 ? '' : 's'}`}>
        <div className="grid grid-cols-[1fr_46px_76px_76px] gap-2 border-b border-border-subtle px-[var(--card-px)] py-1">
          <span className="micro-label">Medicine</span>
          <span className="micro-label text-right">Buys</span>
          <span className="micro-label text-right">Units</span>
          <span className="micro-label text-right">Spend ₹</span>
        </div>
        {top.map((item) => (
          <div
            key={item.medicineId}
            className="grid grid-cols-[1fr_46px_76px_76px] items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-fg" title={item.brandName}>{item.brandName}</span>
              <span className="flex items-center gap-1.5 truncate text-2xs text-fg-subtle">
                <ScheduleChip code={item.schedule} />
                {item.packLabel} · last {formatDay(item.lastBought)}
              </span>
            </span>
            <span className="num text-sm text-fg">{item.times}</span>
            <span className="num text-sm text-fg-muted">{formatQty(item.qty)}</span>
            <span className="num text-sm text-fg-muted">{formatAmount(item.spend)}</span>
          </div>
        ))}
        {profile.items.length > top.length ? (
          <p className="px-[var(--card-px)] py-1.5 text-2xs text-fg-subtle">
            {profile.items.length - top.length} more medicine
            {profile.items.length - top.length === 1 ? '' : 's'} bought less often.
          </p>
        ) : null}
      </Section>

      <Section title="Prescribers" icon={Stethoscope}>
        {profile.prescribers.length === 0 ? (
          <p className="px-[var(--card-px)] pb-3 text-sm text-fg-muted">
            No prescription was recorded against any of these bills. Only Schedule H, H1 and X lines
            require one, so an OTC-only customer will always read this way.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 px-[var(--card-px)] pb-3">
            {profile.prescribers.slice(0, 6).map((p) => (
              <Chip key={p.name} icon={Stethoscope}>
                {p.name} · {p.times}
              </Chip>
            ))}
          </div>
        )}
      </Section>

      <p className="px-[var(--card-px)] py-2.5 text-2xs text-fg-subtle">
        Read off {row.bills.length} loaded bill{row.bills.length === 1 ? '' : 's'} for this account.
        Voided bills are counted but never dispensed, so they take no part in any cycle, quantity or
        favourite above.
      </p>
    </div>
  )
}

/**
 * One projected refill, with the evidence attached.
 *
 * "Steady" and "roughly" are different claims and the row makes exactly the one
 * the gaps support. A shop phoning a customer on this date needs to know whether
 * it is a rhythm or an average.
 */
function RefillRow({ item }: { item: ItemHistory }) {
  const due = item.dueInDays
  const overdue = due !== null && due < 0
  const soon = due !== null && due >= 0 && due <= 7

  return (
    <li className="flex items-start gap-2 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0">
      <span
        aria-hidden
        className={cn(
          'mt-1 flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-full)]',
          overdue ? 'bg-warning-3 text-warning-11' : soon ? 'bg-accent-3 text-accent-11' : 'bg-inset text-fg-subtle',
        )}
      >
        <Repeat size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm font-medium text-fg">{item.brandName}</span>
          <span className="text-2xs text-fg-subtle">{item.packLabel}</span>
        </span>
        <span className="mt-0.5 block text-2xs text-fg-muted">
          {item.cycle ? (
            <>
              Every <span className="num">{item.cycle.days}</span> days
              {item.cycle.steady ? ' · steady' : ' · roughly, the gaps vary'} · from{' '}
              <span className="num">{item.times}</span> purchases since {formatDay(item.firstBought)}
            </>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span
          className={cn(
            'flex items-center gap-1 text-sm font-medium',
            overdue ? 'text-warning-11' : soon ? 'text-accent-11' : 'text-fg',
          )}
        >
          <AlarmClock size={12} aria-hidden />
          {due === null ? '—' : refillWords(due)}
        </span>
        <span className="text-2xs text-fg-subtle">{item.dueOn ? formatDay(item.dueOn) : '—'}</span>
      </span>
    </li>
  )
}
