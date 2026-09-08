/**
 * Fixed-point decimal on bigint. Scale 6.
 *
 * Money in this application is never a JS number. Two reasons, both of which
 * produce a wrong bill rather than a rounding curiosity:
 *
 *  1. 0.1 + 0.2 !== 0.3 in IEEE-754. Summing a hundred line amounts drifts.
 *  2. Rounding direction. The statutory rule for Indian tax is that 50 paise
 *     rounds UP (away from zero). `Math.round` rounds .5 up for positives but
 *     toward +Infinity for negatives, and `toFixed` uses the binary
 *     representation, so (1.005).toFixed(2) is "1.00". Postgres NUMERIC and
 *     Rust's rust_decimal both round half-away-from-zero, and this module
 *     matches them so the same fixture produces the same answer on all three.
 *
 * Scale 6 covers the deepest thing we store (cost_amt NUMERIC(14,6)) with room
 * for an intermediate before rounding back to 2 or 4.
 */

const SCALE = 6
const UNIT = 1_000_000n

export interface Decimal {
  readonly v: bigint
}

export const ZERO: Decimal = { v: 0n }
export const ONE: Decimal = { v: UNIT }
export const HUNDRED: Decimal = { v: 100n * UNIT }

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

export function dec(x: string | number | Decimal): Decimal {
  if (typeof x === 'object') return x
  const s = typeof x === 'number' ? String(x) : x.trim()
  if (!DECIMAL_RE.test(s)) throw new TypeError(`not a decimal: ${JSON.stringify(x)}`)

  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracRaw = dot === -1 ? '' : body.slice(dot + 1)

  // Truncate beyond scale rather than rounding: a caller that needs rounding
  // asks for it explicitly, and silently rounding an input hides bad data.
  const frac = fracRaw.slice(0, SCALE).padEnd(SCALE, '0')
  const v = BigInt(intPart) * UNIT + BigInt(frac)
  return { v: neg ? -v : v }
}

export const add = (a: Decimal, b: Decimal): Decimal => ({ v: a.v + b.v })
export const sub = (a: Decimal, b: Decimal): Decimal => ({ v: a.v - b.v })
export const neg = (a: Decimal): Decimal => ({ v: -a.v })
export const abs = (a: Decimal): Decimal => ({ v: a.v < 0n ? -a.v : a.v })

/** Half-away-from-zero at the working scale, so repeated mul does not drift. */
export function mul(a: Decimal, b: Decimal): Decimal {
  return { v: divRound(a.v * b.v, UNIT) }
}

export function div(a: Decimal, b: Decimal): Decimal {
  if (b.v === 0n) throw new RangeError('division by zero')
  return { v: divRound(a.v * UNIT, b.v) }
}

function divRound(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n
  const n = num < 0n ? -num : num
  const d = den < 0n ? -den : den
  const q = n / d
  const r = n % d
  // Half away from zero: 2*r >= d rounds up in magnitude.
  const rounded = r * 2n >= d ? q + 1n : q
  return negative ? -rounded : rounded
}

/** Truncate toward zero at `dp` places. Used by apportionment, which must never
 *  over-allocate before it distributes the remainder. */
export function trunc(a: Decimal, dp: number): Decimal {
  if (dp < 0 || dp > SCALE) throw new RangeError(`dp out of range: ${dp}`)
  const factor = 10n ** BigInt(SCALE - dp)
  if (factor === 1n) return a
  const q = a.v / factor // bigint division truncates toward zero
  return { v: q * factor }
}

/** Round to `dp` decimal places, half away from zero. */
export function round(a: Decimal, dp: number): Decimal {
  if (dp < 0 || dp > SCALE) throw new RangeError(`dp out of range: ${dp}`)
  const factor = 10n ** BigInt(SCALE - dp)
  if (factor === 1n) return a
  return { v: divRound(a.v, factor) * factor }
}

export const cmp = (a: Decimal, b: Decimal): number => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0)
export const eq = (a: Decimal, b: Decimal): boolean => a.v === b.v
export const lt = (a: Decimal, b: Decimal): boolean => a.v < b.v
export const lte = (a: Decimal, b: Decimal): boolean => a.v <= b.v
export const gt = (a: Decimal, b: Decimal): boolean => a.v > b.v
export const gte = (a: Decimal, b: Decimal): boolean => a.v >= b.v
export const isZero = (a: Decimal): boolean => a.v === 0n
export const isNeg = (a: Decimal): boolean => a.v < 0n

export const min = (a: Decimal, b: Decimal): Decimal => (a.v <= b.v ? a : b)
export const max = (a: Decimal, b: Decimal): Decimal => (a.v >= b.v ? a : b)

export function sum(xs: readonly Decimal[]): Decimal {
  let acc = 0n
  for (const x of xs) acc += x.v
  return { v: acc }
}

/** Serialise at a fixed number of places. This is what crosses the wire. */
export function toStr(a: Decimal, dp = 2): string {
  const r = round(a, dp)
  const negative = r.v < 0n
  const mag = negative ? -r.v : r.v
  const int = mag / UNIT
  const frac = (mag % UNIT).toString().padStart(SCALE, '0').slice(0, dp)
  const s = dp === 0 ? int.toString() : `${int}.${frac}`
  return negative && r.v !== 0n ? `-${s}` : s
}

/** ONLY for display and for feeding chart/Intl APIs. Never for arithmetic. */
export function toNumber(a: Decimal): number {
  return Number(a.v) / Number(UNIT)
}

/** Percent helper: pct(100, "5") -> 5. Rounds nothing; the caller decides. */
export function percentOf(base: Decimal, pct: Decimal): Decimal {
  return div(mul(base, pct), HUNDRED)
}
