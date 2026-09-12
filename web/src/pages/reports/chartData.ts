import type { ReportCellKind, ReportColumn, ReportId, ReportRow } from '@contract'
import * as D from '@/domain/decimal'

/**
 * The chart is a VIEW OF THE ROWS, never a second query.
 *
 * Everything below aggregates exactly the rows the grid is showing — the same
 * filtered, faceted set the footer totals — so the bars and the table can never
 * tell two different stories. That is the whole design constraint: a chart that
 * reads its own data source is a report the reader cannot check, and this app's
 * position on two aggregations over one dataset is that they eventually
 * disagree.
 *
 * Pure: no React, no DOM, no colour. Colour belongs to the chart components,
 * which own the validated palette.
 */

export interface ChartField {
  key: string
  label: string
  kind: ReportCellKind
}

/** What can be measured: a column the report itself agreed to foot. If a column
 *  is not totalled — an average, a percentage — summing it here would produce a
 *  figure the footer deliberately refuses to print. */
const MEASURE_KINDS: ReadonlySet<ReportCellKind> = new Set<ReportCellKind>(['money', 'qty', 'count'])

/** What can name a bar. `pct` is in because a GST rate IS a category, and the
 *  rate-wise chart is the one this screen most needs. */
const DIMENSION_KINDS: ReadonlySet<ReportCellKind> = new Set<ReportCellKind>([
  'text', 'code', 'status', 'date', 'expiry', 'pct',
])

const EMPTY_BAND = '(not set)'

/** Bars past this stop being comparable and start being a texture. */
export const TOP_N = 8
/**
 * A month of days reads. A quarter of them does not — thirty-one labels in a
 * 350px panel is a smear, and ninety is a texture. Past this the series rolls
 * up to WEEKS rather than dropping two thirds of the period on the floor: a
 * quarter shown as thirteen weeks is the same money, legibly.
 */
export const DATE_WINDOW = 31

const field = (c: ReportColumn): ChartField => ({ key: c.key, label: c.label, kind: c.kind })

export function chartMeasures(columns: readonly ReportColumn[]): ChartField[] {
  return columns.filter((c) => c.total === true && MEASURE_KINDS.has(c.kind)).map(field)
}

export function chartDimensions(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
): ChartField[] {
  if (rows.length === 0) return []
  return columns
    .filter((c) => {
      if (!DIMENSION_KINDS.has(c.kind)) return false
      const seen = new Set<string>()
      for (const row of rows) {
        seen.add((row.cells[c.key] ?? '').trim())
        if (seen.size > 1) return true
      }
      return false
    })
    .map(field)
}

/**
 * What each report opens its chart on.
 *
 * Chosen per report rather than derived, because the useful first cut is a
 * judgement: a day book wants a daily trend, item sales wants the top sellers,
 * and the rate summary wants the rate split. Anything not listed falls back to
 * the first measure against the first dimension, which is never wrong, only
 * duller.
 */
/* Partial on purpose, and CONTROLLED_BALANCE is one of the absences: every row
   of a running-balance register is a step in one arithmetic chain, and a bar
   chart of steps is a picture of nothing. The register is its own visualisation. */
const DEFAULTS: Partial<Record<ReportId, { measure: string; dimension: string }>> = {
  DAY_BOOK: { measure: 'net', dimension: 'date' },
  SALES_BY_DAY: { measure: 'net', dimension: 'date' },
  ITEM_SALES: { measure: 'net', dimension: 'medicine' },
  BATCH_MARGIN: { measure: 'gp', dimension: 'medicine' },
  GST_RATE_SUMMARY: { measure: 'taxable', dimension: 'rate' },
  HSN_SUMMARY: { measure: 'taxable', dimension: 'hsn' },
  PURCHASE_REGISTER: { measure: 'net', dimension: 'supplier' },
  H1_REGISTER: { measure: 'qty', dimension: 'prescriber' },
  CUSTOMER_OUTSTANDING: { measure: 'balance', dimension: 'party' },
  SUPPLIER_OUTSTANDING: { measure: 'balance', dimension: 'party' },
  STOCK_VALUATION: { measure: 'atCost', dimension: 'medicine' },
  NEAR_EXPIRY: { measure: 'atCost', dimension: 'expMonth' },
  NON_MOVING: { measure: 'atCost', dimension: 'company' },
}

export interface ChartAxes {
  measure: ChartField
  dimension: ChartField
}

export function defaultAxes(
  reportId: ReportId,
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
): ChartAxes | null {
  const measures = chartMeasures(columns)
  const dimensions = chartDimensions(columns, rows)
  if (measures.length === 0 || dimensions.length === 0) return null

  const wanted = DEFAULTS[reportId]
  const measure = measures.find((m) => m.key === wanted?.measure) ?? measures[0]
  const dimension = dimensions.find((d) => d.key === wanted?.dimension) ?? dimensions[0]
  return measure && dimension ? { measure, dimension } : null
}

export interface ChartBar {
  key: string
  label: string
  value: number
  /** The exact decimal string, for the caption and the accessible table. */
  exact: string
  hint: string
}

