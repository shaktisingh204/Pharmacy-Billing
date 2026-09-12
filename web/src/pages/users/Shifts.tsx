import { useMemo, useState } from 'react'
import { Ban, BadgeCheck, Banknote, Clock, LogIn, Monitor, TriangleAlert, Undo2 } from 'lucide-react'
import type { AuditEntry, IsoDate } from '@contract'
import { ROLE_SHORT } from '@/api/users'
import { counterDays, shiftsFrom } from '@/api/roster'
import type { CounterDay, Shift } from '@/api/roster'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, PermissionDenied } from '@/components/states'

/**
 * Who was on the counter, and when.
 *
 * Nobody keys a shift into this application, and nobody should have to: every
 * stamped action already carries a till and a person, so a day at a till by one
 * person IS the shift and the closing count at the end of it is the shift's
 * result. Deriving it rather than storing it means the rota can never disagree
 * with the trail, which is the whole reason an owner would trust it.
 *
 * The question it exists to answer is one sentence long and gets asked in every
 * pharmacy: WHO WAS ON THE COUNTER WHEN THE DRAWER WAS SHORT. So the drawer
 * variance is a first-class column rather than a figure to be hunted for, the
 * short ones carry an icon and a word as well as a colour, and a day whose
 * counts do not reconcile says so in its header before the reader has to add
 * anything up.
 *
 * The bar is a real clock, 07:00 to 23:00, not a proportion of the shift. Drawn
 * proportionally, a two-hour morning and a twelve-hour day would be the same
 * length and the one thing the picture is for — overlap, gaps, who relieved whom
 * — would be invisible.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })

/** The shop's day, as the bar draws it. Anything outside is clamped to the ends. */
const DAY_FROM = 7 * 60
const DAY_TO = 23 * 60

const COLS = 'grid-cols-[64px_minmax(130px,1.2fr)_128px_minmax(150px,1.6fr)_minmax(190px,1.6fr)_112px]'

function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? DAY_FROM : d.getHours() * 60 + d.getMinutes()
}

function hoursLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function dayLabel(day: IsoDate, today: IsoDate): string {
  if (day === today) return 'Today'
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  const t = new Date(`${today}T00:00:00`)
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Yesterday'
  return DAY_FMT.format(d)
}

/** A variance is only worth a chip when it is not zero — a square drawer is the norm. */
function isShort(variance: string | null): boolean {
  return variance !== null && variance.trim().startsWith('-')
}

