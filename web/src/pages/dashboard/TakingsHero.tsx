import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Receipt } from 'lucide-react'
import type { DashboardData, DashboardRange } from '@contract'
import * as D from '@/domain/decimal'
import { AreaChart, compactINR } from '@/components/charts'
import { formatMoney, formatQty } from '@/lib/format'
import { cn } from '@/lib/cn'
import { RANGE_PHRASE } from './RangeTabs'

/**
 * The one number this screen exists to show, and the shape behind it.
 *
 * The figure is rounded to the rupee. At 56px, paise are two characters of noise
 * on a number nobody reconciles from a dashboard — the exact amount is one click
 * away in the register, and it is printed in full on the tile below.
 *
 * Arithmetic here goes through src/domain/decimal for the same reason it does
 * everywhere else: the average bill is a division, and a float division of money
 * is how a rupee goes missing.
 */
export function TakingsHero({
  data,
  range,
  salesHref,
}: {
  data: DashboardData
  range: DashboardRange
  salesHref: string
}) {
  const sales = D.dec(data.kpis.sales.value)
  const orders = Number(data.kpis.orders.value)

  const wholeRupees = formatQty(D.toStr(D.round(sales, 0), 0))
  const averageBill = orders > 0 ? D.toStr(D.div(sales, D.dec(orders)), 2) : null

  const points = useMemo(
    () => data.periodTrend.map((p) => ({
      key: p.label,
      label: p.label,
      value: Number(p.values['sales'] ?? '0'),
    })),
    [data.periodTrend],
  )

  const peak = points.reduce<{ label: string; value: number } | null>(
    (best, p) => (best === null || p.value > best.value ? { label: p.label, value: p.value } : best),
    null,
  )

  const byHour = data.range === 'today'
  const n = data.kpis.sales.deltaPct === null ? null : Number(data.kpis.sales.deltaPct)
  const flat = n !== null && Math.abs(n) < 0.05
  const good = n === null || flat ? null : n > 0
  const DeltaIcon = n === null || flat ? Minus : n > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <section className="card overflow-hidden" aria-labelledby="takings-heading">
      <div className="grid lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------- figure */}
        <div className="flex flex-col justify-between gap-6 border-b border-border-subtle bg-subtle p-[var(--card-px)] lg:border-r lg:border-b-0">
          <div className="min-w-0">
            <h2 id="takings-heading" className="micro-label">
              Takings · {RANGE_PHRASE[range]}
            </h2>
            <div className="display-num mt-2 truncate text-5xl text-fg">
              <span className="text-[0.44em] font-medium text-fg-muted">₹</span>
              {wholeRupees}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-sm">
              <DeltaIcon
                size={15}
                aria-hidden
                className={cn('shrink-0', good === null ? 'text-fg-subtle' : good ? 'text-success-11' : 'text-danger-11')}
              />
              <span className={good === null ? 'text-fg-subtle' : good ? 'text-success-11' : 'text-danger-11'}>
                {n === null ? 'No prior period' : flat ? 'No change' : `${n > 0 ? '+' : ''}${data.kpis.sales.deltaPct}%`}
              </span>
              <span className="truncate text-fg-subtle">vs {data.comparedTo}</span>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="Bills" value={formatQty(data.kpis.orders.value)} />
            <Fact label="Average bill" value={averageBill === null ? '—' : formatMoney(averageBill)} />
            <Fact
              label={byHour ? 'Busiest hour' : 'Best day'}
              value={peak === null || peak.value <= 0 ? '—' : peak.label}
            />
            <Fact label="Customers" value={formatQty(data.kpis.customers.value)} />
          </dl>

          <Link
            to={salesHref}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-11 hover:text-accent-10"
          >
            <Receipt size={15} aria-hidden />
            Open the register
            <ArrowRight size={14} aria-hidden />
          </Link>
        </div>

        {/* ----------------------------------------------------------- chart */}
        <div className="min-w-0 p-[var(--card-px)]">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-medium text-fg">
              {byHour ? 'Takings by hour' : 'Takings by day'}
            </span>
            <span className="text-xs text-fg-subtle">
              {peak === null || peak.value <= 0
                ? 'Nothing rung up yet'
                : `Peak ${peak.label} · ₹${compactINR(peak.value)}`}
            </span>
          </div>
          <AreaChart
            ariaLabel={byHour ? 'Takings by hour of day' : 'Takings by day over the selected period'}
            data={points}
            height={232}
            valueFormat={(v) => `₹${compactINR(v)}`}
          />
        </div>
      </div>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label truncate">{label}</dt>
      <dd className="num mt-0.5 truncate text-left text-lg font-medium text-fg">{value}</dd>
    </div>
  )
}
