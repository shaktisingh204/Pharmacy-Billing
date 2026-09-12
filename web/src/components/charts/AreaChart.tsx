import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { ChartTooltip, DataTable } from './BarChart'
import { clamp, compactINR, niceScale } from './chartUtils'

/**
 * A single-series time chart with a crosshair.
 *
 * A bar chart answers "which of these is biggest". A day's takings is not that
 * question — it is a shape, and the reader wants the value AT a moment plus the
 * run-up to it. So this draws a line over a filled area and puts a crosshair
 * under the pointer, which is the only affordance that answers "what did we take
 * at 3 p.m." without making somebody count bars.
 *
 * Unlike BarChart this measures its own width rather than laying out in
 * percentages: a path needs real numbers, and a viewBox that stretched to fit
 * would scale the stroke and the type with the plot.
 */

const PAD = 3            // room for the crosshair dot's radius at either end
const AXIS_W = 48        // px gutter for the value axis
const LABEL_H = 20
const MAX_LABELS = 8
const DOT = 4

export interface AreaPoint {
  key: string
  label: string
  value: number
}

export function AreaChart({
  data,
  height = 240,
  valueFormat = compactINR,
  ariaLabel,
  /** A second tooltip line, e.g. the bill count behind the money. */
  hintFor,
}: {
  data: AreaPoint[]
  height?: number
  valueFormat?: (n: number) => string
  ariaLabel: string
  hintFor?: (p: AreaPoint, index: number) => string | undefined
}) {
  const plotRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)
  const gradId = `areagrad${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    const el = plotRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const plotH = Math.max(60, height - LABEL_H)
  const n = data.length
  const values = data.map((d) => (Number.isFinite(d.value) ? d.value : 0))
  const scale = niceScale(Math.max(0, ...values), 4)

  const innerW = Math.max(1, width - PAD * 2)
  const xAt = (i: number): number =>
    PAD + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yAt = (v: number): number =>
    plotH - (clamp(v, 0, scale.max) / scale.max) * plotH

  const pointFromClientX = useCallback((clientX: number): number | null => {
    const el = plotRef.current
    if (!el || n === 0) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return null
    const inner = Math.max(1, rect.width - PAD * 2)
    const t = (clientX - rect.left - PAD) / inner
    return clamp(Math.round(t * Math.max(1, n - 1)), 0, n - 1)
  }, [n])

  const onMove = (e: PointerEvent<HTMLDivElement>) => setActive(pointFromClientX(e.clientX))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return
    const current = active ?? 0
    const next =
      e.key === 'ArrowRight' ? Math.min(n - 1, current + 1)
        : e.key === 'ArrowLeft' ? Math.max(0, current - 1)
          : e.key === 'Home' ? 0
            : e.key === 'End' ? n - 1
              : e.key === 'Escape' ? -1
                : null
    if (next === null) return
    e.preventDefault()
    setActive(next < 0 ? null : next)
  }

  const table = (
    <DataTable
      caption={ariaLabel}
      columns={['Value']}
      rows={data.map((d) => ({ label: d.label, cells: [valueFormat(d.value)] }))}
    />
  )

  if (n === 0) {
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

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${r2(xAt(i))} ${r2(yAt(v))}`).join(' ')
  const area = width > 0
    ? `${line} L ${r2(xAt(n - 1))} ${r2(plotH)} L ${r2(xAt(0))} ${r2(plotH)} Z`
    : ''

  const hovered = active === null ? null : data[active]
  // Only a handful of category names fit; the rest are in the hidden table and
  // under the crosshair. Sampling keeps the first and last, which are the two a
  // reader uses to orient the axis — and drops the sampled one that would land
  // on top of the last, which is what a plain modulo does on any series whose
  // length is not a multiple of the step.
  const step = Math.max(1, Math.ceil(n / MAX_LABELS))
  const labelled = (i: number): boolean =>
    i === n - 1 || (i % step === 0 && n - 1 - i >= step)

  return (
    <div>
      <div className="flex items-start gap-1">
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

        <div
          ref={plotRef}
          role="img"
          aria-label={`${ariaLabel}. Use the left and right arrow keys to read each point.`}
          tabIndex={0}
          className="relative min-w-0 flex-1 rounded-[var(--radius-sm)]"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          <svg width="100%" height={plotH} aria-hidden focusable="false" className="block">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.20" />
                <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

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

            {width > 0 ? (
              <>
                <path d={area} fill={`url(#${gradId})`} />
                <path
                  d={line}
                  fill="none"
                  stroke="var(--viz-1)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* The crosshair, drawn ABOVE the line so the rule is readable
                    where it crosses it and BELOW nothing else. */}
                {active !== null ? (
                  <g>
                    <line
                      x1={r2(xAt(active))}
                      x2={r2(xAt(active))}
                      y1={0}
                      y2={plotH}
                      stroke="var(--border-strong)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      shapeRendering="crispEdges"
                    />
                    <circle
                      cx={r2(xAt(active))}
                      cy={r2(yAt(values[active] ?? 0))}
                      r={DOT}
                      fill="var(--viz-1)"
                      stroke="var(--bg-surface)"
                      strokeWidth={2}
                    />
                  </g>
                ) : null}
              </>
            ) : null}
          </svg>

          <div className="relative" style={{ height: LABEL_H }}>
            {data.map((d, i) =>
              labelled(i) ? (
                <span
                  key={d.key}
                  className="absolute top-1 -translate-x-1/2 text-2xs whitespace-nowrap text-fg-subtle"
                  style={{
                    left: `${(xAt(i) / Math.max(1, width)) * 100}%`,
                    // The end labels would hang outside the card; they anchor
                    // to the edge instead of to their own centre.
                    transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : undefined,
                  }}
                >
                  {d.label}
                </span>
              ) : null,
            )}
          </div>

          {hovered ? (
            <ChartTooltip
              leftPct={(xAt(active ?? 0) / Math.max(1, width)) * 100}
              top={yAt(values[active ?? 0] ?? 0)}
              label={hovered.label}
              value={valueFormat(hovered.value)}
              {...(hintFor?.(hovered, active ?? 0) ? { hint: hintFor(hovered, active ?? 0) as string } : {})}
            />
          ) : null}
        </div>
      </div>
      {table}
    </div>
  )
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
