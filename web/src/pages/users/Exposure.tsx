import { Ban, CalendarClock, ChevronDown, ChevronRight, Eye, IndianRupee, Scale, Tag } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Permission, User } from '@contract'
import { ROLES } from '@contract'
import { ROLE_LABEL, ROLE_PLURAL, exposure } from '@/api/users'
import type { MoneyPower } from '@/api/roster'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'

/**
 * What this roster can do that costs money.
 *
 * The question behind the whole page is never "how many users are there". It is
 * "how many people can void a bill, and WHICH ones" — so every tile counts
 * PEOPLE through the same predicate the counter is gated on, names them, and is
 * a filter rather than an ornament. The answer to "two" is always "which two".
 *
 * Each tile also carries what the power actually did in the loaded window,
 * because a capability with nothing behind it and a capability that moved four
 * thousand rupees last week are different facts about the same shop. THREE OF
 * THE SIX SAY THEY LEAVE NO ROW, and that is the most important sentence here:
 * landed cost, purchase rates and margin are READS, and a read cannot be audited
 * after the fact. They can only be granted carefully, which is exactly why they
 * are in this band rather than buried in the grid.
 *
 * IT COLLAPSES, and that is a floor decision rather than a preference. The
 * design target is a 1366x768 all-in-one, which leaves about 640px of page: open,
 * this band and the header take two thirds of it and the roster starts below the
 * fold. So the band is read once and folded away, the choice is remembered per
 * device, and the summary line it leaves behind still names the deepest dial on
 * the roster.
 */

const TILE: Record<string, { icon: LucideIcon; tone: string; short: string }> = {
  'billing.void': { icon: Ban, tone: 'var(--danger-11)', short: 'Void a bill' },
  'billing.rate_edit': { icon: Tag, tone: 'var(--status-expiry-60)', short: 'Edit a rate' },
  'billing.backdate': { icon: CalendarClock, tone: 'var(--warning-11)', short: 'Backdate' },
  'inventory.cost_view': { icon: Eye, tone: 'var(--schedule-h)', short: 'See cost' },
  'purchases.rate_view': { icon: IndianRupee, tone: 'var(--schedule-nrx)', short: 'Buying rates' },
  'reports.margin': { icon: Scale, tone: 'var(--viz-2)', short: 'See margin' },
}

