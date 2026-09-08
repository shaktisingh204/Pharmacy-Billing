/**
 * Money and quantity formatting.
 *
 * RULES (enforced by scripts/guardrails.sh):
 *  - Money crosses the wire as a STRING and is NEVER computed in the view layer.
 *    `.toFixed(` is banned in src/ — IEEE-754 rounds ties to even, while the
 *    statutory rule rounds 50 paise up. Arithmetic lives in src/domain only.
 *  - Formatters are constructed ONCE at module scope. Building an Intl formatter
 *    per cell is a measurable cost in a 200-row grid.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const INR_PLAIN = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const QTY = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

/**
 * Decimal strings arrive from the API; parse only at the display boundary.
 *
 * Note the empty-string guard: `Number('')` is 0, not NaN, so without it a
 * missing value renders as a confident "0". In a stock column that is the
 * difference between "none left" and "we do not know".
 */
function toNumber(v: string | number): number {
  if (typeof v === 'number') return v
  return v.trim() === '' ? Number.NaN : Number(v)
}

/** '₹12,34,567.89' — Indian grouping, always two decimals. */
export function formatMoney(v: string | number): string {
  const n = toNumber(v)
  return Number.isFinite(n) ? INR.format(n) : '—'
}

/** '12,34,567.89' — no symbol, for columns that carry the ₹ in the header. */
export function formatAmount(v: string | number): string {
  const n = toNumber(v)
  return Number.isFinite(n) ? INR_PLAIN.format(n) : '—'
}

export function formatQty(v: string | number): string {
  const n = toNumber(v)
  return Number.isFinite(n) ? QTY.format(n) : '—'
}

export function formatPercent(v: string | number): string {
  const n = toNumber(v)
  return Number.isFinite(n) ? `${QTY.format(n)}%` : '—'
}

/** Printed expiry is a month, not a day: 2027-11-30 renders as '11/27'. */
export function formatExpiry(isoDate: string): string {
  const [y, m] = isoDate.split('-')
  if (!y || !m) return '—'
  return `${m}/${y.slice(2)}`
}

export function daysUntil(isoDate: string, today: Date): number {
  const target = new Date(`${isoDate}T00:00:00`)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target.getTime() - base.getTime()) / 86_400_000)
}
