import { useState } from 'react'
import { ChartTooltip, DataTable, Swatch } from './BarChart'
import {
  VIZ_ALL_PAIRS_CAP,
  VIZ_MUTED,
  VIZ_SLOTS,
  arcPath,
  clamp,
  compactINR,
  polarToCartesian,
} from './chartUtils'

/**
 * Part-to-whole, at a glance.
 *
 * A donut is an ALL-PAIRS form — every segment is on screen at once and the
 * reader compares each against each — so it is capped at the four slots that
 * were validated for that: slot 5 is yellow at 2.17:1 on the white card and
 * only ships adjacent to a direct label. A fifth category folds into "Other"
 * in the muted grey rather than taking a hue it was never checked for.
 */

/**
 * CALLER CONTRACT: pass the data already sorted DESCENDING by value.
 *
 * Segments past the 4th fold into a grey "Other" by INPUT POSITION, not by
 * magnitude — folding by magnitude would make colour follow rank, and a series
 * that changes hue when the numbers move is worse than a fold. So an unsorted
 * caller can bury its two biggest categories in "Other". `computeDashboard`
 * sorts and folds its own tail before it gets here.
 */
export interface DonutDatum {
  key: string
  label: string
  value: number
  /** Overrides the slot. Status donuts pass their reserved status token here. */
  color?: string
}

const HOVER_GROW = 3
const GAP = 2

export function Donut({
  data,
  size = 168,
  thickness = 24,
  centerLabel,
  centerValue,
  valueFormat = compactINR,
  ariaLabel,
}: {
  data: DonutDatum[]
  size?: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
  valueFormat?: (n: number) => string
  ariaLabel: string
}) {
  const [hover, setHover] = useState<string | null>(null)

  const segments = foldSegments(data)
  const total = segments.reduce((sum, s) => sum + s.value, 0)

  const c = size / 2
  const rOuter = Math.max(8, size / 2 - HOVER_GROW - 1)
  const rInner = Math.max(0, rOuter - thickness)

  // Angles derived, never accumulated into a mutable cursor: the tooltip and
  // the arc must read the same numbers on every render.
  const shares = segments.map((s) => (total > 0 ? s.value / total : 0))
  const arcs = segments.map((s, i) => {
    const before = shares.slice(0, i).reduce((sum, v) => sum + v, 0)
    const start = before * 360
    const end = (before + (shares[i] ?? 0)) * 360
    return { ...s, share: shares[i] ?? 0, start, end, mid: (start + end) / 2 }
  })

  const hovered = arcs.find((a) => a.key === hover)
  const midPoint = hovered
    ? polarToCartesian(c, c, (rOuter + rInner) / 2, hovered.mid)
    : { x: c, y: c }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <div role="img" aria-label={ariaLabel} className="absolute inset-0">
            <svg width={size} height={size} aria-hidden focusable="false" className="block">
              {/* No <title> on the segments: this svg is aria-hidden, so it buys
                  nothing for a screen reader (the table below does that) and the
                  browser would pop its own chrome tooltip on top of the designed
                  one. */}
              {total > 0 ? (
                arcs.map((a) => {
                  const on = hover === a.key
                  const d = arcPath(
                    c,
                    c,
                    on ? rOuter + HOVER_GROW : rOuter,
                    rInner,
                    a.start,
                    a.end,
                  )
                  if (!d) return null
                  return (
                    <path
                      key={a.key}
                      d={d}
                      fill={a.color}
                      // The gap is a stroke, not a hole cut in the path: the
                      // ring has to stay one continuous shape or the eye reads
                      // five arcs instead of one whole.
                      stroke={arcs.length > 1 ? 'var(--bg-surface)' : 'none'}
                      strokeWidth={arcs.length > 1 ? GAP : 0}
                      pointerEvents="all"
                      onMouseEnter={() => setHover(a.key)}
                      onMouseLeave={() => setHover((k) => (k === a.key ? null : k))}
                    />
                  )
                })
              ) : (
                // Zero data and values that sum to zero take the same path: an
                // empty ring, never a division by zero and never a full circle
                // of the first colour.
                <circle
                  cx={c}
                  cy={c}
                  r={(rOuter + rInner) / 2}
                  fill="none"
                  stroke="var(--viz-grid)"
                  strokeWidth={thickness}
                />
              )}
            </svg>
          </div>

          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            {total > 0 ? (
              <>
                {centerValue ? (
                  <span className="tabular-nums-off max-w-full truncate text-xl font-semibold tracking-[-0.02em] text-fg">
                    {centerValue}
                  </span>
                ) : null}
                {centerLabel ? (
                  <span className="max-w-full truncate text-2xs text-fg-muted">{centerLabel}</span>
                ) : null}
              </>
            ) : (
              <span className="text-2xs text-fg-subtle">No data</span>
            )}
          </div>

          {hovered ? (
            <ChartTooltip
              leftPct={clamp((midPoint.x / size) * 100, 4, 96)}
              top={midPoint.y}
              label={hovered.label}
              swatch={hovered.color}
              value={`${valueFormat(hovered.value)} · ${formatShare(hovered.share)}`}
            />
          ) : null}
        </div>

        <ul className="min-w-[168px] flex-1 space-y-1">
          {arcs.map((a) => (
            <li
              key={a.key}
              className="flex items-center gap-2"
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover((k) => (k === a.key ? null : k))}
            >
              <Swatch color={a.color} />
              {/* The label is never truncated: with colour alone ruled out, the
                  word IS the identity. Values give way instead. */}
              <span className="shrink-0 text-2xs text-fg-muted">{a.label}</span>
              <span className="num min-w-0 flex-1 truncate text-right text-2xs text-fg">
                {valueFormat(a.value)}
              </span>
              <span className="num w-9 shrink-0 text-right text-2xs text-fg-subtle">{formatShare(a.share)}</span>
            </li>
          ))}
        </ul>
      </div>

      <DataTable
        caption={ariaLabel}
        columns={['Value', 'Share']}
        rows={arcs.map((a) => ({ label: a.label, cells: [valueFormat(a.value), formatShare(a.share)] }))}
      />
    </div>
  )
}

