import { useMemo } from 'react'
import {
  Banknote, ChevronDown, ChevronUp, Clock, CreditCard, HandCoins, Minus, Smartphone,
  TrendingDown, TrendingUp, Undo2, UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HourlyTotal, Money, PaymentMode, SalesSummary } from '@contract'
import * as D from '@/domain/decimal'
import { pctChange } from '@/api/sales'
import type { ReturnsTotals } from '@/api/sales'
import { cn } from '@/lib/cn'
import { formatAmount, formatPercent, formatQty } from '@/lib/format'
import { compactINR } from '@/components/charts'

/**
 * The analytics header.
 *
 * Four questions, and they are the four a shopkeeper asks on the way past the
 * till: what did we take, how was it paid, when were we busy, and who was
 * serving. Every figure carries the same period before it, because a day's
 * takings on their own are a number and not information — ₹84,000 is a good
 * Tuesday or a bad one depending entirely on last Tuesday.
 *
 * THE COMPARISON IS THE PREVIOUS PERIOD OF THE SAME LENGTH, never last year.
 * See `previousRange`: a pharmacy's year-on-year figure is dominated by which
 * week the festivals fell in, and a comparison the operator cannot reproduce in
 * their head is one they will not believe.
 *
 * The band collapses to a single line. The 1366x640 counter panel this app is
 * designed for cannot spend 200px on a header and still show a screenful of
 * bills, so on a short screen it opens collapsed — and the line it collapses to
 * still carries the day's takings and the change against yesterday.
 */

const MODE_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Credit',
}

const MODE_ICON: Record<PaymentMode, LucideIcon> = {
  CASH: Banknote, UPI: Smartphone, CARD: CreditCard, CREDIT: HandCoins,
}

/** '₹' set at the value's own optical weight, not at its size. */
function Rupee({ className }: { className?: string }) {
  return <span className={cn('text-[0.52em] font-medium text-fg-muted', className)} aria-hidden>₹</span>
}

// ------------------------------------------------------------------ deltas ---

type Direction = 'up' | 'down' | 'flat' | 'fromNothing' | 'toNothing'

interface Delta {
  direction: Direction
  /** Signed, one decimal. Null when the previous period gives no basis. */
  pct: string | null
}

function deltaOf(before: Money, after: Money): Delta {
  const b = D.dec(before)
  const a = D.dec(after)
  if (D.isZero(b) && D.isZero(a)) return { direction: 'flat', pct: null }
  if (D.isZero(b)) return { direction: 'fromNothing', pct: null }
  if (D.isZero(a)) return { direction: 'toNothing', pct: null }
  const pct = pctChange(before, after)
  /* A move too small to survive one decimal place is not a move. "Down 0%" is
     the kind of figure that makes a reader stop trusting the rest of the card,
     and the honest reading of ₹51,088 against ₹51,102 is "level". */
  if (pct !== null && D.isZero(D.dec(pct))) return { direction: 'flat', pct }
  const cmp = D.cmp(a, b)
  return { direction: cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'flat', pct }
}

const countDelta = (before: number, after: number): Delta =>
  deltaOf(D.toStr(D.dec(before), 2), D.toStr(D.dec(after), 2))

const DELTA_ICON: Record<Direction, LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
  fromNothing: TrendingUp,
  toNothing: TrendingDown,
}

/**
 * A change against the previous period.
 *
 * The direction is carried by an ICON, a WORD and the sign — never by the
 * colour, which a matte counter panel viewed at an angle does not deliver and
 * which a red-green blind pharmacist does not receive at all.
 *
 * `good` says which way is the good way, because up is not always up: returns
 * rising and cancellations rising are both bad news, and painting them in the
 * same green as takings would train the eye to skim past exactly the two
 * figures worth stopping on.
 */
