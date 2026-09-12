import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight, Building2, CalendarClock, ChartColumn, CircleCheck, Handshake, Info,
  PackageCheck, Timer, TrendingDown, TrendingUp, TriangleAlert,
} from 'lucide-react'
import type { ApiAdapter, PurchaseInvoice } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatPercent } from '@/lib/format'
import {
  purchaseSummary, rateAlerts, rateMoves, spendByMonth, spendBySupplier, supplierScorecards,
} from '@/api/purchaseInsights'
import type { RateMove, SupplierScore } from '@/api/purchaseInsights'
import { BarChart, compactINR } from '@/components/charts'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Meter, MoneyStat, Panel } from './parts'

/**
 * What the purchase book knows about your distributors.
 *
 * A pharmacy's entire negotiating position with a distributor is informational.
 * The salesman knows what he wants to charge; the shop knows what it paid last
 * time, how much of the last order actually turned up, and how much of the last
 * expiry claim ever came back. Nowhere in the incumbent software is any of that
 * on one screen, so it is argued from memory and lost.
 *
 * So this tab is four questions, in the order they get asked:
 *
 *  - Where did the money go? Spend by month and by distributor.
 *  - Whose rates are moving? Every move above a threshold, with the margin it
 *    leaves at the same MRP, newest first.
 *  - Who actually delivers? Fill rate and lead time, derived from the orders
 *    placed here against the goods that turned up afterwards.
 *  - Who settles their claims? Credit received against claim value.
 *
 * Every figure is derived from documents already on file. Nothing here is
 * entered by hand, and nothing is stored — which is what makes it trustworthy
 * enough to quote at a counter.
 */

/** Twelve months, because buying is seasonal and six hides the season. */
const MONTHS = 12

/**
 * Above which move an alert is worth interrupting somebody about.
 *
 * Three, because a distributor's rate moves for three different reasons and the
 * shop cares about them differently: 2% is the noise of a scheme changing, 5% is
 * a real increase, 10% is one to ring about before the next order.
 */
const THRESHOLDS = ['2', '5', '10'] as const

/**
 * The register in one array.
 *
 * `listPurchases` is a cursor page like every other list in the contract, and
 * every figure on this tab is an aggregate over the whole book, so the pages are
 * walked. Capped: a shop with more than four thousand bills on file scores the
 * newest four thousand, which is a year of buying for a busy counter — the
 * alternative is a tab that never paints.
 */
async function loadRegister(api: ApiAdapter): Promise<PurchaseInvoice[]> {
  const out: PurchaseInvoice[] = []
  let cursor: number | null = null
  for (let page = 0; page < 20; page++) {
    const res: { rows: PurchaseInvoice[]; nextCursor: number | null } = await api.listPurchases(
      cursor === null ? { limit: 200 } : { limit: 200, cursor },
    )
    out.push(...res.rows)
    if (res.nextCursor === null) break
    cursor = res.nextCursor
  }
  return out
}

