import { useMemo } from 'react'
import {
  Ban, BadgeCheck, Check, CircleSlash, IdCard, Pencil, SlidersHorizontal, X,
} from 'lucide-react'
import type { AuditEntry, User } from '@contract'
import {
  OVERRIDE_REASON_LABEL, ROLE_CEILING, ROLE_LABEL, auditLabel, eligibleApprovers, evaluate,
  localDay,
} from '@/api/users'
import type { Ask, Holds } from '@/api/users'
import type { Activity } from '@/api/roster'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { ShiftMini } from './Shifts'

/**
 * One person, read three ways.
 *
 * A roster row says what somebody is allowed to do. That is the least
 * interesting third of the question, and on its own it is the reason access
 * screens go unread: nothing on them ever changes. The other two thirds are what
 * this panel adds, and both come out of the trail rather than out of the record:
 *
 *   WHAT WOULD HAPPEN IF THEY ASKED. Five things that occur at a counter every
 *   week, answered through the SAME `evaluate` the till will call, and — when
 *   the answer is no — WHO could sign it off. A zero in that list is the most
 *   actionable thing on the screen: a rule nobody in the shop can lift today,
 *   which the counter will meet at half past eight with a customer waiting.
 *   WHAT THEY HAVE ACTUALLY DONE. Their shifts, their last actions, the money
 *   that went through their hands, and — separately, because it never appears
 *   under their own name — the overrides they signed for somebody else.
 *
 * The two halves are laid out in that order on purpose. A limit read after the
 * behaviour is a limit an owner can judge; read before it, it is a number.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })

/** How many trail rows the panel shows before handing over to the full log. */
const TIMELINE_ROWS = 7
const SHIFT_ROWS = 3