function DeltaTag({
  delta, good = 'up', previous, className,
}: {
  delta: Delta
  good?: 'up' | 'down' | 'neutral'
  /** Rendered into the title, so the figure behind the percentage is one hover away. */
  previous: string
  className?: string
}) {
  const Icon = DELTA_ICON[delta.direction]
  const rising = delta.direction === 'up' || delta.direction === 'fromNothing'
  const falling = delta.direction === 'down' || delta.direction === 'toNothing'
  const tone = good === 'neutral' || delta.direction === 'flat'
    ? 'var(--fg-muted)'
    : (rising && good === 'up') || (falling && good === 'down')
      ? 'var(--success-11)'
      : 'var(--warning-11)'

  const word =
    delta.direction === 'flat' ? 'level'
      : delta.direction === 'fromNothing' ? 'new'
        : delta.direction === 'toNothing' ? 'gone'
          : delta.pct === null ? (rising ? 'up' : 'down')
            : `${rising ? 'up' : 'down'} ${formatPercent(D.toStr(D.abs(D.dec(delta.pct)), 1))}`

  return (
    <span
      title={`Previous period: ${previous}`}
      className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap', className)}
      style={{ color: tone }}
    >
      <Icon size={13} strokeWidth={2.25} aria-hidden />
      {word}
    </span>
  )
}

// ------------------------------------------------------------- hour profile ---

/** A pharmacy's default shutters, used when neither period traded at all. */
const DEFAULT_OPEN = 8
const DEFAULT_CLOSE = 22

/**
 * The window worth drawing.
 *
 * Twenty-four columns in a 240px card is eight pixels a bar, and eleven of them
 * are the dead hours between midnight and eight. The window is trimmed to the
 * hours EITHER period traded in — both, so the ghost of last week cannot fall
 * outside the frame and silently vanish — and never narrower than the shop's
 * usual shutters, so a quiet morning still reads as a quiet morning rather than
 * being cropped out of existence.
 */
function tradingWindow(now: readonly HourlyTotal[], before: readonly HourlyTotal[]): number[] {
  const active = (h: HourlyTotal): boolean => h.bills > 0
  const hours = [...now.filter(active), ...before.filter(active)].map((h) => h.hour)
  const first = hours.length > 0 ? Math.min(DEFAULT_OPEN, ...hours) : DEFAULT_OPEN
  const last = hours.length > 0 ? Math.max(DEFAULT_CLOSE, ...hours) : DEFAULT_CLOSE
  return Array.from({ length: last - first + 1 }, (_, i) => first + i)
}

const HOUR_H = 74
const NO_HOURS: HourlyTotal[] = []