interface Segment {
  key: string
  label: string
  value: number
  color: string
}

/**
 * Assign slots by INPUT POSITION — colour follows the entity, so dropping a
 * category must not repaint the ones that remain. Only auto-coloured segments
 * consume a slot; a datum that brought its own colour (a status bucket) is
 * never folded away.
 *
 * The slot is claimed even when the value is zero, and that is the whole point:
 * counting only the segments that happen to be non-zero this period means a
 * quiet Tuesday for Card silently promotes UPI from slot 3 to slot 2, and the
 * same entity is a different colour on two screens side by side.
 */
function foldSegments(data: DonutDatum[]): Segment[] {
  const kept: Segment[] = []
  const overflow: DonutDatum[] = []
  let slot = 0

  for (const d of data) {
    const value = Number.isFinite(d.value) && d.value > 0 ? d.value : 0
    const mySlot = d.color ? -1 : slot++
    if (value === 0) continue
    if (d.color) {
      kept.push({ key: d.key, label: d.label, value, color: d.color })
    } else if (mySlot < VIZ_ALL_PAIRS_CAP) {
      kept.push({ key: d.key, label: d.label, value, color: VIZ_SLOTS[mySlot] ?? 'var(--viz-1)' })
    } else {
      overflow.push({ ...d, value })
    }
  }

  if (overflow.length > 0) {
    kept.push({
      key: '__other',
      label: overflow.length === 1 ? (overflow[0]?.label ?? 'Other') : `Other (${overflow.length})`,
      value: overflow.reduce((sum, d) => sum + d.value, 0),
      color: VIZ_MUTED,
    })
  }
  return kept
}

const SHARE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 })

function formatShare(share: number): string {
  return `${SHARE.format(Math.round(share * 1000) / 10)}%`
}