function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`
}

interface Scenario {
  label: string
  ask: Ask
}

/**
 * Five things that happen at a counter every week.
 *
 * Answered through `evaluate` rather than by reading the limits back at the
 * reader. A record that lists "5%" leaves the manager to work out what that
 * means for the 15% a hospital account is asking for; this says it.
 */
function scenarios(today: string): Scenario[] {
  const back = new Date(`${today}T00:00:00`)
  back.setDate(back.getDate() - 3)
  return [
    { label: '15% off a bill', ask: { kind: 'discount', pct: '15' } },
    { label: 'Refund ₹2,000', ask: { kind: 'refund', amount: '2000.00' } },
    { label: 'Date a bill 3 days back', ask: { kind: 'backdate', date: isoDay(back), today } },
    { label: 'Void a posted bill', ask: { kind: 'permission', permission: 'billing.void' } },
    { label: 'See what the shop paid', ask: { kind: 'permission', permission: 'inventory.cost_view' } },
  ]
}

export function PersonDetail({
  user,
  users,
  viewer,
  today,
  busy,
  holds,
  activity,
  mayReadTrail,
  onClose,
  onEdit,
  onToggleActive,
  onSeeTrail,
  onSeeShifts,
}: {
  user: User
  users: readonly User[]
  viewer: User | null
  today: string
  busy: boolean
  holds: Holds
  activity: Activity
  mayReadTrail: boolean
  onClose: () => void
  onEdit: () => void
  onToggleActive: () => void
  onSeeTrail: () => void
  onSeeShifts: () => void
}) {
  const ceiling = ROLE_CEILING[user.role]
  const asks = useMemo(() => scenarios(today), [today])
  const isViewer = viewer?.id === user.id

  return (
    <aside className="card flex w-[372px] shrink-0 flex-col overflow-hidden" aria-label={user.name}>
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-tight text-fg">{user.name}</h2>
          <p className="mono truncate text-xs text-fg-subtle">{user.username}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="scroll-region min-h-0 flex-1 px-[var(--card-px)] py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="var(--accent-11)">{ROLE_LABEL[user.role]}</Chip>
          {user.isActive
            ? <Chip icon={Check} tone="var(--success-11)">Active</Chip>
            : <Chip icon={CircleSlash} tone="var(--status-out-of-stock)">Disabled</Chip>}
          {isViewer ? <Chip tone="var(--accent-11)">Signed in</Chip> : null}
        </div>

        {user.pharmacistRegNo ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-fg-muted">
            <IdCard size={14} className="mt-px shrink-0 text-fg-subtle" aria-hidden />
            <span>
              <span className="mono text-fg">{user.pharmacistRegNo}</span> — printed on every
              prescription bill dispensed under this account.
            </span>
          </p>
        ) : user.role === 'pharmacist' ? (
          <p className="mt-2 text-xs text-warning-11">
            No registration number on file. A prescription bill needs one.
          </p>
        ) : null}

        {mayReadTrail ? (
          <dl className="mt-3 grid grid-cols-4 gap-2">
            <Tally label="Actions" value={activity.total} />
            <Tally label="Costly" value={activity.lossCount} tone={activity.lossCount > 0 ? 'var(--danger-11)' : undefined} />
            <Tally label="Asked" value={activity.requested} />
            <Tally label="Signed" value={activity.approved} tone={activity.approved > 0 ? 'var(--warning-11)' : undefined} />
          </dl>
        ) : null}

        {/* --- what they may do alone ------------------------------------- */}
        <section className="mt-4">
          <h3 className="micro-label mb-2">Alone, without asking anyone</h3>
          <div className="flex flex-col gap-2">
            <LimitBar
              label="Discount"
              value={`${user.limits.maxDiscountPct}%`}
              ceilingLabel={`${ceiling.maxDiscountPct}%`}
              fraction={fraction(user.limits.maxDiscountPct, ceiling.maxDiscountPct)}
            />
            <LimitBar
              label="Refund"
              value={`₹${formatAmount(user.limits.maxRefundAmount)}`}
              ceilingLabel={`₹${formatAmount(ceiling.maxRefundAmount)}`}
              fraction={fraction(user.limits.maxRefundAmount, ceiling.maxRefundAmount)}
            />
            <LimitBar
              label="Backdating"
              value={user.limits.backdateDays === 0 ? 'Today only' : `${user.limits.backdateDays} days`}
              ceilingLabel={ceiling.backdateDays === 0 ? 'Today only' : `${ceiling.backdateDays} days`}
              fraction={fraction(String(user.limits.backdateDays), String(ceiling.backdateDays))}
            />
            <LimitBar
              label="Landed cost"
              value={user.limits.canViewCost ? 'Visible' : 'Hidden'}
              ceilingLabel={ceiling.canViewCost ? 'Visible' : 'Hidden'}
              fraction={user.limits.canViewCost ? 1 : 0}
            />
          </div>
          <p className="mt-1.5 text-2xs text-fg-subtle">
            The bar is this person against their role’s hard ceiling. The form refuses anything
            past it rather than quietly reducing it.
          </p>
        </section>

        {/* --- and when they ask for more ---------------------------------- */}
        <section className="mt-4">
          <h3 className="micro-label mb-1.5">And when they ask for more</h3>
          <ul className="flex flex-col gap-0.5">
            {asks.map((s) => (
              <ScenarioRow key={s.label} label={s.label} user={user} users={users} ask={s.ask} holds={holds} />
            ))}
          </ul>
          {isViewer ? (
            <p className="mt-1.5 text-2xs text-warning-11">
              You are signed in as this account, so you are never in your own approver list.
            </p>
          ) : null}
        </section>

        {/* --- shifts ------------------------------------------------------ */}
        {mayReadTrail ? (
          <section className="mt-4">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="micro-label">On the counter</h3>
              {activity.shifts.length > SHIFT_ROWS ? (
                <button
                  type="button"
                  onClick={onSeeShifts}
                  className="rounded-[var(--radius-sm)] text-2xs text-accent-11 hover:underline"
                >
                  all {activity.shifts.length} shifts
                </button>
              ) : null}
            </div>
            {activity.shifts.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                No till time in the loaded window. Back-room work — receipts, adjustments,
                user edits — is not counter work and is not counted here.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {activity.shifts.slice(0, SHIFT_ROWS).map((shift) => (
                  <ShiftMini key={shift.key} shift={shift} />
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {/* --- the timeline ------------------------------------------------ */}
        <section className="mt-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="micro-label">Lately</h3>
            {mayReadTrail && activity.total > 0 ? (
              <button
                type="button"
                onClick={onSeeTrail}
                className="rounded-[var(--radius-sm)] text-2xs text-accent-11 hover:underline"
              >
                everything by {user.name.split(' ')[0]}
              </button>
            ) : null}
          </div>

          {!mayReadTrail ? (
            <p className="text-xs text-fg-subtle">
              Reading the trail needs <code className="mono">reports.audit</code>. What this
              person may do is above; what they have done is not yours to read.
            </p>
          ) : activity.total === 0 ? (
            <p className="text-xs text-fg-subtle">
              Nothing in the loaded window. A brand-new account, or somebody who has not been
              on a till for a fortnight.
            </p>
          ) : (
            <Timeline entries={activity.entries.slice(0, TIMELINE_ROWS)} today={today} />
          )}

          {activity.total > 0 ? (
            <p className="num mt-2 text-2xs text-fg-subtle">
              ₹{formatAmount(activity.moneyTouched)} passed through this account in the window.
            </p>
          ) : null}
        </section>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={onEdit}>
            <Pencil /> Edit limits
          </Button>
          <Button
            size="sm"
            variant={user.isActive ? 'danger' : 'secondary'}
            onClick={onToggleActive}
            disabled={busy}
          >
            {user.isActive ? <><CircleSlash /> Disable</> : <><Check /> Enable</>}
          </Button>
        </div>
      </div>
    </aside>
  )
}

function Tally({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2 py-1.5">
      <dt className="micro-label truncate">{label}</dt>
      <dd className="num text-lg font-medium leading-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </dd>
    </div>
  )
}

/**
 * Where this person sits inside their role's ceiling.
 *
 * The bar is a PICTURE, not a figure — the two numbers are printed beside it in
 * full — so it is measured with plain arithmetic on the way to a CSS width and
 * nothing is rounded into a rupee value anybody reads. A ceiling of zero is a
 * full bar rather than a division by zero: "today only, and that is the most
 * this role ever gets" is the true reading.
 */
function fraction(value: string, ceiling: string): number {
  const v = Number(value)
  const c = Number(ceiling)
  if (!Number.isFinite(v) || !Number.isFinite(c)) return 0
  if (c <= 0) return 1
  return Math.max(0, Math.min(1, v / c))
}

function LimitBar({
  label,
  value,
  ceilingLabel,
  fraction: pct,
}: {
  label: string
  value: string
  ceilingLabel: string
  fraction: number
}) {
  const atCeiling = value === ceilingLabel
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="num text-fg">
          {value}
          {atCeiling ? null : <span className="ml-1.5 text-2xs text-fg-subtle">/ {ceilingLabel}</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-[var(--radius-full)] bg-inset">
        <div
          aria-hidden
          className={cn('h-full rounded-[var(--radius-full)]', atCeiling ? 'bg-warning-9' : 'bg-accent-9')}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
    </div>
  )
}

/**
 * One ask, decided, and — when it is refused — who could sign it off.
 *
 * The approver count is computed through `eligibleApprovers`, which leaves the
 * requester out of their own list, and reads the SHOP'S matrix rather than the
 * shipped one so a grid edited on the Permissions tab is answered here too. A
 * zero is worth reading twice: it means a rule nobody in the shop can lift.
 */
function ScenarioRow({
  label,
  user,
  users,
  ask,
  holds,
}: {
  label: string
  user: User
  users: readonly User[]
  ask: Ask
  holds: Holds
}) {
  const decision = evaluate(user, ask, holds)
  /* A backdate is quoted as the DATE asked for, so the approver's own reach —
     counted in days — can only be compared against it with today in hand. */
  const approvers = decision.reason === null
    ? []
    : eligibleApprovers(
      users, user, decision.reason, decision.requested,
      ask.kind === 'backdate' ? ask.today : undefined,
      holds,
    )

  return (
    <li className="flex items-start gap-2 rounded-[var(--radius-sm)] px-1 py-1 hover:bg-hover">
      {decision.allowed ? (
        <Check size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-success-11" aria-hidden />
      ) : decision.overridable ? (
        <SlidersHorizontal size={14} className="mt-0.5 shrink-0 text-warning-11" aria-hidden />
      ) : (
        <Ban size={14} className="mt-0.5 shrink-0 text-danger-9" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="text-xs text-fg">{label}</div>
        <div className="text-2xs text-fg-subtle">
          {decision.allowed ? (
            'Allowed'
          ) : decision.overridable && decision.reason !== null ? (
            <>
              {OVERRIDE_REASON_LABEL[decision.reason]} ·{' '}
              {approvers.length === 0
                ? <span className="text-danger-11">nobody can sign this off</span>
                : `${approvers.length} can sign: ${approvers.map((u) => u.name.split(' ')[0]).join(', ')}`}
            </>
          ) : (
            decision.message
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * The last few things this person did, grouped by day.
 *
 * The day headers are not decoration: every question an owner brings to a
 * person's record is anchored to one — "the night the drawer was short", "before
 * the stock take" — and a flat list of timestamps makes the reader do that
 * grouping in their head while scrolling.
 */
function Timeline({ entries, today }: { entries: readonly AuditEntry[]; today: string }) {
  const out: React.ReactNode[] = []
  let lastDay = ''

  for (const entry of entries) {
    const day = localDay(entry.at)
    if (day !== lastDay) {
      lastDay = day
      out.push(
        <li key={`day-${day}`} className="pt-1.5 first:pt-0">
          <span className="text-2xs font-medium text-fg-muted">{dayLabel(day, today)}</span>
        </li>,
      )
    }
    out.push(<TimelineRow key={entry.id} entry={entry} />)
  }

  return <ul className="flex flex-col gap-0.5">{out}</ul>
}

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  const t = new Date(`${today}T00:00:00`)
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Yesterday'
  return DAY_FMT.format(d)
}

function TimelineRow({ entry }: { entry: AuditEntry }) {
  const when = new Date(entry.at)
  return (
    <li className="flex items-start gap-2 border-l border-border-subtle pl-2.5">
      <span className="num w-9 shrink-0 pt-px text-2xs text-fg-subtle">
        {Number.isNaN(when.getTime()) ? '—' : TIME_FMT.format(when)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-fg">{auditLabel(entry.action)}</span>
          {entry.override ? (
            <BadgeCheck size={11} className="shrink-0 text-warning-11" aria-hidden />
          ) : null}
          {entry.override ? <span className="sr-only">needed a signature</span> : null}
        </span>
        <span className="block truncate text-2xs text-fg-subtle">{entry.summary}</span>
      </span>
      {entry.amount !== null ? (
        <span className="num shrink-0 text-2xs text-fg-muted">
          {entry.amount.startsWith('-') ? '−' : ''}₹{formatAmount(entry.amount.replace('-', ''))}
        </span>
      ) : null}
    </li>
  )
}