function HourProfile({
  summary, previous,
}: {
  summary: SalesSummary
  previous: SalesSummary | null
}) {
  const prevHours = previous?.byHour ?? NO_HOURS
  const hours = useMemo(() => tradingWindow(summary.byHour, prevHours), [summary.byHour, prevHours])

  const value = (list: readonly HourlyTotal[], hour: number): number =>
    D.toNumber(D.dec(list.find((h) => h.hour === hour)?.amount ?? '0.00'))

  const nowValues = hours.map((h) => value(summary.byHour, h))
  const prevValues = hours.map((h) => value(prevHours, h))
  const peak = Math.max(1, ...nowValues, ...prevValues)

  const busiest = summary.byHour.reduce<HourlyTotal | null>(
    (best, h) => (best === null || D.gt(D.dec(h.amount), D.dec(best.amount)) ? h : best),
    null,
  )
  const quiet = busiest === null || busiest.bills === 0

  return (
    <div className="min-w-0">
      <div className="flex items-end gap-[2px]" style={{ height: HOUR_H }} aria-hidden>
        {hours.map((hour, i) => {
          const nowPct = ((nowValues[i] ?? 0) / peak) * 100
          const prevPct = ((prevValues[i] ?? 0) / peak) * 100
          /* Found by HOUR, not by position. The bars beside this are already
             read that way, and a subscript is only the hour while the list is
             the full twenty-four the contract promises — the day a caller hands
             over the trading hours alone, a subscript labels each bar with
             somebody else's money and looks entirely plausible doing it. */
          const at = summary.byHour.find((h) => h.hour === hour)
          const bills = at?.bills ?? 0
          return (
            <div
              key={hour}
              title={`${String(hour).padStart(2, '0')}:00 — ₹${formatAmount(at?.amount ?? '0.00')} over ${bills} bill${bills === 1 ? '' : 's'}`}
              className="relative min-w-0 flex-1"
              style={{ height: HOUR_H }}
            >
              {/* The previous period sits BEHIND as a flat ghost, never as a
                  second coloured series: two hues in a 240px card is a legend,
                  and the ghost only has to answer "more or less than last time". */}
              <span
                className="absolute inset-x-0 bottom-0 rounded-t-[2px] bg-[var(--viz-muted)]"
                style={{ height: `${Math.max(prevPct, prevPct > 0 ? 2 : 0)}%` }}
              />
              <span
                className="absolute inset-x-0 bottom-0 rounded-t-[2px] bg-accent-9"
                style={{ height: `${Math.max(nowPct, nowPct > 0 ? 2 : 0)}%`, opacity: 0.92 }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex items-baseline gap-[2px]" aria-hidden>
        {hours.map((hour, i) => (
          <span key={hour} className="num min-w-0 flex-1 text-center text-2xs text-fg-subtle">
            {i % 3 === 0 ? String(hour).padStart(2, '0') : ''}
          </span>
        ))}
      </div>

      <table className="sr-only">
        <caption>Takings by hour, this period against the previous one</caption>
        <thead>
          <tr><th scope="col">Hour</th><th scope="col">This period</th><th scope="col">Previous period</th></tr>
        </thead>
        <tbody>
          {hours.map((hour, i) => (
            <tr key={hour}>
              <th scope="row">{String(hour).padStart(2, '0')}:00</th>
              <td>{compactINR(nowValues[i] ?? 0)}</td>
              <td>{compactINR(prevValues[i] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-1.5 truncate text-xs text-fg-muted">
        {quiet
          ? 'No bills in this range yet.'
          : <>
              Busiest at{' '}
              <span className="num font-medium text-fg">
                {String(busiest.hour).padStart(2, '0')}:00
              </span>
              {' — '}
              <span className="num" title={`₹${formatAmount(busiest.amount)}`}>
                ₹{compactINR(D.toNumber(D.dec(busiest.amount)))}
              </span>
              {' over '}
              <span className="num">{busiest.bills}</span> bill{busiest.bills === 1 ? '' : 's'}
            </>}
      </p>
    </div>
  )
}

// -------------------------------------------------------------------- cards ---

function Card({
  title, icon: Icon, note, children, className,
}: {
  title: string
  icon: LucideIcon
  note?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('card flex min-w-0 flex-col p-[var(--card-px)]', className)}>
      <header className="mb-2.5 flex shrink-0 items-baseline gap-2">
        <Icon size={14} className="shrink-0 self-center text-fg-subtle" aria-hidden />
        <h3 className="micro-label truncate">{title}</h3>
        {note ? <span className="ml-auto truncate text-2xs text-fg-subtle">{note}</span> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * The takings.
 *
 * One figure at display size, because this is the number the screen exists to
 * show, and the exact rupees underneath it: `₹1.4L` is what a shopkeeper reads
 * and `₹1,42,318.40` is what they write down, and a header that offers only one
 * of the two sends them to a report for the other.
 */
function TakingsCard({
  summary, previous, rangeLabel,
}: {
  summary: SalesSummary
  previous: SalesSummary | null
  rangeLabel: string
}) {
  const prev = previous ?? summary
  const has = previous !== null

  return (
    <section className="card flex min-w-0 flex-col justify-between p-[var(--card-px)]">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="micro-label truncate">Net sales</h3>
          <span className="ml-auto truncate text-2xs text-fg-subtle">{rangeLabel}</span>
        </div>
        <div className="mt-1 flex items-end gap-2.5">
          <span className="display-num truncate text-4xl text-fg" data-testid="net-sales">
            <Rupee />{compactINR(D.toNumber(D.dec(summary.netSales)))}
          </span>
          {has ? (
            <DeltaTag
              delta={deltaOf(prev.netSales, summary.netSales)}
              previous={`₹${formatAmount(prev.netSales)}`}
              className="mb-1.5"
            />
          ) : null}
        </div>
        <p className="num mt-0.5 truncate text-sm text-fg-muted">₹{formatAmount(summary.netSales)}</p>
      </div>

      <dl className="mt-3 grid shrink-0 grid-cols-4 gap-2 border-t border-border-subtle pt-2.5">
        <MiniStat
          label="Bills"
          value={summary.bills.toLocaleString('en-IN')}
          delta={has ? countDelta(prev.bills, summary.bills) : null}
          previous={`${prev.bills} bills`}
        />
        <MiniStat
          label="Average"
          value={`₹${formatAmount(summary.averageBill)}`}
          delta={has ? deltaOf(prev.averageBill, summary.averageBill) : null}
          previous={`₹${formatAmount(prev.averageBill)}`}
        />
        <MiniStat
          label="Units"
          value={formatQty(summary.itemsSold)}
          delta={has ? deltaOf(D.toStr(D.dec(prev.itemsSold), 2), D.toStr(D.dec(summary.itemsSold), 2)) : null}
          previous={formatQty(prev.itemsSold)}
        />
        {/* Returns rising is not good news, so `good` is inverted here. Painting
            it in the same green as takings would train the eye to skim past the
            one figure on the card worth stopping on. */}
        <MiniStat
          label="Returned"
          value={`₹${formatAmount(summary.returns)}`}
          delta={has ? deltaOf(prev.returns, summary.returns) : null}
          previous={`₹${formatAmount(prev.returns)}`}
          good="down"
        />
      </dl>
    </section>
  )
}

function MiniStat({
  label, value, delta, previous, good,
}: {
  label: string
  value: string
  delta: Delta | null
  previous: string
  good?: 'up' | 'down' | 'neutral'
}) {
  return (
    /* The movement lives INSIDE the <dd>. A <dl> group may hold only <dt> and
       <dd>, so a sibling span left the whole list malformed — and the delta is
       part of what the figure means anyway, not a third thing beside it. */
    <div className="min-w-0">
      <dt className="truncate text-2xs text-fg-subtle">{label}</dt>
      <dd className="min-w-0">
        <span className="num block truncate text-base font-medium text-fg">{value}</span>
        {delta ? (
          <DeltaTag delta={delta} previous={previous} {...(good ? { good } : {})} className="text-2xs" />
        ) : null}
      </dd>
    </div>
  )
}

/**
 * The tender split.
 *
 * A share of the LARGEST mode, not of the total: at 90% cash every other bar is
 * a sliver, and the point of the row is to compare them with each other.
 *
 * Cash is net of the change handed back, which is what the drawer holds — and
 * it is WITHHELD while today is still open and uncounted, because the blind
 * count is only blind if the answer is not printed three inches above the
 * button that asks for it.
 */
function TenderCard({
  summary, previous, hideCash,
}: {
  summary: SalesSummary
  previous: SalesSummary | null
  hideCash: boolean
}) {
  const amounts = summary.byMode.map((m) => D.toNumber(D.dec(m.amount)))
  /* The withheld cash figure is left OUT of the scale as well as out of the
     row. Scaled against it, every other bar shrinks in proportion to the cash
     in the drawer — which hands back, in the length of the UPI bar, most of
     what the blind count exists to keep back. */
  const peak = Math.max(
    ...summary.byMode.map((m, i) => (hideCash && m.mode === 'CASH' ? 0 : amounts[i] ?? 0)),
    1,
  )

  return (
    <Card
      title="Tender"
      icon={Banknote}
      note={hideCash ? 'cash at close' : 'cash net of change'}
    >
      <div className="flex flex-col gap-2">
        {summary.byMode.map((m, i) => {
          const Icon = MODE_ICON[m.mode]
          const withheld = hideCash && m.mode === 'CASH'
          const share = withheld ? 0 : Math.max(((amounts[i] ?? 0) / peak) * 100, 0)
          const before = previous?.byMode.find((p) => p.mode === m.mode)
          return (
            <div key={m.mode} className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <Icon size={12} className="shrink-0 self-center text-fg-subtle" aria-hidden />
                <span className="truncate text-xs text-fg-muted">{MODE_LABEL[m.mode]}</span>
                {withheld ? (
                  /* Not a blank and not a zero — either reads as "no cash today".
                     The row says plainly that the figure is held back and why. */
                  <span
                    className="ml-auto text-2xs text-fg-subtle"
                    title="Held back until the drawer is counted, so the count stays blind"
                  >
                    at close
                  </span>
                ) : (
                  <>
                    {before && !withheld ? (
                      <DeltaTag
                        delta={deltaOf(before.amount, m.amount)}
                        good="neutral"
                        previous={`₹${formatAmount(before.amount)}`}
                        className="ml-auto text-2xs"
                      />
                    ) : null}
                    <span className={cn('num text-sm font-medium text-fg', !before && 'ml-auto')}>
                      {formatAmount(m.amount)}
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1 h-1.5 w-full rounded-[var(--radius-full)] bg-inset">
                <div
                  className={cn(
                    'h-1.5 rounded-[var(--radius-full)]',
                    m.mode === 'CREDIT' ? 'bg-warning-9' : 'bg-accent-9',
                  )}
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/**
 * Who was on the counter.
 *
 * Ranked by takings, with each name's share of the range drawn behind it. It is
 * a leaderboard and it is read as one, which is exactly why the average bill is
 * on it: bill COUNT rewards whoever stood at the till through the evening rush,
 * and the average is the figure that says who is actually selling.
 */
function OperatorCard({
  summary, previous,
}: {
  summary: SalesSummary
  previous: SalesSummary | null
}) {
  const top = summary.byOperator.slice(0, 4)
  const rest = summary.byOperator.length - top.length
  const peak = Math.max(1, ...summary.byOperator.map((o) => D.toNumber(D.dec(o.amount))))

  return (
    <Card
      title="Who was billing"
      icon={UserRound}
      note={summary.byOperator.length > 0 ? `${summary.byOperator.length} on the counter` : undefined}
    >
      {top.length === 0 ? (
        <p className="text-xs text-fg-muted">No posted bill in this range carries an operator yet.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {top.map((op, rank) => {
            const before = previous?.byOperator.find((p) => p.operatorName === op.operatorName)
            const share = (D.toNumber(D.dec(op.amount)) / peak) * 100
            return (
              <li key={op.operatorName} className="relative min-w-0 rounded-[var(--radius-sm)] px-1.5 py-1">
                {/* The share is a wash BEHIND the row rather than a bar beside
                    it: four names, four numbers and four bars is more chrome
                    than a four-row list can carry. */}
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 rounded-[var(--radius-sm)] bg-accent-3"
                  style={{ width: `${share}%` }}
                />
                <span className="relative flex min-w-0 items-baseline gap-2">
                  <span className="num w-3 shrink-0 text-2xs text-fg-subtle">{rank + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={op.operatorName}>
                    {op.operatorName}
                  </span>
                  {before ? (
                    <DeltaTag
                      delta={deltaOf(before.amount, op.amount)}
                      previous={`₹${formatAmount(before.amount)}`}
                      className="text-2xs"
                    />
                  ) : null}
                  <span className="num shrink-0 text-sm font-medium text-fg">
                    {compactINR(D.toNumber(D.dec(op.amount)))}
                  </span>
                </span>
                <span className="relative mt-0.5 flex items-baseline gap-2 text-2xs text-fg-subtle">
                  <span className="w-3 shrink-0" aria-hidden />
                  <span className="num">{op.bills} bill{op.bills === 1 ? '' : 's'}</span>
                  <span aria-hidden>·</span>
                  <span className="num">avg ₹{formatAmount(op.averageBill)}</span>
                </span>
              </li>
            )
          })}
          {rest > 0 ? (
            <li className="px-1.5 text-2xs text-fg-subtle">and {rest} more on the counter</li>
          ) : null}
        </ol>
      )}
    </Card>
  )
}

// ----------------------------------------------------------------- the band ---

export function SalesAnalytics({
  summary, previous, rangeLabel, previousLabel, hideCash, open, onToggle,
}: {
  summary: SalesSummary
  /** Null until the previous period has resolved; every delta then stays off. */
  previous: SalesSummary | null
  rangeLabel: string
  previousLabel: string
  hideCash: boolean
  open: boolean
  onToggle: () => void
}) {
  const Chevron = open ? ChevronUp : ChevronDown
  const prev = previous ?? summary

  return (
    <div className="shrink-0 px-[var(--page-px)] pt-[var(--card-gap)]">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="micro-label truncate">
          {rangeLabel} · against {previousLabel}
        </h2>
        {!open ? (
          <div className="flex min-w-0 flex-1 items-baseline gap-3 overflow-hidden">
            <span className="num shrink-0 text-base font-semibold text-fg">
              ₹{formatAmount(summary.netSales)}
            </span>
            {previous ? (
              <DeltaTag
                delta={deltaOf(prev.netSales, summary.netSales)}
                previous={`₹${formatAmount(prev.netSales)}`}
              />
            ) : null}
            <span className="truncate text-xs text-fg-muted">
              <span className="num">{summary.bills}</span> bills · avg{' '}
              <span className="num">₹{formatAmount(summary.averageBill)}</span> ·{' '}
              <span className="num">₹{formatAmount(summary.returns)}</span> credited back
            </span>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5',
            'text-2xs font-medium text-fg-muted hover:bg-hover hover:text-fg',
          )}
        >
          {open ? 'Hide analytics' : 'Show analytics'}
          <Chevron size={13} aria-hidden />
        </button>
      </div>

      {open ? (
        <div
          className="grid gap-[var(--card-gap)]"
          style={{ gridTemplateColumns: 'minmax(260px,1.45fr) minmax(190px,1fr) minmax(210px,1.2fr) minmax(220px,1.25fr)' }}
        >
          <TakingsCard summary={summary} previous={previous} rangeLabel={rangeLabel} />
          <TenderCard summary={summary} previous={previous} hideCash={hideCash} />
          <Card
            title="Trade by hour"
            icon={Clock}
            note={previous ? 'ghost = previous' : undefined}
          >
            <HourProfile summary={summary} previous={previous} />
          </Card>
          <OperatorCard summary={summary} previous={previous} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * What came back in the range, in one line above the returns register.
 *
 * It describes the PERIOD, not the filtered rows underneath — the grid's own
 * footer says how many of them are on screen. Two numbers that answer different
 * questions are fine as long as each says which one it is answering.
 */
export function ReturnsSummaryStrip({
  totals, previousReturns,
}: {
  totals: ReturnsTotals
  /** The same figure for the previous period, or null while it resolves. */
  previousReturns: Money | null
}) {
  const offShelf = totals.quarantined + totals.destroyed
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 px-1">
      <span className="flex items-baseline gap-2">
        <Undo2 size={13} className="self-center text-fg-subtle" aria-hidden />
        <span className="num text-base font-semibold text-fg">₹{formatAmount(totals.value)}</span>
        {previousReturns !== null ? (
          <DeltaTag
            delta={deltaOf(previousReturns, totals.value)}
            good="down"
            previous={`₹${formatAmount(previousReturns)}`}
          />
        ) : null}
      </span>
      <span className="text-xs text-fg-muted">
        credited back on <span className="num">{totals.notes}</span> note{totals.notes === 1 ? '' : 's'} ·{' '}
        <span className="num">{formatQty(totals.units)}</span>{' '}
        unit{D.eq(D.dec(totals.units), D.ONE) ? '' : 's'} returned ·{' '}
        <span className="num">{offShelf}</span> line{offShelf === 1 ? '' : 's'} not resaleable
      </span>
      <span className="ml-auto flex items-baseline gap-3 text-xs text-fg-muted">
        {totals.byRefundMode
          .filter((m) => !D.isZero(D.dec(m.amount)))
          .map((m) => (
            <span key={m.mode} className="whitespace-nowrap">
              {MODE_LABEL[m.mode]} <span className="num text-fg">₹{formatAmount(m.amount)}</span>
            </span>
          ))}
      </span>
    </div>
  )
}