export function ExposurePanel({
  power,
  stats,
  hold,
  open,
  onOpen,
  onHold,
}: {
  power: MoneyPower
  stats: ReturnType<typeof exposure>
  hold: Permission | null
  open: boolean
  onOpen: (next: boolean) => void
  onHold: (id: Permission) => void
}) {
  const held = hold === null ? null : power.powers.find((p) => p.spec.id === hold) ?? null

  return (
    <div className="card shrink-0" style={{ padding: 'var(--card-px)' }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpen(!open)}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] text-base font-semibold text-fg hover:text-accent-11"
        >
          {open
            ? <ChevronDown size={16} className="text-fg-subtle" aria-hidden />
            : <ChevronRight size={16} className="text-fg-subtle" aria-hidden />}
          Who can do what that costs money
        </button>

        <p className="text-sm text-fg-muted">
          {open
            ? `${stats.active} of ${stats.total} accounts active. Press a power to see only the people who hold it.`
            : held === null
              ? `${stats.active} of ${stats.total} active · deepest discount ${stats.widestDiscount.value}% · largest refund ₹${formatAmount(stats.largestRefund.value)}, both ${stats.widestDiscount.holder?.name ?? 'nobody'}`
              : `Showing the ${held.holders.length} who can ${held.spec.label.toLowerCase()}`}
        </p>

        {/* Only while the band is open. Collapsed, the summary line already
            carries the headcount, and a second wrapped line of chips is the
            fifty pixels the roster underneath needs at the design floor. */}
        <div className={cn('ml-auto flex flex-wrap items-center gap-1.5', !open && 'hidden')}>
          {ROLES.map((role) => (
            <span
              key={role}
              className="num rounded-[var(--radius-sm)] bg-subtle px-2 py-0.5 text-xs text-fg-muted"
            >
              {stats.byRole[role]}{' '}
              <span className="text-fg-subtle">
                {stats.byRole[role] === 1 ? ROLE_LABEL[role].toLowerCase() : ROLE_PLURAL[role]}
              </span>
            </span>
          ))}
        </div>
      </div>

      {open ? (
        <>
          <div className="mt-2.5 flex flex-wrap gap-3">
            {power.powers.map((entry) => {
              const meta = TILE[entry.spec.id]
                ?? { icon: Ban, tone: 'var(--fg-muted)', short: entry.spec.label }
              const on = hold === entry.spec.id
              const names = entry.holders.map((u) => u.name.split(' ')[0])
              return (
                <button
                  key={entry.spec.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onHold(entry.spec.id)}
                  title={entry.spec.guard ?? entry.spec.detail}
                  className={cn(
                    'min-w-[148px] flex-1 rounded-[var(--radius-lg)] border px-2.5 py-1.5 text-left',
                    'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease)]',
                    on
                      ? 'border-accent-6 bg-accent-2'
                      : 'border-border-subtle bg-subtle hover:border-border-strong hover:bg-surface',
                  )}
                >
                  <span className="micro-label flex items-center gap-1.5">
                    <meta.icon size={12} aria-hidden style={{ color: meta.tone }} />
                    {meta.short}
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className={cn('display-num text-2xl', on ? 'text-accent-11' : 'text-fg')}>
                      {entry.holders.length}
                    </span>
                    <span className="truncate text-xs text-fg-muted">
                      {names.length === 0 ? 'nobody' : names.slice(0, 2).join(', ')}
                      {names.length > 2 ? ` +${names.length - 2}` : ''}
                    </span>
                  </span>
                  <span className="num block truncate text-2xs text-fg-subtle">
                    {usageLine(entry.logged, entry.used, entry.moved)}
                  </span>
                </button>
              )
            })}
          </div>

          {/* The widest each dial is set anywhere on the live roster, WITH the
              name beside it. The number alone is unreadable: 100% against the
              owner's account is expected, and the same figure against a cashier
              is the most urgent thing on the screen. */}
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-border-subtle pt-2">
            <Widest
              label="Deepest discount unaided"
              value={`${stats.widestDiscount.value}%`}
              holder={stats.widestDiscount.holder}
            />
            <Widest
              label="Largest refund unaided"
              value={`₹${formatAmount(stats.largestRefund.value)}`}
              holder={stats.largestRefund.holder}
            />
            <Widest
              label="Furthest backdate unaided"
              value={
                stats.furthestBackdate.value === 0
                  ? 'none'
                  : `${stats.furthestBackdate.value} day${stats.furthestBackdate.value === 1 ? '' : 's'}`
              }
              holder={stats.furthestBackdate.holder}
            />
            <span className="num ml-auto text-xs text-fg-subtle">
              ₹{formatAmount(power.refundAuthority)} refund authority in all, of which
              ₹{formatAmount(power.ownerAuthority)} is an owner account
            </span>
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * What the power did in the window.
 *
 * A rate edit and a backdate carry no rupee figure — the loss is the price that
 * moved, not a total on the row — so quoting ₹0.00 against two real edits would
 * report a power that cost nothing when it may have cost a great deal. The count
 * is the honest figure there, and the amount is added only where there is one.
 */
function usageLine(logged: boolean, used: number, moved: string): string {
  if (!logged) return 'A read — leaves no row'
  if (used === 0) return 'Not used in the window'
  if (moved === '0.00') return `${used}× in the window`
  return `${used}× · ₹${formatAmount(moved)}`
}

function Widest({ label, value, holder }: { label: string; value: string; holder: User | null }) {
  return (
    <span className="flex items-baseline gap-1.5 text-xs">
      <span className="micro-label">{label}</span>
      <span className="num font-medium text-fg">{value}</span>
      <span className="truncate text-fg-subtle">{holder?.name ?? 'nobody'}</span>
    </span>
  )
}
