import { useCallback, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IndianRupee, Percent, Receipt, TrendingUp, Users, Wallet } from 'lucide-react'
import type { DashboardRange } from '@contract'
import * as D from '@/domain/decimal'
import { useApi } from '@/api'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { ErrorState, SkeletonRows } from '@/components/states'
import { BarChart, Donut, compactINR } from '@/components/charts'
import { formatAmount } from '@/lib/format'
import { cn } from '@/lib/cn'
import { StatTile } from './StatTile'
import { AttentionRow } from './AttentionRow'
import { QuickActions } from './QuickActions'
import { RANGE_PHRASE, RANGE_SENTENCE, RangeTabs, isDashboardRange, shortenComparison } from './RangeTabs'
import { TakingsHero } from './TakingsHero'
import { BranchPanel } from './BranchPanel'
import { MoversPanel } from './MoversPanel'
import { ActivityPanel, CapitalAtRisk, LowStockPanel, Panel, TopMedicinesPanel } from './panels'

/**
 * Three people read this screen and want different halves of it.
 *
 * This is not cosmetic. A pharmacist at the counter has no business reading the
 * shop's margin or what it paid for a strip, and Phase 5 turns this into a real
 * `can_view_cost` permission — the toggle is where that boundary already lives, so
 * the layout does not have to change when the server starts enforcing it.
 */
const VIEWS = ['Owner', 'Manager', 'Pharmacist'] as const
type View = (typeof VIEWS)[number]

const SHOWS_MONEY: Record<View, boolean> = { Owner: true, Manager: true, Pharmacist: false }

/** The register preset that shows the same window the dashboard is reading. */
const SALES_PRESET: Record<DashboardRange, string> = {
  today: '/sales',
  '7d': '/sales?r=week',
  '30d': '/sales?r=month',
  month: '/sales?r=month',
}

/**
 * The shop's LOCAL calendar date.
 *
 * `toISOString().slice(0,10)` is the UTC one, and everything downstream reads
 * local: `startOfLocalDay` fences the day on the shop's clock, `hourOf` buckets
 * the takings chart by local hour, and the header beside this prints
 * `toLocaleDateString`. Handing the UTC date to `getDashboard` puts every number
 * on the screen a day behind the date written above them for the first 5h30m of
 * every day in IST.
 */
