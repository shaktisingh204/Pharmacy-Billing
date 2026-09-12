import type { BatchRow, IsoDate, Money, Qty, StockMovement } from '@contract'
import * as D from '@/domain/decimal'
import { daysUntil } from '@/lib/format'

/**
 * The value logic behind the inventory screen's analytical views.
 *
 * Same split as `@/api/inventory`: every rule the valuation band, the ageing
 * board, the rack walk and the dead-stock list lean on is a pure function over
 * arrays here, so it is tested every run rather than only exercised by clicking.
 *
 * Nothing below does arithmetic on a money string by hand — `@/domain/decimal`
 * does the sums, and every figure leaves as a decimal STRING.
 */

const DECIMALISH = /^-?\d+(\.\d+)?$/

/** A decimal string, or null when the field is missing or not a number. Money
 *  that cannot be parsed is never silently read as zero: on a valuation screen
 *  "we do not know" and "nothing" are different answers. */
export function parse(v: string | null | undefined): D.Decimal | null {
  const s = (v ?? '').trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

// ------------------------------------------------------------------ basis ---

/**
 * What a shelf is worth depends entirely on why you are asking.
 *
 * Landed cost is the money actually sunk into the stock, and it is the only
 * basis a write-off, an insurance claim or a supplier return can be settled at.
 * Printed MRP is what the same shelf would fetch across the counter — bigger,
 * GST-inclusive, and not money the shop has. Every figure on this screen says
 * which of the two it is, because they differ by the whole margin.
 */
export type Basis = 'cost' | 'mrp'

export const BASIS_VALUES: readonly Basis[] = ['cost', 'mrp'] as const

export const BASIS_LABEL: Record<Basis, string> = {
  cost: 'Landed cost',
  mrp: 'Printed MRP',
}

/** For a column header or an inline "at ..." suffix. */
export const BASIS_SUFFIX: Record<Basis, string> = {
  cost: 'at landed cost',
  mrp: 'at printed MRP',
}

export const BASIS_NOTE: Record<Basis, string> = {
  cost: 'What a write-off, a claim or a supplier return is settled at.',
  mrp: 'A counter price, GST-inclusive — not money the shop is holding.',
}

export function valueOf(row: BatchRow, basis: Basis): Money {
  return basis === 'mrp' ? row.valueAtMrp : row.valueAtCost
}

export function totalValue(rows: readonly BatchRow[], basis: Basis): Money {
  return D.toStr(
    D.sum(rows.flatMap((r) => {
      const v = parse(valueOf(r, basis))
      return v === null ? [] : [v]
    })),
    2,
  )
}

export function totalUnits(rows: readonly BatchRow[]): Qty {
  return D.toStr(
    D.sum(rows.flatMap((r) => {
      const v = parse(r.batch.qtyOnHand)
      return v === null ? [] : [v]
    })),
    3,
  )
}

/** Still carries stock. An emptied batch stays on file for the ledger to point
 *  at, but it is history rather than inventory and must not be valued. */
export function holdsStock(qty: string): boolean {
  const v = parse(qty)
  return v !== null && D.gt(v, D.ZERO)
}

/**
 * Gross margin over the RETAIL price, which is how a distributor quotes it.
 * Null when MRP is zero or negative, because the ratio then means nothing.
 */
export function marginPct(atMrp: string, atCost: string): string | null {
  const mrp = parse(atMrp)
  const cost = parse(atCost)
  if (mrp === null || cost === null || D.isZero(mrp) || D.isNeg(mrp)) return null
  return D.toStr(D.mul(D.div(D.sub(mrp, cost), mrp), D.HUNDRED), 1)
}

/** A share of a total, as a percentage string. Null when the total is zero —
 *  "0% of nothing" reads as a real finding and is not one. */
export function sharePct(part: string, whole: string): string | null {
  const p = parse(part)
  const w = parse(whole)
  if (p === null || w === null || D.isZero(w) || D.isNeg(w)) return null
  return D.toStr(D.mul(D.div(p, w), D.HUNDRED), 1)
}

// ----------------------------------------------------------------- ageing ---

/**
 * What the ledger knows about one batch's life.
 *
 * `lastIssuedAt` is the one that answers "has this sold?" — a batch can have a
 * recent movement that only ever ADDED to it (a second goods receipt onto the
 * same lot) and still not have left the shelf since March.
 */
export interface BatchAge {
  batchId: number
  /** The oldest movement on file: when this stock arrived. */
  receivedAt: string | null
  /** The newest movement of any kind. */
  lastMovedAt: string | null
  /** The newest movement that REDUCED the batch. Selling is what moving means. */
  lastIssuedAt: string | null
  movements: number
}

export function readBatchAge(batchId: number, movements: readonly StockMovement[]): BatchAge {
  let receivedAt: string | null = null
  let lastMovedAt: string | null = null
  let lastIssuedAt: string | null = null
  let count = 0

  for (const m of movements) {
    if (m.batchId !== batchId) continue
    count += 1
    if (receivedAt === null || m.at < receivedAt) receivedAt = m.at
    if (lastMovedAt === null || m.at > lastMovedAt) lastMovedAt = m.at
    const delta = parse(m.qtyDelta)
    if (delta !== null && D.isNeg(delta) && (lastIssuedAt === null || m.at > lastIssuedAt)) {
      lastIssuedAt = m.at
    }
  }

  return { batchId, receivedAt, lastMovedAt, lastIssuedAt, movements: count }
}

/** Whole calendar days between a movement timestamp and today. Never negative:
 *  a movement stamped later today is zero days old, not minus one. */
export function daysSince(at: string | null, todayIso: IsoDate): number | null {
  if (at === null) return null
  const day = at.slice(0, 10)
  if (day === '') return null
  const n = -daysUntil(day, new Date(`${todayIso}T00:00:00`))
  return Number.isFinite(n) ? Math.max(0, n) : null
}

/**
 * How long the stock has SAT — days since anything last left this batch.
 *
 * A batch that has never issued ages from the day it arrived, which is the
 * honest reading: it has been sitting there the whole time.
 */
export function idleDays(age: BatchAge | undefined, todayIso: IsoDate): number | null {
  if (age === undefined) return null
  return daysSince(age.lastIssuedAt ?? age.receivedAt, todayIso)
}

/** Days on the shelf, from the first movement on file. */
export function shelfDays(age: BatchAge | undefined, todayIso: IsoDate): number | null {
  if (age === undefined) return null
  return daysSince(age.receivedAt, todayIso)
}

export interface AgeBand {
  key: string
  label: string
  /** Inclusive upper bound in idle days; Infinity for the open-ended band. */
  max: number
  /** Sequential ramp: ageing is a magnitude, not a set of categories. */
  tone: string
  note: string
}

/**
 * Bands, not windows. Unlike the expiry board — where "within 180 days" contains
 * "within 30" — these are disjoint, so they DO add up to the analysed shelf and
 * the board is safe to read as a distribution.
 */
export const AGE_BANDS: readonly AgeBand[] = [
  { key: 'a30', label: 'Under 30 days', max: 30, tone: 'var(--viz-seq-2)', note: 'Turning over' },
  { key: 'a60', label: '30 to 60 days', max: 60, tone: 'var(--viz-seq-3)', note: 'Normal for a slow line' },
  { key: 'a90', label: '60 to 90 days', max: 90, tone: 'var(--viz-seq-4)', note: 'Worth a look' },
  { key: 'a180', label: '90 to 180 days', max: 180, tone: 'var(--viz-seq-5)', note: 'Two quarters unsold' },
  { key: 'a181', label: 'Over 180 days', max: Number.POSITIVE_INFINITY, tone: 'var(--viz-seq-6)', note: 'Dead unless it is seasonal' },
] as const

export function bandOf(days: number | null): AgeBand | null {
  if (days === null) return null
  return AGE_BANDS.find((b) => days <= b.max) ?? null
}

export interface AgeBandSummary {
  band: AgeBand
  batches: number
  units: Qty
  value: Money
  /** Share of the aged value, as a percentage string. Null when nothing is aged. */
  sharePct: string | null
}

export interface AgeingSummary {
  bands: AgeBandSummary[]
  /** Batches the ledger could not place: no movement on file at all. */
  unknown: number
  agedBatches: number
  agedValue: Money
  agedUnits: Qty
  /** The longest anything here has sat, for the hero line. */
  oldestDays: number | null
}

export function summariseAgeing(
  rows: readonly BatchRow[],
  ages: ReadonlyMap<number, BatchAge>,
  basis: Basis,
  todayIso: IsoDate,
): AgeingSummary {
  const held = rows.filter((r) => holdsStock(r.batch.qtyOnHand))
  const byBand = new Map<string, BatchRow[]>()
  const aged: BatchRow[] = []
  let unknown = 0
  let oldestDays: number | null = null

  for (const row of held) {
    const days = idleDays(ages.get(row.batch.id), todayIso)
    const band = bandOf(days)
    if (band === null || days === null) {
      unknown += 1
      continue
    }
    aged.push(row)
    if (oldestDays === null || days > oldestDays) oldestDays = days
    const bucket = byBand.get(band.key)
    if (bucket) bucket.push(row)
    else byBand.set(band.key, [row])
  }

  const agedValue = totalValue(aged, basis)

  return {
    bands: AGE_BANDS.map((band) => {
      const inBand = byBand.get(band.key) ?? []
      const value = totalValue(inBand, basis)
      return {
        band,
        batches: inBand.length,
        units: totalUnits(inBand),
        value,
        sharePct: sharePct(value, agedValue),
      }
    }),
    unknown,
    agedBatches: aged.length,
    agedValue,
    agedUnits: totalUnits(aged),
    oldestDays,
  }
}

// ------------------------------------------------------------- dead stock ---

export const DEAD_DAY_OPTIONS: readonly number[] = [30, 60, 90, 180] as const

export interface DeadBatch {
  row: BatchRow
  /** Days since anything left this batch. */
  idle: number
  /** Days since it arrived, when the ledger reaches back that far. */
  shelf: number | null
  value: Money
}

export interface DeadStockSummary {
  rows: DeadBatch[]
  value: Money
  units: Qty
  /** Share of the analysed shelf that is dead, as a percentage string. */
  sharePct: string | null
  /** How much of the analysed shelf could be judged at all. */
  judged: number
  unknown: number
}

/**
 * Batches holding stock that nothing has left in `thresholdDays`.
 *
 * Quarantined stock is deliberately INCLUDED. It is not moving by definition,
 * and money set aside for a supplier return that never got sent is exactly what
 * this list exists to find.
 */
export function deadStock(
  rows: readonly BatchRow[],
  ages: ReadonlyMap<number, BatchAge>,
  basis: Basis,
  todayIso: IsoDate,
  thresholdDays: number,
): DeadStockSummary {
  const held = rows.filter((r) => holdsStock(r.batch.qtyOnHand))
  const dead: DeadBatch[] = []
  let unknown = 0

  for (const row of held) {
    const age = ages.get(row.batch.id)
    const idle = idleDays(age, todayIso)
    if (idle === null) {
      unknown += 1
      continue
    }
    if (idle < thresholdDays) continue
    dead.push({ row, idle, shelf: shelfDays(age, todayIso), value: valueOf(row, basis) })
  }

  // By money, not by age: the list exists to be acted on top-down, and a
  // hundred idle rupees is not the row to start with.
  dead.sort((a, b) => {
    const av = parse(a.value)
    const bv = parse(b.value)
    const byValue = av !== null && bv !== null ? D.cmp(bv, av) : 0
    return byValue || b.idle - a.idle || a.row.batch.id - b.row.batch.id
  })

  const deadRows = dead.map((d) => d.row)
  const value = totalValue(deadRows, basis)

  return {
    rows: dead,
    value,
    units: totalUnits(deadRows),
    sharePct: sharePct(value, totalValue(held, basis)),
    judged: held.length - unknown,
    unknown,
  }
}

// -------------------------------------------------------------- rack walk ---

export interface RackGroup {
  /** Null is the unracked pile, which is its own finding. */
  rack: string | null
  rows: BatchRow[]
  skus: number
  units: Qty
  value: Money
  expired: number
  /** Batches inside 30 days — what to pull on the walk. */
  urgent: number
  quarantined: number
}

/**
 * "A-10" must sort after "A-9", which a plain string compare gets backwards, and
 * a shelf walk read in the wrong order is a walk done twice.
 */
export function compareRack(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

const UNRACKED = '\u0000'

export function groupByRack(rows: readonly BatchRow[], basis: Basis): RackGroup[] {
  const held = rows.filter((r) => holdsStock(r.batch.qtyOnHand))
  const byRack = new Map<string, BatchRow[]>()

  for (const row of held) {
    const raw = row.medicine.rackLocation?.trim() ?? ''
    const key = raw === '' ? UNRACKED : raw
    const bucket = byRack.get(key)
    if (bucket) bucket.push(row)
    else byRack.set(key, [row])
  }

  const groups: RackGroup[] = [...byRack.entries()].map(([key, list]) => ({
    rack: key === UNRACKED ? null : key,
    // Within a rack, soonest expiry first: that is the order the shelf is
    // actually worked, and it puts what to pull at the top of every group.
    rows: [...list].sort((a, b) =>
      a.batch.expiryDate.localeCompare(b.batch.expiryDate) || a.batch.id - b.batch.id),
    skus: new Set(list.map((r) => r.medicine.id)).size,
    units: totalUnits(list),
    value: totalValue(list, basis),
    expired: list.filter((r) => r.bucket === 'expired').length,
    urgent: list.filter((r) => r.bucket === 'd30').length,
    quarantined: list.filter((r) => r.batch.isQuarantined).length,
  }))

  // Unracked last. It is a data gap rather than a shelf, and putting it first
  // would send somebody walking to a rack that does not exist.
  groups.sort((a, b) => {
    if (a.rack === null) return 1
    if (b.rack === null) return -1
    return compareRack(a.rack, b.rack)
  })
  return groups
}