export function PurchaseInsights({ onOpenPurchase }: { onOpenPurchase: (id: number) => void }) {
  const api = useApi()
  const today = useMemo(() => new Date(), [])
  const [threshold, setThreshold] = useState<string>('5')
  const [focus, setFocus] = useState<number | null>(null)

  const register = useQuery({
    queryKey: ['purchases', 'insights', 'register'],
    queryFn: () => loadRegister(api),
  })
  const suppliers = useQuery({ queryKey: ['suppliers', ''], queryFn: () => api.listSuppliers() })
  const orders = useQuery({
    queryKey: ['purchaseOrders'],
    queryFn: () => api.listPurchaseOrders({}),
  })
  const returns = useQuery({
    queryKey: ['supplierReturns'],
    queryFn: () => api.listSupplierReturns({}),
  })

  const purchases = useMemo(() => register.data ?? [], [register.data])

  const summary = useMemo(() => purchaseSummary(purchases, today), [purchases, today])
  const months = useMemo(
    () => spendByMonth(purchases, { months: MONTHS, today }),
    [purchases, today],
  )
  const bySupplier = useMemo(() => spendBySupplier(purchases), [purchases])
  const moves = useMemo(() => rateMoves(purchases), [purchases])
  const alerts = useMemo(
    () => rateAlerts(moves, { thresholdPct: threshold, limit: 40, supplierId: focus }),
    [moves, threshold, focus],
  )
  const scores = useMemo(
    () => supplierScorecards({
      suppliers: suppliers.data ?? [],
      purchases,
      orders: orders.data ?? [],
      returns: returns.data ?? [],
      today,
    }),
    [suppliers.data, purchases, orders.data, returns.data, today],
  )

  const focused = focus === null ? null : scores.find((s) => s.supplierId === focus) ?? null

  if (register.isPending) {
    return (
      <div className="card min-h-0 flex-1 overflow-hidden p-[var(--card-px)]">
        <SkeletonRows rows={10} cols={5} />
      </div>
    )
  }

  if (register.error) {
    return (
      <div className="card min-h-0 flex-1 overflow-auto">
        <ErrorState
          code={register.error instanceof ApiError ? register.error.code : 'PURCHASES_FAILED'}
          message={(register.error as Error).message}
          onRetry={() => void register.refetch()}
        />
      </div>
    )
  }

  if (purchases.length === 0) {
    return (
      <div className="card min-h-0 flex-1 overflow-auto">
        <EmptyState
          icon={ChartColumn}
          title="Nothing bought yet"
          body="Every figure on this tab is worked out from the bills, orders and claims already on file. Receive one goods receipt and this fills itself in."
        />
      </div>
    )
  }

  return (
    <div className="scroll-region flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--card-gap)]">
      {/* ------------------------------------------------------- the money --- */}
      <div className="grid shrink-0 gap-[var(--card-gap)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]">
        <div className="card flex flex-col justify-between gap-4 p-[var(--card-px)]">
          {/* The twelve-month figure leads, not the month-to-date one: on the
              second of the month the latter is zero, and a hero that reads
              ₹0.00 for two days out of every thirty is a hero nobody trusts. */}
          <MoneyStat
            label="Bought in the last 12 months"
            amount={summary.yearSpend}
            size="hero"
            hint={
              <>
                <span className="num">{summary.yearBills}</span> bill
                {summary.yearBills === 1 ? '' : 's'} from{' '}
                <span className="num">{summary.suppliersUsed}</span> distributor
                {summary.suppliersUsed === 1 ? '' : 's'}
                {summary.avgBill === null ? null : <> · ₹{formatAmount(summary.avgBill)} a bill</>}
              </>
            }
          />
          <div className="border-t border-border-subtle pt-3">
            <MoneyStat
              label={`Bought in ${summary.monthLabel}`}
              amount={summary.monthSpend}
              size="md"
              hint={
                <MonthMove
                  movePct={summary.monthMovePct}
                  previous={summary.previousMonthSpend}
                  bills={summary.monthBills}
                />
              }
            />
          </div>
        </div>

        <Panel
          title="Spend by month"
          icon={ChartColumn}
          description="Net of every posted bill, on the month the distributor dated it. A cancelled bill bought nothing and is not here."
        >
          <div className="min-w-0 p-[var(--card-px)] pt-3">
            <BarChart
              ariaLabel="Purchase spend by month"
              data={months.map((m) => ({
                key: m.key,
                label: m.label,
                value: D.toNumber(D.dec(m.amount)),
                hint: `${m.bills} bill${m.bills === 1 ? '' : 's'}`,
              }))}
              height={188}
              valueFormat={compactINR}
            />
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------- suppliers and the rates --- */}
      <div className="grid shrink-0 gap-[var(--card-gap)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Panel
          title="Where the money goes"
          icon={Building2}
          description="Share of everything bought, by distributor. Concentration is not a fault — it is leverage, as long as you know it is there."
        >
          <div className="min-w-0 p-[var(--card-px)] pt-3">
            <BarChart
              ariaLabel="Purchase spend by supplier"
              horizontal
              data={bySupplier.slice(0, 7).map((s) => ({
                key: String(s.supplierId),
                label: s.supplierName,
                value: D.toNumber(D.dec(s.amount)),
                hint: `${formatPercent(s.sharePct)} of spend · ${s.bills} bill${s.bills === 1 ? '' : 's'}`,
              }))}
              height={224}
              valueFormat={compactINR}
            />
          </div>
        </Panel>

        <RateWatch
          alerts={alerts}
          total={moves.length}
          threshold={threshold}
          onThreshold={setThreshold}
          focusName={focused?.supplierName ?? null}
          onClearFocus={() => setFocus(null)}
          onOpenPurchase={onOpenPurchase}
        />
      </div>

      {/* ------------------------------------------------------- scorecard --- */}
      <Scorecard
        rows={scores}
        loading={suppliers.isPending}
        focus={focus}
        onFocus={(id) => setFocus((prev) => (prev === id ? null : id))}
      />
    </div>
  )
}

