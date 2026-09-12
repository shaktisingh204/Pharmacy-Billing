import { useMemo, useState } from 'react'
import { ChartColumnBig } from 'lucide-react'
import type { ReportResult } from '@contract'
import { BarChart, compactINR } from '@/components/charts'
import { formatAmount, formatQty } from '@/lib/format'
import { cn } from '@/lib/cn'
import { buildSeries, chartDimensions, chartMeasures, defaultAxes } from './chartData'
import type { ChartField } from './chartData'

/**
 * One chart, over the rows already on screen.
 *
 * A reports screen earns a chart only if the chart cannot disagree with the
 * table above it, so this reads `result.rows` — the filtered, faceted set the
 * footer totals — and nothing else. Change the filter and the bars change with
 * the grid, by construction.
 *
 * The two axes are controls rather than a fixed picture per report. "Sales by
 * company" and "sales by medicine" are the same rows indexed two ways, exactly
 * like the grouping control beside them, and building one chart per report would
 * be thirteen pictures to keep in step with thirteen column sets.
 *
 * Colour comes from the chart components, which own the validated palette. A
 * single-series magnitude chart uses the sequential ramp, so the tallest bar is
 * the darkest; nothing here invents a hue and there is no second axis.
 */
export function ReportChart({ result }: { result: ReportResult }) {
  const measures = useMemo(() => chartMeasures(result.columns), [result.columns])
  const dimensions = useMemo(
    () => chartDimensions(result.columns, result.rows),
    [result.columns, result.rows],
  )
  const fallback = useMemo(
    () => defaultAxes(result.reportId, result.columns, result.rows),
    [result.reportId, result.columns, result.rows],
  )

  /* The axes are keys, not objects, and they reset when the REPORT changes but
     not when its rows do: re-picking the default on every refetch would throw
     away the reader's choice each time the poll came back. */
  const [picked, setPicked] = useState<{ measure: string; dimension: string } | null>(null)
  const [lastReport, setLastReport] = useState(result.reportId)
  if (result.reportId !== lastReport) {
    setLastReport(result.reportId)
    setPicked(null)
  }

  const measure = measures.find((m) => m.key === picked?.measure) ?? fallback?.measure ?? null
  const dimension = dimensions.find((d) => d.key === picked?.dimension) ?? fallback?.dimension ?? null

  const series = useMemo(
    () => (measure && dimension ? buildSeries(result.rows, { measure, dimension }) : null),
    [result.rows, measure, dimension],
  )

  if (measure === null || dimension === null || series === null) {
    return (
      <section aria-label="Chart" className="card shrink-0 p-[var(--card-px)]">
        <Header />
        <p className="mt-2 text-xs text-fg-muted">
          Nothing here can be charted: this report has no totalled figure, or every row
          sits under one label.
        </p>
      </section>
    )
  }

  /* Only a money measure carries a rupee sign and two decimals. `chartMeasures`
     also admits COUNT columns — Bills, Returns, Cancelled, Lines are all
     totalled — and 12 bills printed as "₹12.00" is a figure the reader has to
     un-read before they can use it. */
  const exact = (v: string): string =>
    measure.kind === 'money' ? `₹${formatAmount(v)}` : formatQty(v)

  return (
    <section aria-label="Chart" className="card flex shrink-0 flex-col gap-3 p-[var(--card-px)]">
      <Header>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Picker
            label="Chart this figure"
            value={measure.key}
            options={measures}
            onChange={(key) => setPicked({ measure: key, dimension: dimension.key })}
          />
          <span className="text-2xs text-fg-subtle">by</span>
          <Picker
            label="Chart it by"
            value={dimension.key}
            options={dimensions}
            onChange={(key) => setPicked({ measure: measure.key, dimension: key })}
          />
        </div>
      </Header>

      {series.bars.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No positive {measure.label.replace(/ ₹$/, '')} to plot in this view.
        </p>
      ) : (
        <BarChart
          data={series.bars.map((b) => ({
            key: b.key,
            label: b.label,
            value: b.value,
            hint: `${exact(b.exact)} · ${b.hint}`,
          }))}
          horizontal={series.orientation === 'horizontal'}
          height={series.orientation === 'horizontal' ? Math.max(96, series.bars.length * 26 + 18) : 188}
          valueFormat={compactINR}
          ariaLabel={`${measure.label} by ${dimension.label}, ${result.title}`}
        />
      )}

      {/* What the picture leaves out, as a figure. A chart that silently drops
          the tail is how a reader concludes the top eight ARE the business. */}
      <p className="text-2xs leading-snug text-fg-subtle">
        {series.bars.length} of {series.groups}{' '}
        {series.grain === 'week'
          ? `week${series.groups === 1 ? '' : 's'}`
          : series.grain === 'day'
            ? `day${series.groups === 1 ? '' : 's'}`
            : `${series.groups === 1 ? 'value' : 'values'} on ${dimension.label.toLowerCase()}`}
        {series.omittedGroups > 0 ? (
          <> · the other {series.omittedGroups} total {exact(series.omitted)}</>
        ) : null}
        {series.unplottable > 0 ? (
          <> · {series.unplottable} zero or negative, which a magnitude bar cannot show</>
        ) : null}
        {' · '}total {exact(series.total)}
      </p>
    </section>
  )
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-fg">
        <ChartColumnBig size={15} className="text-fg-subtle" aria-hidden />
        Shape of this report
      </h2>
      {children}
    </header>
  )
}

function Picker({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: ChartField[]
  onChange: (key: string) => void
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-7 max-w-[152px] appearance-none rounded-[var(--radius-md)] border border-border bg-surface',
          'pl-2 pr-6 text-xs font-medium text-fg hover:border-border-strong',
        )}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-fg-subtle">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  )
}