export function Shifts({
  rows,
  today,
  mayRead,
  onOpenPerson,
}: {
  rows: readonly AuditEntry[]
  today: IsoDate
  /** The rota is the trail in another shape, so it is gated the same way. */
  mayRead: boolean
  onOpenPerson: (userId: number) => void
}) {
  const [till, setTill] = useState<number | null>(null)
  const [shortOnly, setShortOnly] = useState(false)

  const all = useMemo(() => shiftsFrom(rows), [rows])
  const tills = useMemo(
    () => [...new Set(all.map((s) => s.terminalId))].sort((a, b) => a - b),
    [all],
  )

  const filtered = useMemo(
    () => all.filter((s) => (till === null || s.terminalId === till) && (!shortOnly || isShort(s.drawerVariance))),
    [all, till, shortOnly],
  )
  const days = useMemo(() => counterDays(filtered), [filtered])

  const shortCount = useMemo(() => all.filter((s) => isShort(s.drawerVariance)).length, [all])

  if (!mayRead) {
    return (
      <div className="card flex min-h-0 flex-1 items-center justify-center">
        <PermissionDenied needs="reports.audit" />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ gap: 'var(--card-gap)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip on={till === null && !shortOnly} onClick={() => { setTill(null); setShortOnly(false) }}>
          <Clock size={13} aria-hidden /> Every shift
        </FilterChip>
        {tills.map((t) => (
          <FilterChip key={t} on={till === t} onClick={() => setTill(till === t ? null : t)}>
            <Monitor size={13} aria-hidden /> Till {t}
          </FilterChip>
        ))}
        <FilterChip
          on={shortOnly}
          onClick={() => setShortOnly((v) => !v)}
          disabled={shortCount === 0}
          tone="var(--danger-11)"
        >
          <TriangleAlert size={13} aria-hidden /> Drawer came up short · {shortCount}
        </FilterChip>

        <p className="ml-auto max-w-[52ch] text-xs text-fg-subtle">
          Built from the trail: a shift is one person, one till, one day. Nobody keys these.
        </p>
      </div>

      <div data-density="compact" className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={cn('grid shrink-0 items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5', COLS)}>
          <span className="micro-label">Till</span>
          <span className="micro-label">Who</span>
          <span className="micro-label">On the counter</span>
          <span className="micro-label">07:00 — 23:00</span>
          <span className="micro-label">What went through</span>
          <span className="micro-label text-right">Drawer ₹</span>
        </div>

        <div className="scroll-region min-h-0 flex-1">
          {days.length === 0 ? (
            <EmptyState
              icon={Clock}
              title={all.length === 0 ? 'No counter activity yet' : 'No shift matches that'}
              body={all.length === 0
                ? 'A shift appears here as soon as somebody signs in at a till or posts a bill on one. Back-room work — a stock write-off, a user edit — is not counter work and is not counted.'
                : 'Nothing on that till, or no drawer came up short in the loaded window. That is the good answer.'}
              actionLabel={all.length === 0 ? undefined : 'Show every shift'}
              onAction={() => { setTill(null); setShortOnly(false) }}
            />
          ) : (
            days.map((day) => (
              <DayBlock key={day.day} day={day} today={today} onOpenPerson={onOpenPerson} />
            ))
          )}
        </div>

        {days.length > 0 ? (
          <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-subtle">
            <span>
              {filtered.length} shift{filtered.length === 1 ? '' : 's'} across {days.length} day
              {days.length === 1 ? '' : 's'}
            </span>
            <span className="ml-auto">
              A shift is one person, one till, one day — a quiet afternoon is not a handover.
            </span>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

function FilterChip({
  on,
  onClick,
  disabled,
  tone,
  children,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  tone?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm',
        'disabled:pointer-events-none disabled:opacity-45',
        on
          ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
          : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
      )}
      style={on || !tone ? undefined : { color: tone }}
    >
      {children}
    </button>
  )
}

function DayBlock({
  day,
  today,
  onOpenPerson,
}: {
  day: CounterDay
  today: IsoDate
  onOpenPerson: (userId: number) => void
}) {
  const short = isShort(day.variance)
  return (
    <section>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5">
        <span className="text-sm font-medium text-fg">{dayLabel(day.day, today)}</span>
        <span className="text-2xs text-fg-muted">
          {day.people} {day.people === 1 ? 'person' : 'people'} · {day.tills} till{day.tills === 1 ? '' : 's'}
        </span>
        <span className="num text-2xs text-fg-muted">
          {day.bills} bill{day.bills === 1 ? '' : 's'} · ₹{formatAmount(day.takings)}
        </span>
        {day.voids > 0 ? (
          <Chip icon={Ban} tone="var(--danger-11)">{day.voids} voided</Chip>
        ) : null}
        {day.overrides > 0 ? (
          <Chip icon={BadgeCheck} tone="var(--warning-11)">{day.overrides} signed off</Chip>
        ) : null}
        {day.variance !== null ? (
          <span className="ml-auto">
            {short
              ? <Chip icon={TriangleAlert} tone="var(--danger-11)">Drawer short ₹{formatAmount(day.variance.replace('-', ''))}</Chip>
              : <Chip icon={Banknote} tone="var(--success-11)">Drawer square</Chip>}
          </span>
        ) : null}
      </header>

      {day.shifts.map((shift) => (
        <ShiftRow key={shift.key} shift={shift} onOpenPerson={onOpenPerson} />
      ))}
    </section>
  )
}

function ShiftRow({ shift, onOpenPerson }: { shift: Shift; onOpenPerson: (userId: number) => void }) {
  const from = Math.max(DAY_FROM, Math.min(DAY_TO, minuteOfDay(shift.from)))
  const to = Math.max(from, Math.min(DAY_TO, minuteOfDay(shift.to)))
  const span = DAY_TO - DAY_FROM
  const left = ((from - DAY_FROM) / span) * 100
  /* A floor of 1.5% so a single action at one moment is still a visible tick
     rather than a zero-width nothing the reader assumes is a rendering bug. */
  const width = Math.max(1.5, ((to - from) / span) * 100)
  const short = isShort(shift.drawerVariance)

  return (
    <div
      className={cn('grid items-center gap-3 border-b border-border-subtle px-[var(--cell-px)] py-2 hover:bg-hover', COLS)}
      style={{ minHeight: 'var(--row-h)' }}
    >
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <Monitor size={13} className="shrink-0 text-fg-subtle" aria-hidden />
        Till {shift.terminalId}
      </span>

      <span className="flex min-w-0 flex-col">
        <button
          type="button"
          onClick={() => onOpenPerson(shift.actorId)}
          className="truncate rounded-[var(--radius-sm)] text-left text-sm font-medium text-fg hover:text-accent-11 hover:underline"
        >
          {shift.actorName}
        </button>
        <span className="truncate text-2xs text-fg-subtle">{ROLE_SHORT[shift.actorRole]}</span>
      </span>

      <span className="flex min-w-0 flex-col">
        <span className="num text-xs text-fg">
          {TIME_FMT.format(new Date(shift.from))} – {TIME_FMT.format(new Date(shift.to))}
        </span>
        <span className="flex items-center gap-1 text-2xs text-fg-subtle">
          {shift.signedIn ? <LogIn size={10} aria-hidden /> : null}
          {hoursLabel(shift.minutes)}
          {shift.signedIn ? '' : ' · no sign-in row'}
        </span>
      </span>

      <span
        className="relative h-2 rounded-[var(--radius-full)] bg-inset"
        role="img"
        aria-label={
          `On till ${shift.terminalId} from ${TIME_FMT.format(new Date(shift.from))}`
          + ` to ${TIME_FMT.format(new Date(shift.to))}`
          + (short ? '. The drawer came up short.' : '')
        }
      >
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 rounded-[var(--radius-full)]',
            short ? 'bg-danger-9' : 'bg-accent-9',
          )}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </span>

      <span className="num flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
        <span className="text-fg">{shift.bills} bill{shift.bills === 1 ? '' : 's'}</span>
        <span>₹{formatAmount(shift.takings)}</span>
        {shift.voids > 0 ? (
          <Chip icon={Ban} tone="var(--danger-11)">{shift.voids} void ₹{formatAmount(shift.voided)}</Chip>
        ) : null}
        {shift.refunds > 0 ? (
          <Chip icon={Undo2} tone="var(--status-expiry-60)">{shift.refunds} refund ₹{formatAmount(shift.refunded)}</Chip>
        ) : null}
        {shift.overrides > 0 ? (
          <Chip icon={BadgeCheck} tone="var(--warning-11)">{shift.overrides} signed</Chip>
        ) : null}
        {shift.bills === 0 && shift.voids === 0 && shift.refunds === 0 ? (
          <span className="text-2xs text-fg-subtle">Signed in, nothing billed</span>
        ) : null}
      </span>

      <span className="flex justify-end">
        {shift.drawerVariance === null ? (
          <span className="text-2xs text-fg-subtle">Not counted</span>
        ) : short ? (
          <Chip icon={TriangleAlert} tone="var(--danger-11)">
            −₹{formatAmount(shift.drawerVariance.replace('-', ''))}
          </Chip>
        ) : (
          <Chip icon={Banknote} tone="var(--success-11)">
            {shift.drawerVariance === '0.00' ? 'Square' : `+₹${formatAmount(shift.drawerVariance)}`}
          </Chip>
        )}
      </span>
    </div>
  )
}

/** Exported for the person panel, which shows the same rows in miniature. */
export function ShiftMini({ shift }: { shift: Shift }) {
  const short = isShort(shift.drawerVariance)
  return (
    <li className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle px-2.5 py-1.5">
      <Monitor size={13} className="shrink-0 text-fg-subtle" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="num truncate text-xs text-fg">
          {TIME_FMT.format(new Date(shift.from))} – {TIME_FMT.format(new Date(shift.to))} · till {shift.terminalId}
        </span>
        <span className="num truncate text-2xs text-fg-subtle">
          {shift.bills} bill{shift.bills === 1 ? '' : 's'} · ₹{formatAmount(shift.takings)} · {hoursLabel(shift.minutes)}
        </span>
      </span>
      {shift.drawerVariance !== null && short ? (
        <Chip icon={TriangleAlert} tone="var(--danger-11)">
          −₹{formatAmount(shift.drawerVariance.replace('-', ''))}
        </Chip>
      ) : null}
    </li>
  )
}