/** Month on month, as a direction and a word — never as a colour on its own. */
function MonthMove({
  movePct, previous, bills,
}: {
  movePct: string | null
  previous: string
  bills: number
}) {
  const billLine = `${bills} bill${bills === 1 ? '' : 's'}`
  if (movePct === null) {
    return <>{billLine} · nothing bought the month before</>
  }
  const move = D.dec(movePct)
  const up = !D.isNeg(move)
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className="flex items-center gap-1.5">
      <span>{billLine}</span>
      <span aria-hidden>·</span>
      <span className={cn('inline-flex items-center gap-1', up ? 'text-warning-11' : 'text-success-11')}>
        <Icon size={13} aria-hidden />
        {up ? 'up' : 'down'} {formatPercent(D.toStr(D.abs(move), 1))}
      </span>
      <span className="truncate">on ₹{formatAmount(previous)} last month</span>
    </span>
  )
}

/**
 * Rate moves, above a threshold the operator sets.
 *
 * The margin at the SAME MRP is on every row, because that is the number the
 * increase actually costs: a 9% rise on a line whose MRP has not moved is nine
 * per cent off the only margin the shop has.
 */
function RateWatch({
  alerts, total, threshold, onThreshold, focusName, onClearFocus, onOpenPurchase,
}: {
  alerts: RateMove[]
  total: number
  threshold: string
  onThreshold: (v: string) => void
  focusName: string | null
  onClearFocus: () => void
  onOpenPurchase: (id: number) => void
}) {
  return (
    <Panel
      title="Rate watch"
      icon={TriangleAlert}
      description={
        <>
          Every rate a distributor has moved against their own last bill for the same pack.
          {' '}Two distributors charging differently is ordinary; the same one charging more is not.
        </>
      }
      actions={
        <div className="flex items-center gap-2">
          {focusName ? (
            <button
              type="button"
              onClick={onClearFocus}
              className="rounded-[var(--radius-sm)] bg-accent-3 px-2 py-1 text-2xs font-medium text-accent-11 hover:bg-accent-6/40"
            >
              {focusName} only — clear
            </button>
          ) : null}
          <div
            role="radiogroup"
            aria-label="Alert threshold"
            className="flex h-9 items-center gap-0.5 rounded-[var(--radius-md)] border border-border-subtle bg-inset p-0.5"
          >
            {THRESHOLDS.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={threshold === t}
                aria-label={`Alert above ${t} percent`}
                onClick={() => onThreshold(t)}
                className={cn(
                  'num h-full rounded-[var(--radius-sm)] px-2.5 text-xs font-medium',
                  threshold === t ? 'bg-surface text-fg shadow-[var(--shadow-xs)]' : 'text-fg-muted hover:text-fg',
                )}
              >
                ±{t}%
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="scroll-region max-h-[320px] min-h-0 flex-1">
        {alerts.length === 0 ? (
          <EmptyState
            icon={CircleCheck}
            title={total === 0 ? 'No rate history yet' : `Nothing has moved more than ${threshold}%`}
            body={total === 0
              ? 'A rate move needs two bills for the same pack from the same distributor. The second receipt of a line is where this starts.'
              : 'Every rate on file is within that of what the same distributor charged last time. Drop the threshold to see the smaller moves.'}
          />
        ) : (
          <ul aria-label="Rate change alerts">
            {alerts.map((a) => <RateRow key={a.id} move={a} onOpen={() => onOpenPurchase(a.purchaseId)} />)}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function RateRow({ move, onOpen }: { move: RateMove; onOpen: () => void }) {
  const up = !D.isNeg(D.dec(move.movePct))
  const Icon = up ? TrendingUp : TrendingDown
  const magnitude = formatPercent(D.toStr(D.abs(D.dec(move.movePct)), 1))

  return (
    <li className="border-b border-border-subtle last:border-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-[var(--card-px)] py-2.5 text-left hover:bg-hover"
      >
        {/* Direction is a word and an arrow as well as a tone: these rows are
            read at an angle on a matte counter panel. */}
        <span
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-xs font-semibold',
            up ? 'bg-danger-3 text-danger-11' : 'bg-success-3 text-success-11',
          )}
        >
          <Icon size={13} aria-hidden />
          {up ? 'up' : 'down'} {magnitude}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-base font-medium text-fg" title={move.brandName}>
              {move.brandName}
            </span>
            <span className="shrink-0 text-2xs text-fg-subtle">{move.packLabel}</span>
          </span>
          <span className="flex items-baseline gap-1.5 truncate text-2xs text-fg-muted">
            <span className="truncate">{move.supplierName}</span>
            <span aria-hidden>·</span>
            <span className="mono">{move.supplierInvoiceNo}</span>
            <span aria-hidden>·</span>
            <span className="num">{move.invoiceDate}</span>
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="num block text-sm">
            <span className="text-fg-subtle line-through">₹{formatAmount(move.from)}</span>
            {' → '}
            <span className="font-medium text-fg">₹{formatAmount(move.to)}</span>
          </span>
          <span className="num block text-2xs text-fg-muted">
            {move.marginPct === null || move.marginPctBefore === null
              ? 'per pack, GST-exclusive'
              : <>margin {formatPercent(move.marginPctBefore)} → {formatPercent(move.marginPct)}</>}
          </span>
        </span>
        <ArrowRight size={14} className="shrink-0 text-fg-subtle" aria-hidden />
      </button>
    </li>
  )
}

/**
 * The scorecard.
 *
 * Four questions about a distributor that nobody can answer from memory: do they
 * send what you order, how long do they take, do their rates creep, and do they
 * pay their claims. Every column that CANNOT be answered from the documents says
 * so with a dash — a fill rate of 0% beside a distributor who has never been
 * ordered from through this software is a lie, and it is the kind that gets
 * quoted back to them.
 */
function Scorecard({
  rows, loading, focus, onFocus,
}: {
  rows: SupplierScore[]
  loading: boolean
  focus: number | null
  onFocus: (id: number) => void
}) {
  return (
    <Panel
      title="Supplier scorecard"
      icon={Handshake}
      description="Worked out from the orders, bills and claims on file over the last year. Pick a row to filter the rate watch above to that distributor."
      className="shrink-0"
    >
      {loading ? (
        <div className="p-[var(--card-px)]"><SkeletonRows rows={5} cols={6} /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No distributors on file"
          body="A goods receipt is a document against a distributor. Add the first one on the Suppliers screen and their score builds itself from the bills."
        />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="bg-subtle">
                <th scope="col" className="micro-label border-b border-border-subtle px-[var(--card-px)] py-2 text-left">Distributor</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Spend, 12 months</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Fill rate</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Lead time</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Rate moves</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Scheme</th>
                <th scope="col" className="micro-label border-b border-border-subtle px-3 py-2 text-right">Claims settled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ScoreRow
                  key={row.supplierId}
                  row={row}
                  selected={focus === row.supplierId}
                  onSelect={() => onFocus(row.supplierId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-start gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2 text-2xs text-fg-muted">
        <Info size={13} className="mt-px shrink-0 text-fg-subtle" aria-hidden />
        <span>
          Fill rate and lead time compare the orders placed here against the goods that arrived
          afterwards, and free packs count as delivered. A dash means there is nothing on file to
          judge — never a zero.
        </span>
      </div>
    </Panel>
  )
}

/** Fill rate bands. Below 85% is a conversation; below 70% is a supplier problem. */
function fillTone(pct: string | null): { tone: 'success' | 'warning' | 'danger'; word: string } {
  if (pct === null) return { tone: 'warning', word: '' }
  const v = D.dec(pct)
  if (D.gte(v, D.dec('95'))) return { tone: 'success', word: 'in full' }
  if (D.gte(v, D.dec('85'))) return { tone: 'warning', word: 'short' }
  return { tone: 'danger', word: 'well short' }
}

function ScoreRow({
  row, selected, onSelect,
}: {
  row: SupplierScore
  selected: boolean
  onSelect: () => void
}) {
  const fill = fillTone(row.fill.pct)
  const share = Number.parseFloat(row.sharePct)

  return (
    <tr
      data-supplier-score
      onClick={onSelect}
      aria-selected={selected}
      className={cn(
        'cursor-default border-b border-border-subtle last:border-0',
        selected ? 'bg-accent-3/60' : 'hover:bg-hover',
      )}
    >
      <th scope="row" className="max-w-[240px] px-[var(--card-px)] py-2.5 text-left font-normal">
        <button
          type="button"
          onClick={onSelect}
          className="block w-full truncate text-left text-base font-medium text-fg"
        >
          {row.supplierName}
        </button>
        <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-fg-muted">
          <span className="num">{row.bills} bill{row.bills === 1 ? '' : 's'}</span>
          <span aria-hidden>·</span>
          <span className="num">{row.paymentTermsDays}d terms</span>
          {D.gt(D.dec(row.outstanding), D.ZERO) ? (
            <>
              <span aria-hidden>·</span>
              <span className="num">₹{formatAmount(row.outstanding)} owed</span>
            </>
          ) : null}
        </span>
      </th>

      <td className="px-3 py-2.5 text-right">
        <span className="num text-base font-medium text-fg">₹{formatAmount(row.spend)}</span>
        <span className="mt-1 flex items-center justify-end gap-2">
          <span className="w-16">
            <Meter pct={share} ariaLabel={`${row.supplierName} share of spend`} />
          </span>
          <span className="num w-10 text-2xs text-fg-muted">{formatPercent(row.sharePct)}</span>
        </span>
      </td>

      <td className="px-3 py-2.5 text-right">
        {row.fill.pct === null ? (
          <Dash hint={`No order with ${row.supplierName} has come due yet`} />
        ) : (
          <>
            <span className="num text-base font-medium text-fg">{formatPercent(row.fill.pct)}</span>
            <span className="mt-0.5 flex items-center justify-end gap-1 text-2xs">
              <PackageCheck size={11} aria-hidden className={cn(
                fill.tone === 'success' ? 'text-success-11'
                  : fill.tone === 'warning' ? 'text-warning-11' : 'text-danger-11',
              )} />
              <span className={cn(
                fill.tone === 'success' ? 'text-success-11'
                  : fill.tone === 'warning' ? 'text-warning-11' : 'text-danger-11',
              )}>
                {fill.word}
              </span>
              <span className="num text-fg-subtle">
                · {row.fill.orders} order{row.fill.orders === 1 ? '' : 's'}
              </span>
            </span>
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {row.leadTimeDays === null ? (
          <Dash hint="Nothing ordered here has arrived yet" />
        ) : (
          <>
            <span className="num text-base font-medium text-fg">{row.leadTimeDays}d</span>
            <span className="mt-0.5 flex items-center justify-end gap-1 text-2xs text-fg-muted">
              <Timer size={11} aria-hidden /> over {row.leadSamples} order{row.leadSamples === 1 ? '' : 's'}
            </span>
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {row.rateRises === 0 && row.rateFalls === 0 ? (
          <Dash hint="No pack has been bought twice from them yet" />
        ) : (
          <>
            <span className="flex items-center justify-end gap-1">
              <TrendingUp size={13} className="text-danger-11" aria-hidden />
              <span className="num text-base font-medium text-fg">{row.rateRises}</span>
              <span className="text-2xs text-fg-muted">up</span>
              <span className="num ml-1 text-2xs text-fg-subtle">/ {row.rateFalls} down</span>
            </span>
            {row.medianRisePct === null ? null : (
              <span className="num mt-0.5 block text-2xs text-fg-muted">
                typical rise {formatPercent(row.medianRisePct)}
              </span>
            )}
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {row.schemePct === null || D.isZero(D.dec(row.schemePct)) ? (
          <Dash hint="No free goods on their bills" />
        ) : (
          <>
            <span className="num text-base font-medium text-success-11">
              {formatPercent(row.schemePct)}
            </span>
            <span className="mt-0.5 block text-2xs text-fg-muted">free packs</span>
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {row.claims.settledPct === null && row.claims.open === 0 ? (
          <Dash hint="No expiry claim has been raised on them" />
        ) : (
          <>
            <span className="num text-base font-medium text-fg">
              {row.claims.settledPct === null ? '—' : formatPercent(row.claims.settledPct)}
            </span>
            <span className="mt-0.5 flex items-center justify-end gap-1 text-2xs">
              {row.claims.open > 0 ? (
                <Chip icon={CalendarClock} tone="var(--warning-11)">
                  {row.claims.open} open
                </Chip>
              ) : (
                <span className="num text-fg-muted">{row.claims.settled} settled</span>
              )}
            </span>
          </>
        )}
      </td>
    </tr>
  )
}

/** An unknown, said out loud. Never a zero — see the panel footer. */
function Dash({ hint }: { hint: string }) {
  return (
    <span className="block" title={hint}>
      <span className="text-base text-fg-disabled">—</span>
      <span className="sr-only">{hint}</span>
    </span>
  )
}