function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardScreen() {
  const api = useApi()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>('Owner')
  const showsMoney = SHOWS_MONEY[view]
  const now = useMemo(() => new Date(), [])
  const today = localIsoDate(now)

  /* The window lives in the URL, so a shared link opens on the same numbers.
     An unknown value falls back to today rather than erroring: a mangled query
     string must not be able to take the shop's dashboard down. */
  const rangeParam = params.get('range')
  const range: DashboardRange = isDashboardRange(rangeParam) ? rangeParam : 'today'

  const setRange = useCallback((next: DashboardRange) => {
    const p = new URLSearchParams(params)
    if (next === 'today') p.delete('range')
    else p.set('range', next)
    setParams(p, { replace: true })
  }, [params, setParams])

  const { data: store } = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['dashboard', today, range],
    queryFn: () => api.getDashboard(today, range),
    /*
     * Five minutes, against the app-wide default of ten seconds.
     *
     * The mock backend aggregates every invoice in IndexedDB — thirteen months of
     * them — which costs ~2s. Re-running that every time somebody comes back from
     * the billing screen is the difference between a dashboard and a wait. The
     * real server answers this with an indexed query and the window can shrink;
     * posting a sale already invalidates the key explicitly, so a stale total
     * never survives an actual change.
     */
    staleTime: 5 * 60_000,
    /* The previous window stays on screen while the next resolves. Dropping the
       whole page to a skeleton on a range click is what makes a fast screen feel
       slow, and the range switcher is the control people press most here. */
    placeholderData: (prev) => prev,
  })

  /*
   * Only the months that actually have trading behind them.
   *
   * A fixed twelve-month window pads the front with empty bars for a shop whose
   * history is shorter than that, and an empty bar reads as "we sold nothing"
   * rather than "we were not open".
   */
  const monthsWithData = (() => {
    const points = (data?.salesTrend ?? []).map((p) => ({
      key: p.label,
      label: p.label,
      /* Through decimal even though this only ever feeds a `> 0` presence test.
         Precision genuinely does not matter here — but summing money as floats
         is the pattern that put a wrong "chain total" on this same screen, and a
         rule with an exception in it is not a rule. */
      value: D.toNumber(D.sum(Object.values(p.values).map((v) => D.dec(v)))),
    }))
    const first = points.findIndex((p) => p.value > 0)
    return first === -1 ? points : points.slice(first)
  })()

  if (error) {
    return (
      <div className="p-[var(--page-px)]">
        <ErrorState code="DASHBOARD_FAILED" message={(error as Error).message} onRetry={() => void refetch()} />
      </div>
    )
  }

  /* The window the numbers ON SCREEN were read over, which is not the selected
     one for the moment between clicking a tab and its data landing — the previous
     window stays visible on purpose. Every label follows the data; only the tab
     highlight follows the click, because that is the control's own feedback. */
  const shownRange = data?.range ?? range
  const phrase = RANGE_PHRASE[shownRange]
  const shortCompare = shortenComparison(data?.comparedTo ?? 'yesterday')

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------------------------------ page header */}
      <header className="page-header shrink-0 px-[var(--page-px)] py-4">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-semibold tracking-display text-fg">
              {greeting(now.getHours())}, Akib Ahamed
            </h1>
            <p className="mt-1 truncate text-base text-fg-muted">
              {store?.name ?? '…'}
              {store?.city ? ` · ${store.city}` : ''} ·{' '}
              {now.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })}
              {' · '}
              <span className="text-fg-subtle">how the shop is trading {RANGE_SENTENCE[shownRange]}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <RangeTabs value={range} onChange={setRange} />
            <div
              role="tablist"
              aria-label="Dashboard view"
              className="flex rounded-[var(--radius-md)] border border-border bg-surface p-0.5 shadow-xs"
            >
              {VIEWS.map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors duration-[var(--dur-fast)]',
                    view === v ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  {v} view
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={() => navigate('/billing')}>
              {/* An opaque plate, not a 15% white wash. The wash lightened the
                  button underneath to 4.06:1 against its own white label — the
                  shortcut hint was the least readable thing on the primary
                  action. */}
              New sale <Kbd className="border-transparent bg-white text-accent-11">F2</Kbd>
            </Button>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------ body */}
      <div className="scroll-region min-h-0 flex-1">
        <div className="mx-auto flex max-w-[1560px] flex-col gap-[var(--card-gap)] px-[var(--page-px)] py-[var(--page-px)]">
          {isPending || !data ? (
            <div className="card p-[var(--card-px)]"><SkeletonRows rows={6} cols={6} /></div>
          ) : (
            <>
              <TakingsHero data={data} range={shownRange} salesHref={SALES_PRESET[shownRange]} />

              {/* ----------------------------------------------------- KPIs */}
              <section aria-labelledby="kpi-heading" className="mt-2 flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 id="kpi-heading" className="text-xl font-semibold tracking-tight text-fg">
                    Key figures
                  </h2>
                  {/* Said once, in full, so the tiles can say it in three words. */}
                  <span className="text-sm text-fg-muted">
                    {phrase}, vs {data.comparedTo}
                  </span>
                </div>
                {/* The Pharmacist view drops three tiles; a six-column grid would
                    leave half the row empty rather than letting the three that
                    remain take the space. */}
                <div className={cn(
                  'grid grid-cols-2 gap-[var(--card-gap)] md:grid-cols-3',
                  showsMoney ? 'xl:grid-cols-6' : 'xl:grid-cols-3',
                )}>
                  <StatTile label="Sales" icon={IndianRupee} symbol="₹"
                    value={compactINR(Number(data.kpis.sales.value))}
                    deltaPct={data.kpis.sales.deltaPct} riseIsGood comparedTo={shortCompare}
                    to={SALES_PRESET[shownRange]} linkLabel="Sales register" />
                  <StatTile label="Bills" icon={Receipt}
                    value={data.kpis.orders.value}
                    deltaPct={data.kpis.orders.deltaPct} riseIsGood comparedTo={shortCompare}
                    to={SALES_PRESET[shownRange]} linkLabel="Every bill" />
                  {showsMoney && (
                    <StatTile label="Profit" icon={TrendingUp} symbol="₹"
                      value={compactINR(Number(data.kpis.profit.value))}
                      deltaPct={data.kpis.profit.deltaPct} riseIsGood comparedTo={shortCompare}
                      to="/reports?r=BATCH_MARGIN" linkLabel="Margin by batch" />
                  )}
                  <StatTile label="Customers" icon={Users}
                    value={data.kpis.customers.value}
                    deltaPct={data.kpis.customers.deltaPct} riseIsGood comparedTo={shortCompare}
                    to="/customers" linkLabel="Customer book" />
                  {showsMoney && (
                    <StatTile label="Gross margin" icon={Percent}
                      value={`${data.kpis.grossMarginPct.value}%`}
                      deltaPct={data.kpis.grossMarginPct.deltaPct} riseIsGood comparedTo={shortCompare}
                      to="/reports?r=BATCH_MARGIN" linkLabel="How it was earned" />
                  )}
                  {/* riseIsGood is FALSE here: growing receivables is not good news,
                      and a tile that paints every rise green teaches people to ignore it. */}
                  {showsMoney && (
                    <StatTile label="Outstanding" icon={Wallet} symbol="₹" tone="danger"
                      value={compactINR(Number(data.kpis.overdue.value))}
                      deltaPct={data.kpis.overdue.deltaPct} riseIsGood={false} comparedTo={shortCompare}
                      to="/customers?view=owes" linkLabel="Who owes it" />
                  )}
                </div>
              </section>

              {/* ------------------------------------------------- attention */}
              <section aria-labelledby="attention-heading" className="mt-2 flex flex-col gap-3">
                <h2 id="attention-heading" className="text-xl font-semibold tracking-tight text-fg">
                  Needs attention
                </h2>
                <AttentionRow counts={data.attention} />
              </section>

              <section aria-labelledby="actions-heading" className="mt-2 flex flex-col gap-3">
                <h2 id="actions-heading" className="text-xl font-semibold tracking-tight text-fg">
                  Start something
                </h2>
                <QuickActions />
              </section>

              {/* --------------------------------------- branches and movers */}
              <section
                aria-label="Comparisons"
                className={cn(
                  'mt-2 grid gap-[var(--card-gap)]',
                  data.branches.length > 1 ? 'xl:grid-cols-2' : 'grid-cols-1',
                )}
              >
                {/* One shop is not a comparison, and a panel with a single row in
                    it would teach the reader that this screen shows filler. */}
                {data.branches.length > 1 ? (
                  <BranchPanel branches={data.branches} rangePhrase={phrase} showsCost={showsMoney} />
                ) : null}
                <MoversPanel movers={data.topMovers} comparedTo={data.comparedTo} />
              </section>

              {/* ----------------------------------------------------- mixes */}
              <div className="grid gap-[var(--card-gap)] xl:grid-cols-[1fr_1fr_1.4fr]">
                <Panel title={`Sales mix · ${phrase}`}>
                  <div className="p-[var(--card-px)]">
                    <Donut
                      ariaLabel="Share of revenue by drug schedule"
                      size={172}
                      centerLabel="Sales"
                      centerValue={`₹${compactINR(Number(data.kpis.sales.value))}`}
                      valueFormat={(n) => `₹${formatAmount(String(n))}`}
                      data={data.categoryMix.map((c) => ({ key: c.key, label: c.label, value: Number(c.value) }))}
                    />
                  </div>
                </Panel>

                <Panel title="Inventory health">
                  <div className="p-[var(--card-px)]">
                    {/* STATUS, not categories — the colours come from the reserved
                        status tokens and every segment is labelled in the legend. */}
                    <Donut
                      ariaLabel="Batches by stock status"
                      size={172}
                      centerLabel="Batches"
                      centerValue={String(data.inventoryHealth.totalBatches)}
                      valueFormat={(n) => `${n} batches`}
                      data={[
                        { key: 'healthy', label: 'Healthy', value: data.inventoryHealth.healthy, color: 'var(--success-9)' },
                        { key: 'low', label: 'Low stock', value: data.inventoryHealth.lowStock, color: 'var(--status-low-stock)' },
                        { key: 'near', label: 'Near expiry', value: data.inventoryHealth.nearExpiry, color: 'var(--status-expiry-180)' },
                        { key: 'expired', label: 'Expired', value: data.inventoryHealth.expired, color: 'var(--status-expired)' },
                      ]}
                    />
                  </div>
                </Panel>

                <Panel title={`Sales trend · last ${monthsWithData.length} months`}>
                  <div className="p-[var(--card-px)]">
                    {/*
                      ONE series, deliberately.

                      The data spans thirteen months, so every month belongs to exactly
                      one financial year — Oct-Mar to 2025-26, Apr-Sep to 2026-27. Drawn
                      as a grouped bar with an FY legend it LOOKS like a year-over-year
                      comparison, and a reader would try to compare bars that have
                      nothing to do with each other. It is a continuous timeline, so it
                      gets a timeline's form: one series, no legend, the title naming it.
                      It becomes a genuine YoY chart the day there are two years to compare.
                    */}
                    <BarChart
                      ariaLabel="Monthly sales over the last twelve months"
                      height={212}
                      color="accent"
                      valueFormat={(n) => `₹${compactINR(n)}`}
                      data={monthsWithData}
                    />
                  </div>
                </Panel>
              </div>

              {/* ---------------------------------------------------- panels */}
              <div className="grid gap-[var(--card-gap)] xl:grid-cols-2">
                <CapitalAtRisk
                  rows={data.expiring}
                  totalAtCost={data.inventoryHealth.valueAtRisk}
                  showsCost={showsMoney}
                />
                <LowStockPanel rows={data.lowStock} />
              </div>

              <div className="grid gap-[var(--card-gap)] xl:grid-cols-2">
                <TopMedicinesPanel rows={data.topMedicines} />
                <ActivityPanel rows={data.activity} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