export interface ChartSeries {
  bars: ChartBar[]
  /** Days, or weeks once a period is too long to label day by day. */
  grain: 'day' | 'week' | 'category'
  /** Time reads left to right; categories read top to bottom. */
  orientation: 'vertical' | 'horizontal'
  /** Distinct values on the dimension, before any capping. */
  groups: number
  /** Exact total of everything plotted plus everything left out. */
  total: string
  /** Exact total of what did NOT make the chart. '0.00' when nothing was cut. */
  omitted: string
  omittedGroups: number
  /** Rows whose value was zero or negative, which a magnitude bar cannot show. */
  unplottable: number
}

const DECIMALISH = /^-?\d+(\.\d+)?$/

function parse(v: string | null | undefined): D.Decimal | null {
  if (v === null || v === undefined) return null
  const s = v.trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

const digitsFor = (kind: ReportCellKind): number => (kind === 'qty' ? 3 : kind === 'count' ? 0 : 2)

/** '2026-09-02' → '2 Sep'. Fixed month names: the same range must read the same
 *  on the counter machine and on the owner's laptop. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  if (m === undefined || d === undefined) return iso
  return `${String(Number(d))} ${MONTHS[Number(m) - 1] ?? m}`
}

/** The Monday of the week a date falls in, in UTC — the same date must land in
 *  the same week on a machine in another zone. */
function weekStart(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(ms)) return iso
  const dow = (new Date(ms).getUTCDay() + 6) % 7
  return new Date(ms - dow * 86_400_000).toISOString().slice(0, 10)
}

/** A rate is a category here, and '5' beside '18' on an axis reads as a count
 *  of something. The unit belongs on the label. */
function bandLabel(key: string, kind: ReportCellKind): string {
  if (kind === 'date') return dateLabel(key)
  if (kind === 'pct' && key !== EMPTY_BAND) return `${key}%`
  return key
}

/**
 * Aggregate the rows on screen into bars.
 *
 * A date dimension keeps CHRONOLOGICAL order and shows the most recent window —
 * a trend re-sorted by magnitude is not a trend. Every other dimension is sorted
 * by the measure, biggest first, and the tail is reported as a figure rather
 * than folded into an "Other" bar: an aggregate bar in a magnitude ramp is a
 * category that does not exist, and the reader compares it against real ones.
 */
export function buildSeries(
  rows: readonly ReportRow[],
  axes: ChartAxes,
  limit = TOP_N,
): ChartSeries {
  const digits = digitsFor(axes.measure.kind)
  const isDate = axes.dimension.kind === 'date'

  const raw = rows.map((row) => (row.cells[axes.dimension.key] ?? '').trim())
  // Roll up to weeks only once the days would be unlabellable. The decision is
  // made on the DISTINCT dates present, not on the range asked for: a shop that
  // traded eight days inside a quarter still gets eight readable bars.
  const weekly = isDate && new Set(raw).size > DATE_WINDOW

  const sums = new Map<string, { value: D.Decimal; count: number }>()
  rows.forEach((row, i) => {
    const band = raw[i] ?? ''
    const key = band === '' ? EMPTY_BAND : weekly ? weekStart(band) : band
    const value = parse(row.cells[axes.measure.key]) ?? D.ZERO
    const acc = sums.get(key) ?? { value: D.ZERO, count: 0 }
    acc.value = D.add(acc.value, value)
    acc.count += 1
    sums.set(key, acc)
  })

  const all = [...sums.entries()].map(([key, acc]) => ({ key, ...acc }))
  const total = D.sum(all.map((a) => a.value))

  const ordered = isDate
    ? all.slice().sort((a, b) => a.key.localeCompare(b.key))
    : all.slice().sort((a, b) => D.cmp(b.value, a.value) || a.key.localeCompare(b.key))

  const cap = isDate ? DATE_WINDOW : limit
  // A trend is cut from the END: the last 31 days are the ones being asked
  // about. A ranking is cut from the tail, which is the smallest values.
  const kept = isDate ? ordered.slice(-cap) : ordered.slice(0, cap)
  const cut = ordered.filter((o) => !kept.includes(o))

  const plotted = kept.filter((k) => D.gt(k.value, D.ZERO))

  return {
    bars: plotted.map((k) => ({
      key: k.key,
      label: bandLabel(k.key, axes.dimension.kind),
      value: D.toNumber(k.value),
      exact: D.toStr(k.value, digits),
      // A weekly bar labelled with its Monday has to say so somewhere, or the
      // reader takes '12 Jun' for a day.
      hint: `${weekly ? `week of ${dateLabel(k.key)} · ` : ''}${k.count} row${k.count === 1 ? '' : 's'}`,
    })),
    grain: isDate ? (weekly ? 'week' : 'day') : 'category',
    orientation: isDate ? 'vertical' : 'horizontal',
    groups: all.length,
    total: D.toStr(total, digits),
    omitted: D.toStr(D.sum(cut.map((c) => c.value)), digits),
    omittedGroups: cut.length,
    unplottable: kept.length - plotted.length,
  }
}
