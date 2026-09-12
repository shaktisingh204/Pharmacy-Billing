/**
 * Chart maths. Pure — no React, no DOM — so every number a chart draws can be
 * tested without rendering one.
 *
 * There is no chart library in this app and there will not be one: bwip-js
 * already cost the entry chunk 1.17MB, and a bar is four numbers.
 */

/**
 * Categorical hues, assigned in FIXED SLOT ORDER and never cycled. Colour
 * follows the entity, never its rank: filtering a series out must not repaint
 * the survivors.
 */
export const VIZ_SLOTS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
] as const

/** One hue, light -> dark. Magnitude only; never a rainbow. */
export const VIZ_SEQ = [
  'var(--viz-seq-1)',
  'var(--viz-seq-2)',
  'var(--viz-seq-3)',
  'var(--viz-seq-4)',
  'var(--viz-seq-5)',
  'var(--viz-seq-6)',
] as const

/**
 * All-pairs forms (a donut: every segment is on screen at once) were validated
 * only for slots 1-4. Slot 5 is yellow at 2.17:1 on the white card and ships
 * in adjacent forms with direct labels, never in a ring.
 */
export const VIZ_ALL_PAIRS_CAP = 4

/** The "everything else" fill. Never a hue — an aggregate is not a category. */
export const VIZ_MUTED = 'var(--viz-muted)'

/** Bounds a value into a range. Pure, so it lives here and not in a component. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const

/**
 * A "nice" upper bound and tick set (1 / 2 / 2.5 / 5 x 10^n).
 *
 * An axis that ends at 4,873 with seven ragged ticks is the single most common
 * amateur tell; the reader is doing arithmetic the chart should have done.
 */
export function niceScale(max: number, ticks = 5): { max: number; ticks: number[] } {
  // No data must not invent fractional gridlines: 0..1 reads as "nothing yet",
  // where 0, 0.2, 0.4 reads as a real scale that happens to be empty.
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] }

  const target = Math.max(1, Math.round(ticks))
  const rough = max / target
  const exp = Math.floor(Math.log10(rough))
  const magnitude = 10 ** exp
  const normalised = rough / magnitude
  const mult = NICE_STEPS.find((s) => normalised <= s * (1 + 1e-9)) ?? 10
  const step = mult * magnitude

  // Integer space, because 0.1 * 3 is 0.30000000000000004 and that lands in an
  // axis label. `.toFixed` is banned, so scale -> round -> unscale instead.
  const decimals = Math.max(0, -exp + (mult === 2.5 ? 1 : 0))
  const scale = 10 ** decimals
  const stepScaled = Math.round(step * scale)
  const count = Math.max(1, Math.ceil(max / step - 1e-9))

  return {
    max: (count * stepScaled) / scale,
    ticks: Array.from({ length: count + 1 }, (_, i) => (i * stepScaled) / scale),
  }
}

// Formatters are built once at module scope: one per cell is measurable in a
// grid, and an axis re-renders on every hover.
const CI_0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0, useGrouping: false })
const CI_1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1, useGrouping: false })
const CI_2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, useGrouping: false })

const UNITS = [
  { limit: 1e3, div: 1, suffix: '' },
  { limit: 1e5, div: 1e3, suffix: 'K' },
  { limit: 1e7, div: 1e5, suffix: 'L' },
  { limit: Number.POSITIVE_INFINITY, div: 1e7, suffix: 'Cr' },
] as const

/** ~3 significant digits; the formatter trims the trailing zeros. */
function fractionDigits(scaled: number): 0 | 1 | 2 {
  if (scaled >= 100) return 0
  if (scaled >= 10) return 1
  return 2
}

function roundTo(v: number, digits: number): number {
  const s = 10 ** digits
  return Math.round(v * s) / s
}

/**
 * Indian-system compaction for axis ticks and stat values: 1.2K, 45.2K, 1.8L,
 * 2.05Cr.
 *
 * Lakh and crore, NOT million and billion. A pharmacist reading a day book
 * converts "1.2M" in their head every single time; they never convert "12L".
 */
