/**
 * A twelve-point trend for a stat tile. Deliberately mute: it is the second
 * thing read on the tile, never the first. No axes, no labels, no tooltip —
 * per the stat-tile contract the exact numbers live in the tile's value and in
 * whatever the tile links to.
 */

const STROKE = 2
const DOT = 2.5

export function Sparkline({
  points,
  width = 120,
  height = 28,
  ariaHidden = true,
}: {
  points: number[]
  width?: number
  height?: number
  ariaHidden?: boolean
}) {
  const clean = points.filter((p) => Number.isFinite(p))
  if (clean.length === 0) return null

  // Room for the stroke's half width and for the end dot, so neither clips.
  const pad = Math.max(STROKE / 2, DOT) + 0.5
  const lo = Math.min(...clean)
  const hi = Math.max(...clean)
  const span = hi - lo
  const innerW = Math.max(1, width - pad * 2)
  const innerH = Math.max(1, height - pad * 2)

  const xy = clean.map((p, i) => ({
    x: pad + (clean.length === 1 ? innerW / 2 : (i / (clean.length - 1)) * innerW),
    // A flat series sits on the mid-line rather than pinning to the floor,
    // which would read as a collapse to zero.
    y: pad + innerH - (span === 0 ? innerH / 2 : ((p - lo) / span) * innerH),
  }))

  const last = xy[xy.length - 1]
  const d = xy.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ')

  return (
    <svg
      width={width}
      height={height}
      aria-hidden={ariaHidden || undefined}
      focusable="false"
      className="block overflow-visible"
    >
      {/* The line is recessive by WEIGHT, not by being unreadable: --viz-muted
          is 1.3:1 on the white card — paler than the sequential step this
          module refuses to paint bars with — and at 2px it disappears. */}
      <path
        d={d}
        fill="none"
        stroke="var(--viz-1)"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last ? <circle cx={round(last.x)} cy={round(last.y)} r={DOT} fill="var(--viz-1)" /> : null}
    </svg>
  )
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
