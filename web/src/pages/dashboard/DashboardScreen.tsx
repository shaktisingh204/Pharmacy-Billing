import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Boxes, IndianRupee, Percent, Receipt, TrendingUp, Users, Wallet,
} from 'lucide-react'
import { useApi } from '@/api'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { ErrorState, SkeletonRows } from '@/components/states'
import { BarChart, Donut, GroupedBarChart, compactINR } from '@/components/charts'
import { formatAmount } from '@/lib/format'
import { cn } from '@/lib/cn'
import * as D from '@/domain/decimal'
import { StatTile } from './StatTile'
import { AttentionRow } from './AttentionRow'
import { QuickActions } from './QuickActions'
import { ActivityPanel, CapitalAtRisk, LowStockPanel, Panel, TopMedicinesPanel } from './panels'

/** Three people read this screen and want different halves of it. */
const VIEWS = ['Owner', 'Manager', 'Pharmacist'] as const
type View = (typeof VIEWS)[number]

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardScreen() {
  const api = useApi()
  const navigate = useNavigate()
  const [view, setView] = useState<View>('Owner')
  const now = useMemo(() => new Date(), [])
  const today = now.toISOString().slice(0, 10)

  const { data: store } = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['dashboard', today],
    queryFn: () => api.getDashboard(today),
  })

  if (error) {
    return (
      <div className="p-6">
        <ErrorState code="DASHBOARD_FAILED" message={(error as Error).message} onRetry={() => void refetch()} />
      </div>
    )
  }

  return (
    <div className="scroll-region h-full">
      <div className="mx-auto flex max-w-[1560px] flex-col gap-5 p-5">
        {/* ---------------------------------------------------------- header */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-fg">
              {greeting(now.getHours())}, Akib Ahamed
            </h1>
            <p className="mt-0.5 text-sm text-fg-muted">
              {store?.name ?? '…'} · {store?.city ?? ''} ·{' '}
              {now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Dashboard view" className="flex rounded-[var(--radius-md)] border border-border bg-surface p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-[var(--radius-sm)] px-2.5 py-1 text-sm transition-colors duration-[var(--dur-fast)]',
                    view === v ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {v} view
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={() => navigate('/billing')}>
              New sale <Kbd className="border-white/25 bg-white/15 text-white">F2</Kbd>
            </Button>
          </div>
        </header>

        <QuickActions />

        {isPending || !data ? (
          <div className="card p-4"><SkeletonRows rows={6} cols={6} /></div>
        ) : (
          <>
            {/* ------------------------------------------------------- KPIs */}
            <section aria-labelledby="today-heading" className="flex flex-col gap-2">
              <h2 id="today-heading" className="text-base font-medium text-fg">Today</h2>
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
                <StatTile label="Sales" icon={IndianRupee} symbol="₹"
                  value={compactINR(Number(data.kpis.sales.value))}
                  deltaPct={data.kpis.sales.deltaPct} riseIsGood comparedTo="yesterday" />
                <StatTile label="Bills" icon={Receipt}
                  value={data.kpis.orders.value}
                  deltaPct={data.kpis.orders.deltaPct} riseIsGood comparedTo="yesterday" />
                <StatTile label="Profit" icon={TrendingUp} symbol="₹"
                  value={compactINR(Number(data.kpis.profit.value))}
                  deltaPct={data.kpis.profit.deltaPct} riseIsGood comparedTo="yesterday" />
                <StatTile label="Customers" icon={Users}
                  value={data.kpis.customers.value}
                  deltaPct={data.kpis.customers.deltaPct} riseIsGood comparedTo="yesterday" />
                <StatTile label="Gross margin" icon={Percent}
                  value={`${data.kpis.grossMarginPct.value}%`}
                  deltaPct={data.kpis.grossMarginPct.deltaPct} riseIsGood comparedTo="yesterday" />
                {/* riseIsGood is FALSE here: growing receivables is not good news,
                    and a tile that paints every rise green teaches people to ignore it. */}
                <StatTile label="Outstanding" icon={Wallet} symbol="₹" tone="danger"
                  value={compactINR(Number(data.kpis.overdue.value))}
                  deltaPct={data.kpis.overdue.deltaPct} riseIsGood={false} comparedTo="yesterday"
                  footnote="owed to the shop" />
              </div>
            </section>

            {/* -------------------------------------------------- attention */}
            <section aria-labelledby="attention-heading" className="flex flex-col gap-2">
              <h2 id="attention-heading" className="text-base font-medium text-fg">Needs attention</h2>
              <AttentionRow counts={data.attention} />
            </section>

            {/* ----------------------------------------------------- charts */}
            <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr_1fr]">
              <Panel title="Takings today, by hour">
                <div className="p-3">
                  <BarChart
                    ariaLabel="Sales by hour of day"
                    height={200}
                    color="sequential"
                    valueFormat={(n) => `₹${compactINR(n)}`}
                    data={data.todayByHour.map((p) => ({
                      key: p.label,
                      label: p.label,
                      value: Number(p.values['sales'] ?? '0'),
                    }))}
                  />
                </div>
              </Panel>

              <Panel title="Sales mix by schedule">
                <div className="p-3">
                  <Donut
                    ariaLabel="Share of today's revenue by drug schedule"
                    size={168}
                    centerLabel="Today"
                    centerValue={`₹${compactINR(Number(data.kpis.sales.value))}`}
                    valueFormat={(n) => `₹${formatAmount(String(n))}`}
                    data={data.categoryMix.map((c) => ({ key: c.key, label: c.label, value: Number(c.value) }))}
                  />
                </div>
              </Panel>

              <Panel title="Inventory health">
                <div className="p-3">
                  {/* STATUS, not categories — the colours come from the reserved
                      status tokens and every segment is labelled in the legend. */}
                  <Donut
                    ariaLabel="Batches by stock status"
                    size={168}
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
            </div>

            <Panel title="Sales trend · last 12 months">
              <div className="p-3">
                <GroupedBarChart
                  ariaLabel="Monthly sales by financial year"
                  height={240}
                  series={data.salesTrendSeries}
                  valueFormat={(n) => `₹${compactINR(n)}`}
                  data={data.salesTrend.map((p) => ({
                    label: p.label,
                    values: Object.fromEntries(
                      Object.entries(p.values).map(([k, v]) => [k, Number(v)]),
                    ),
                  }))}
                />
              </div>
            </Panel>

            {/* ----------------------------------------------------- panels */}
            <div className="grid gap-3 xl:grid-cols-3">
              <CapitalAtRisk rows={data.expiring} totalAtCost={data.inventoryHealth.valueAtRisk} />
              <LowStockPanel rows={data.lowStock} />
              <ActivityPanel rows={data.activity} />
            </div>

            {view !== 'Pharmacist' && (
              <div className="grid gap-3 xl:grid-cols-2">
                <TopMedicinesPanel rows={data.topMedicines} />
                <Panel title="Stock value on hand" icon={Boxes}>
                  <div className="flex h-full flex-col justify-center gap-1 p-4">
                    <span className="text-sm text-fg-muted">Near-expiry exposure, at cost</span>
                    <span className="num text-3xl font-semibold text-fg">
                      {formatAmount(data.inventoryHealth.valueAtRisk)}
                    </span>
                    <span className="text-xs text-fg-subtle">
                      across {data.inventoryHealth.nearExpiry} of {data.inventoryHealth.totalBatches} batches ·{' '}
                      {D.toStr(
                        D.percentOf(
                          D.dec(100),
                          D.dec(
                            data.inventoryHealth.totalBatches === 0
                              ? '0'
                              : String((data.inventoryHealth.nearExpiry / data.inventoryHealth.totalBatches) * 100),
                          ),
                        ),
                        1,
                      )}
                      % of batches
                    </span>
                  </div>
                </Panel>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
