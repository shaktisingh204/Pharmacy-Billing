import { useId, useState } from 'react'
import { CategoryLabels, ChartTooltip, DataTable, Swatch } from './BarChart'
import { VIZ_SLOTS, clamp, compactINR, niceScale } from './chartUtils'

/**
 * N series side by side, CATEGORICAL colour in fixed slot order.
 *
 * On series identity: the legend is mandatory and colour is never the only
 * channel — the hover tooltip names its series in text beside a swatch, and the
 * hidden table lists all of it. Drawing a direct label on each bar is not
 * attempted: three series across six groups is eighteen labels, and in a 320px
 * card they collide into noise, which is worse than the legend they were meant
 * to replace.
 */

const ROUND = 4
const AXIS_W = 44
const LABEL_H = 20
const LABEL_H_ROTATED = 44
const MAX_BAND = 132
/** 2px of surface between adjacent fills, painted as a stroke so the bar
    geometry stays exact at any container width. */
const GAP = 2

export function GroupedBarChart({
  data,
  series,
  height = 220,
  valueFormat = compactINR,
  ariaLabel,
}: {
  data: Array<{ label: string; values: Record<string, number> }>
  series: string[]
  height?: number
  valueFormat?: (n: number) => string
  ariaLabel: string
}) {
  // Loud, not lenient. The cap exists precisely to stop a sixth series quietly
  // recycling slot 1 and making two different things the same teal.
  if (series.length > VIZ_SLOTS.length) {
    throw new Error(
      `GroupedBarChart supports at most ${VIZ_SLOTS.length} series (given ${series.length}). ` +
        'Aggregate the tail into an "Other" series rather than cycling the palette.',
    )
  }

  const [hover, setHover] = useState<{ group: number; series: number } | null>(null)
  const clipId = `groupclip${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  const peak = Math.max(
    0,
    ...data.flatMap((g) => series.map((s) => num(g.values[s]))),
  )
  const scale = niceScale(peak, height < 160 ? 3 : 5)

  const table = (
    <DataTable
      caption={ariaLabel}
      columns={series}
      rows={data.map((g) => ({ label: g.label, cells: series.map((s) => valueFormat(num(g.values[s]))) }))}
    />
  )

  const legend = (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s, si) => (
        <li key={s} className="flex items-center gap-1.5">
          <Swatch color={VIZ_SLOTS[si] ?? 'var(--viz-1)'} />
          <span className="text-2xs text-fg-muted">{s}</span>
        </li>
      ))}
    </ul>
  )

  if (data.length === 0 || series.length === 0) {
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
        {series.length > 0 ? legend : null}
      </div>
    )
  }

  const rotate = data.length > 5
  const labelH = rotate ? LABEL_H_ROTATED : LABEL_H
  const plotH = Math.max(48, height - labelH)
  const band = 100 / data.length
  const groupW = band * 0.74
  const barW = groupW / series.length

  const hoveredGroup = hover ? data[hover.group] : undefined
  const hoveredSeries = hover ? series[hover.series] : undefined

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
              <clipPath id={clipId}>
                <rect x="0" y="0" width="100%" height={plotH} />
              </clipPath>
            </defs>

            {/* Under the gridlines, so hovering a group never erases the scale. */}
            {hover ? (
              <rect
                x={`${hover.group * band}%`}
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
              {data.map((g, gi) =>
                series.map((s, si) => {
                  const v = num(g.values[s])
                  if (v <= 0) return null
                  const h = (Math.min(1, v / scale.max) || 0) * plotH
                  const on = hover?.group === gi && hover.series === si
                  return (
                    <rect
                      key={`${gi}-${s}`}
                      x={`${gi * band + (band - groupW) / 2 + si * barW}%`}
                      y={plotH - h - (on ? 2 : 0)}
                      width={`${barW}%`}
                      height={h + (on ? 2 : 0) + ROUND}
                      rx={ROUND}
                      fill={VIZ_SLOTS[si] ?? 'var(--viz-1)'}
                      stroke="var(--bg-surface)"
                      strokeWidth={GAP}
                    />
                  )
                }),
              )}
            </g>

            {/* No <title> on the hit target: this svg is aria-hidden, so it is
                invisible to a screen reader (the table below is the accessible
                channel) and the browser would pop its own chrome tooltip on top
                of the designed one. */}
            {data.map((_, gi) =>
              series.map((s, si) => (
                <rect
                  key={`hit-${gi}-${s}`}
                  x={`${gi * band + (band - groupW) / 2 + si * barW}%`}
                  y={0}
                  width={`${barW}%`}
                  height={plotH}
                  fill="transparent"
                  pointerEvents="all"
                  onMouseEnter={() => setHover({ group: gi, series: si })}
                  onMouseLeave={() =>
                    setHover((h) => (h && h.group === gi && h.series === si ? null : h))
                  }
                />
              )),
            )}
          </svg>

          <CategoryLabels
            labels={data.map((g, gi) => ({ key: `${gi}-${g.label}`, label: g.label }))}
            rotate={rotate}
          />

          {hover && hoveredGroup && hoveredSeries !== undefined ? (
            <ChartTooltip
              leftPct={hover.group * band + (band - groupW) / 2 + (hover.series + 0.5) * barW}
              top={plotH - (Math.min(1, num(hoveredGroup.values[hoveredSeries]) / scale.max) || 0) * plotH}
              label={hoveredGroup.label}
              series={hoveredSeries}
              swatch={VIZ_SLOTS[hover.series] ?? 'var(--viz-1)'}
              value={valueFormat(num(hoveredGroup.values[hoveredSeries]))}
            />
          ) : null}
        </div>
      </div>
      {legend}
      {table}
    </div>
  )
}

function num(v: number | undefined): number {
  return Number.isFinite(v) ? (v as number) : 0
}