export function compactINR(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)

  const found = UNITS.findIndex((u) => abs < u.limit)
  const index = found < 0 ? UNITS.length - 1 : found
  let unit = UNITS[index] ?? UNITS[0]
  let scaled = abs / unit.div

  // Round FIRST, then re-bucket. 99,999 rounds to 100.0K, and nobody in India
  // reads "100K" — that is one lakh. Rounding can only ever cross one boundary.
  const next = UNITS[index + 1]
  if (next && roundTo(scaled, fractionDigits(scaled)) * unit.div >= unit.limit) {
    unit = next
    scaled = abs / next.div
  }

  const digits = fractionDigits(scaled)
  const fmt = digits === 0 ? CI_0 : digits === 1 ? CI_1 : CI_2
  return `${sign}${fmt.format(scaled)}${unit.suffix}`
}

/**
 * 0 degrees is 12 o'clock and angles run clockwise, matching how a reader
 * describes a ring: "it starts at the top and goes round".
 */
export function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

/** Three decimals is sub-pixel at any size we draw, and keeps the DOM small. */
function n3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * An SVG donut-segment path, swept clockwise from `startAngle` to `endAngle`.
 * Pass `rInner = 0` for a pie slice.
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle
  if (!(rOuter > 0) || !(sweep > 0)) return ''
  const inner = Math.max(0, Math.min(rInner, rOuter))

  // A circle has no start and no end: at 360 degrees the two arc endpoints
  // coincide and the browser draws NOTHING. A single 100% segment is a real
  // case (one supplier, one payment mode), so it gets two half arcs — and the
  // hole is wound the other way so the default nonzero fill rule punches it out.
  if (sweep >= 360 - 1e-9) {
    const ring = (r: number, dir: 0 | 1) =>
      `M ${n3(cx)} ${n3(cy - r)}` +
      ` A ${n3(r)} ${n3(r)} 0 1 ${dir} ${n3(cx)} ${n3(cy + r)}` +
      ` A ${n3(r)} ${n3(r)} 0 1 ${dir} ${n3(cx)} ${n3(cy - r)} Z`
    return inner > 0 ? `${ring(rOuter, 1)} ${ring(inner, 0)}` : ring(rOuter, 1)
  }

  // The large-arc flag, not the sweep flag, is what breaks at 180 degrees: an
  // arc command only says "there is an ellipse through these two points", and
  // without this every segment past a half turn draws as its own complement.
  const large = sweep > 180 ? 1 : 0
  const o1 = polarToCartesian(cx, cy, rOuter, startAngle)
  const o2 = polarToCartesian(cx, cy, rOuter, endAngle)

  if (inner <= 0) {
    return (
      `M ${n3(cx)} ${n3(cy)} L ${n3(o1.x)} ${n3(o1.y)}` +
      ` A ${n3(rOuter)} ${n3(rOuter)} 0 ${large} 1 ${n3(o2.x)} ${n3(o2.y)} Z`
    )
  }

  const i2 = polarToCartesian(cx, cy, inner, endAngle)
  const i1 = polarToCartesian(cx, cy, inner, startAngle)
  return (
    `M ${n3(o1.x)} ${n3(o1.y)}` +
    ` A ${n3(rOuter)} ${n3(rOuter)} 0 ${large} 1 ${n3(o2.x)} ${n3(o2.y)}` +
    ` L ${n3(i2.x)} ${n3(i2.y)}` +
    ` A ${n3(inner)} ${n3(inner)} 0 ${large} 0 ${n3(i1.x)} ${n3(i1.y)} Z`
  )
}

/**
 * The palest step is skipped on purpose: --viz-seq-1 is 1.36:1 on the white
 * card, and a bar painted in it reads as an empty slot rather than a small
 * value. It belongs in a heatmap, where every cell is bounded by its
 * neighbours.
 */
const SEQ_FLOOR = 1

const SEQ_TOP = VIZ_SEQ.length - 1
const SEQ_DARKEST = VIZ_SEQ[5]

/** Map a rank (0 = largest) into the sequential ramp, so bigger is darker. */
export function seqStep(index: number, count: number): string {
  const total = Math.max(1, Math.floor(count))
  if (total === 1) return SEQ_DARKEST

  // Both ends clamp: callers pass a rank straight out of a sort, and a stale
  // index must recolour a bar, never blank it.
  const rank = Math.min(Math.max(Math.floor(index), 0), total - 1)
  const t = rank / (total - 1)
  const step = Math.round(SEQ_TOP - t * (SEQ_TOP - SEQ_FLOOR))
  return VIZ_SEQ[Math.min(Math.max(step, 0), SEQ_TOP)] ?? SEQ_DARKEST
}
