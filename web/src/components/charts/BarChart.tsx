import { useId, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { clamp, compactINR, niceScale, seqStep } from './chartUtils'

/**
 * A single-series magnitude chart. One series, so there is NO legend — the card
 * title names it.
 *
 * The SVG deliberately carries no viewBox. One user unit is one CSS pixel, so
 * 11px axis text is 11px in a 320px card and in a 900px one, while the bands
 * are laid out in percentages and stretch. A viewBox would scale the type with
 * the plot, which is how hand-rolled charts end up with 7px labels on a till.
 */

export interface BarDatum {
  key: string
  label: string
  value: number
  /** A second tooltip line: a batch count, a supplier, a delta. */
  hint?: string
}

const ROUND = 4 // rounded data-end, outer edge only
const AXIS_W = 44 // px gutter for the value axis
const LABEL_H = 20
const LABEL_H_ROTATED = 44
const H_LABEL_W = 92 // px gutter for category names in horizontal mode
const H_AXIS_H = 18
/** Without a cap, two bars stretch to 300px each and read as a bar *chart*. */
const MAX_BAND = 112

export function BarChart({
  data,
  height = 200,
  valueFormat = compactINR,
  color = 'sequential',
  horizontal = false,
  ariaLabel,
}: {
  data: BarDatum[]
  height?: number
  valueFormat?: (n: number) => string
  color?: 'sequential' | 'accent'
  horizontal?: boolean
  ariaLabel: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  // React 19's useId returns «r0»-style ids: legal in the DOM, but not something
  // to hand to `url(#…)`. Strip to ASCII before it becomes a fragment reference.
  const clipId = `barclip${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  const peak = Math.max(0, ...data.map((d) => (Number.isFinite(d.value) ? d.value : 0)))
  const scale = niceScale(peak, horizontal ? 4 : height < 140 ? 3 : 5)
  const fills = barFills(data, color)

  const table = (
    <DataTable
      caption={ariaLabel}
      columns={['Value']}
      rows={data.map((d) => ({ label: d.label, cells: [valueFormat(d.value)] }))}
    />
  )

  if (data.length === 0) {
    return (
      <div>
        <div
          role="img"
          aria-label={ariaLabel}
          className="flex items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border-subtle text-2xs text-fg-subtle"
          style={{ height }}
        >
          No data
        </div>
      </div>
    )
  }

  if (horizontal) {
    const rowH = clamp((height - H_AXIS_H) / data.length, 16, 34)
    const plotH = Math.round(rowH * data.length)
    const hovered = data.find((d) => d.key === hover)

    return (
      <div>
        <div role="img" aria-label={ariaLabel} className="flex items-start gap-2">
          <div className="relative shrink-0" style={{ width: H_LABEL_W, height: plotH }}>
            {data.map((d, i) => (
              <span
                key={d.key}
                title={d.label}
                className="absolute right-0 block max-w-full -translate-y-1/2 truncate text-2xs text-fg-subtle"
                style={{ top: (i + 0.5) * rowH }}
              >
                {d.label}
              </span>
            ))}
          </div>

          <div className="relative min-w-0 flex-1">
            <svg width="100%" height={plotH} aria-hidden focusable="false" className="block">
              {/* Under the gridlines, so hovering a row never erases the scale. */}
              {hovered ? (
                <rect
                  x={0}
                  y={data.indexOf(hovered) * rowH}
                  width="100%"
                  height={rowH}
                  fill="var(--bg-hover)"
                />
              ) : null}

              {scale.ticks.map((t, i) => {
                const x = `${(t / scale.max) * 100}%`
                // A 1px line centred on 0% or 100% has half its width outside
                // the viewport and paints at half weight. The zero axis is the
                // one that suffers, so both ends step inside by half a pixel —
                // the vertical plot clamps its gridlines for the same reason.
                const nudge = i === 0 ? 0.5 : i === scale.ticks.length - 1 ? -0.5 : 0
                return (
                  <line
                    key={t}
                    x1={x}
                    x2={x}
                    y1={0}
                    y2={plotH}
                    transform={nudge === 0 ? undefined : `translate(${nudge} 0)`}
                    stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                )
              })}

              {data.map((d, i) => {
                const pct = barPct(d.value, scale.max)
                const on = hover === d.key
                const barH = Math.max(6, rowH * 0.56)
                const y = i * rowH + (rowH - barH) / 2
                if (pct <= 0) return null
                return (
                  <g key={d.key}>
                    <rect
                      x={0}
                      y={on ? y - 1 : y}
                      width={`${pct}%`}
                      height={on ? barH + 2 : barH}
                      rx={ROUND}
                      fill={fills[i] ?? 'var(--viz-1)'}
                    />
                    {/* Square off the baseline end: a bar rounded at BOTH ends
                        floats, and the eye stops reading it from zero. */}
                    {pct > 2 && (
                      <rect
                        x={0}
                        y={on ? y - 1 : y}
                        width={ROUND}
                        height={on ? barH + 2 : barH}
                        fill={fills[i] ?? 'var(--viz-1)'}
                      />
                    )}
                  </g>
                )
              })}

              {/* No <title> on the hit target: this svg is aria-hidden, so it
                  buys nothing for a screen reader (the table below does that)
                  and the browser would pop its own chrome tooltip on top of the
                  designed one. */}
              {data.map((d, i) => (
                <rect
                  key={d.key}
                  x={0}
                  y={i * rowH}
                  width="100%"
                  height={rowH}
                  fill="transparent"
                  pointerEvents="all"
                  onMouseEnter={() => setHover(d.key)}
                  onMouseLeave={() => setHover((k) => (k === d.key ? null : k))}
                />
              ))}
            </svg>

            <AxisTicks ticks={scale.ticks} max={scale.max} format={valueFormat} />

            {hovered ? (
              <ChartTooltip
                leftPct={clamp(barPct(hovered.value, scale.max), 6, 96)}
                top={(data.indexOf(hovered) + 0.5) * rowH}
                label={hovered.label}
                value={valueFormat(hovered.value)}
                hint={hovered.hint}
              />
            ) : null}
          </div>
        </div>
        {table}
      </div>
    )
  }

  const rotate = data.length > 6
  const labelH = rotate ? LABEL_H_ROTATED : LABEL_H
  const plotH = Math.max(48, height - labelH)
  const hovered = data.find((d) => d.key === hover)
  const hoveredIndex = hovered ? data.indexOf(hovered) : -1
  const band = 100 / data.length
  const barW = band * 0.62

  return (
    <div>
      <div role="img" aria-label={ariaLabel} className="flex items-start gap-1">
        <div className="relative shrink-0" style={{ width: AXIS_W, height: plotH }}>
          {scale.ticks.map((t) => (
            <span
              key={t}
              className="num absolute right-2 -translate-y-1/2 text-2xs text-fg-subtle"
              style={{ top: plotH - (t / scale.max) * plotH }}
            >
              {valueFormat(t)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ maxWidth: data.length * MAX_BAND }}>
          <svg width="100%" height={plotH} aria-hidden focusable="false" className="block">
            <defs>
              {/* Bars are drawn ROUND taller than their value and clipped at the
                  baseline. One clip beats two rects per bar, and it also stops
                  the hover lift and the surface gap bleeding below the axis. */}
              <clipPath id={clipId}>
                <rect x="0" y="0" width="100%" height={plotH} />
              </clipPath>
            </defs>

            {/* Under the gridlines, so hovering a column never erases the scale. */}
            {hoveredIndex >= 0 ? (
              <rect
                x={`${hoveredIndex * band}%`}
                y={0}
                width={`${band}%`}
                height={plotH}
                fill="var(--bg-hover)"
              />
            ) : null}

            {scale.ticks.map((t) => {
              const y = clamp(plotH - (t / scale.max) * plotH, 0.5, plotH - 0.5)
              return (
                <line
                  key={t}
                  x1={0}
                  x2="100%"
                  y1={y}
                  y2={y}
                  stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
              )
            })}

            <g clipPath={`url(#${clipId})`}>
              {data.map((d, i) => {
                const pct = barPct(d.value, scale.max)
                if (pct <= 0) return null
                const h = (pct / 100) * plotH
                const lift = hover === d.key ? 2 : 0
                return (
                  <rect
                    key={d.key}
                    x={`${i * band + (band - barW) / 2}%`}
                    y={plotH - h - lift}
                    width={`${barW}%`}
                    height={h + lift + ROUND}
                    rx={ROUND}
                    fill={fills[i] ?? 'var(--viz-1)'}
                  />
                )
              })}
            </g>

            {/* No <title>: see the horizontal branch — it would only duplicate
                the designed tooltip with a chrome one. */}
            {data.map((d, i) => (
              <rect
                key={d.key}
                x={`${i * band}%`}
                y={0}
                width={`${band}%`}
                height={plotH}
                fill="transparent"
                pointerEvents="all"
                onMouseEnter={() => setHover(d.key)}
                onMouseLeave={() => setHover((k) => (k === d.key ? null : k))}
              />
            ))}
          </svg>

          <CategoryLabels labels={data.map((d) => ({ key: d.key, label: d.label }))} rotate={rotate} />

          {hovered ? (
            <ChartTooltip
              leftPct={(hoveredIndex + 0.5) * band}
              top={plotH - (barPct(hovered.value, scale.max) / 100) * plotH}
              label={hovered.label}
              value={valueFormat(hovered.value)}
              hint={hovered.hint}
            />
          ) : null}
        </div>
      </div>
      {table}
    </div>
  )
}

function barFills(data: BarDatum[], color: 'sequential' | 'accent'): string[] {
  if (color === 'accent') return data.map(() => 'var(--viz-1)')
  // Rank, not position: a sequential ramp encodes MAGNITUDE, so the tallest bar
  // must be the darkest wherever it happens to sit along the axis.
  //
  // Compared, never subtracted, and a non-finite value sorts last: a comparator
  // that can return NaN leaves sort() unspecified, so ONE bad datum re-ranks
  // every other bar and the tallest one ends up painted the palest step.
  const magnitude = data.map((d) => (Number.isFinite(d.value) ? d.value : Number.NEGATIVE_INFINITY))
  const order = data
    .map((_, i) => i)
    .sort((a, b) => {
      const va = magnitude[a] ?? Number.NEGATIVE_INFINITY
      const vb = magnitude[b] ?? Number.NEGATIVE_INFINITY
      return vb < va ? -1 : vb > va ? 1 : 0
    })
  const fills = new Array<string>(data.length).fill('var(--viz-1)')
  order.forEach((di, rank) => {
    fills[di] = seqStep(rank, data.length)
  })
  return fills
}

function barPct(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0
  return Math.min(100, (value / max) * 100)
}

/* -------------------------------------------------------------------------
   Shared chart chrome. Internal to this folder — index.ts does not re-export
   these; GroupedBarChart imports them so the two charts cannot drift apart.
   ---------------------------------------------------------------------- */

/** Category names under the plot. Truncated, never overlapped. */
export function CategoryLabels({
  labels,
  rotate,
}: {
  labels: Array<{ key: string; label: string }>
  rotate: boolean
}) {
  if (rotate) {
    return (
      <div className="flex" style={{ height: LABEL_H_ROTATED }}>
        {labels.map((l) => (
          <div key={l.key} className="relative min-w-0 flex-1">
            <span
              title={l.label}
              className="absolute top-1.5 right-1/2 block max-w-[84px] origin-top-right truncate text-2xs text-fg-subtle"
              style={{ transform: 'rotate(-42deg)' }}
            >
              {l.label}
            </span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex" style={{ height: LABEL_H }}>
      {labels.map((l) => (
        <div key={l.key} className="min-w-0 flex-1 px-0.5">
          <span title={l.label} className="block truncate text-center text-2xs text-fg-subtle">
            {l.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Value-axis ticks under a horizontal plot, anchored so the ends stay inside. */
function AxisTicks({
  ticks,
  max,
  format,
}: {
  ticks: number[]
  max: number
  format: (n: number) => string
}) {
  return (
    <div className="relative" style={{ height: H_AXIS_H }}>
      {ticks.map((t, i) => {
        const pct = (t / max) * 100
        const shift = i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)'
        return (
          <span
            key={t}
            className="num absolute top-1 text-2xs text-fg-subtle"
            style={{ left: `${pct}%`, transform: shift }}
          >
            {format(t)}
          </span>
        )
      })}
    </div>
  )
}

/**
 * The hover layer ships by default. Text wears TEXT tokens; identity is carried
 * by a swatch beside it, never by colouring the words.
 */
export function ChartTooltip({
  leftPct,
  top,
  label,
  value,
  hint,
  swatch,
  series,
}: {
  leftPct: number
  top: number
  label: string
  value: string
  hint?: string
  swatch?: string
  series?: string
}) {
  // Both axes self-anchor, because a tooltip that leaves the card is worse than
  // no tooltip: horizontally it pins to whichever edge it is near, and a mark
  // with no headroom above it gets its tooltip underneath instead.
  const anchor = leftPct < 22 ? 'start' : leftPct > 78 ? 'end' : 'mid'
  const below = top < 46
  const style: CSSProperties = {
    top,
    transform:
      (anchor === 'mid' ? 'translateX(-50%) ' : '') +
      (below ? 'translateY(6px)' : 'translateY(calc(-100% - 6px))'),
    ...(anchor === 'end' ? { right: 0 } : { left: anchor === 'start' ? 0 : `${leftPct}%` }),
  }
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 max-w-[200px] rounded-[var(--radius-md)] border border-border bg-surface px-2 py-1 shadow-md"
      style={style}
    >
      <div className="truncate text-2xs text-fg-muted">{label}</div>
      <div className="flex items-center gap-1.5">
        {swatch ? <Swatch color={swatch} /> : null}
        {series ? <span className="truncate text-2xs text-fg-muted">{series}</span> : null}
        <span className="num text-sm font-medium text-fg">{value}</span>
      </div>
      {hint ? <div className="truncate text-2xs text-fg-subtle">{hint}</div> : null}
    </div>
  )
}

export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-[2px]"
      style={{ backgroundColor: color }}
    />
  )
}

/**
 * The table view, always present. `role="img"` makes its own subtree
 * presentational, so this lives OUTSIDE it or a screen reader gets nothing but
 * the label.
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string
  columns: string[]
  rows: Array<{ label: string; cells: ReactNode[] }>
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col"></th>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            {r.cells.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
