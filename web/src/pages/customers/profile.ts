import type { DrugSchedule, IsoDate, Money, Qty, SaleInvoice } from '@contract'
import type { CustomerRow } from '@/api/customers'
import { money } from '@/api/customers'
import * as D from '@/domain/decimal'
import { daysUntil } from '@/lib/format'

/**
 * What a customer actually BUYS, as pure value logic.
 *
 * The receivable in `api/customers` answers "what do they owe". This answers the
 * other half of the counter conversation: what do they take, how often, and when
 * are they next going to walk in for it. In an Indian retail pharmacy that is
 * not a marketing question — a metformin or a thyroxine customer refills on a
 * fixed monthly cycle, and the shop that knows the date keeps the customer,
 * orders the stock before the strip runs out, and phones the ones who lapsed.
 *
 * THREE RULES, each of them a wrong answer if it goes the other way:
 *
 *  1. A CYCLE IS OBSERVED, NEVER ASSUMED. Two purchases are not a rhythm; the
 *     gap between them is a single number and predicting off it is guessing.
 *     Three separate purchase DATES is the floor, the cycle is the MEDIAN gap
 *     (one holiday-delayed refill must not move the date), and how tight the
 *     gaps are is reported alongside it rather than hidden. A prediction the
 *     shop cannot see the basis of is one they will stop trusting the first time
 *     it is wrong.
 *  2. A VOIDED BILL WAS NEVER DISPENSED. It is excluded from every count, every
 *     quantity and every cycle here, the same way `receivableOf` skips it — a
 *     cancelled bill that still votes on a refill date invents a visit that did
 *     not happen.
 *  3. QUANTITY IS WHAT LEFT THE SHELF. `allocatedQty`, not `requestedQty`: a
 *     short-supplied line is not a month's course, and counting the request
 *     would push the next refill date later than the customer's strip runs out.
 *
 * Everything here is a fold over the bill window the screen already holds, so
 * opening an account costs no round trip — the same choice the receivable makes.
 */

// -------------------------------------------------------------- calendar ---

/** Local-calendar day number. Deliberately not `ms / 86_400_000`: that is a
 *  UTC-offset division and lands on the wrong day either side of the date line. */
function dayIndex(iso: IsoDate): number | null {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

export function toIsoDate(d: Date): IsoDate {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Null rather than a fabricated date when the input will not parse. */
export function addDays(iso: IsoDate, days: number): IsoDate | null {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  d.setDate(d.getDate() + days)
  return toIsoDate(d)
}

export function daysBetween(from: IsoDate, to: IsoDate): number | null {
  const a = dayIndex(from)
  const b = dayIndex(to)
  return a === null || b === null ? null : b - a
}

/** The middle value, not the mean: one delayed refill must not move the cycle. */
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const hi = s[mid]
  if (hi === undefined) return null
  if (s.length % 2 === 1) return hi
  const lo = s[mid - 1]
  return lo === undefined ? hi : (lo + hi) / 2
}

// ----------------------------------------------------------------- cycle ---

/**
 * Below ten days is a course being topped up, not a repeat; above a hundred and
 * twenty there is no rhythm a shop can act on, only a coincidence of two visits
 * a season apart. Both ends are judgement, and both are stated on screen.
 */
const MIN_CYCLE_DAYS = 10
const MAX_CYCLE_DAYS = 120
/** Three dates give two gaps — the fewest that can disagree with each other. */
const MIN_BUYS_FOR_CYCLE = 3
/** Median absolute deviation over the median. Under this the gaps agree. */
const STEADY_SPREAD = 0.3

/** A monthly-ish refill. This, and only this, is what makes an account chronic. */
const CHRONIC_MIN_DAYS = 14
const CHRONIC_MAX_DAYS = 60

/** Four months without a visit. A regular comes monthly; this one has gone. */
export const DORMANT_DAYS = 120

export interface Cycle {
  /** Whole days between refills, the median of the observed gaps. */
  days: number
  /** True when the gaps agree closely. False means "roughly, on this evidence". */
  steady: boolean
  /** Gaps behind the number, so the screen can show the basis. */
  samples: number
}

/** Null when the dates cannot support a prediction. `dates` need not be sorted. */
export function cycleOf(dates: readonly IsoDate[]): Cycle | null {
  const unique = [...new Set(dates)]
    .map(dayIndex)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
  if (unique.length < MIN_BUYS_FOR_CYCLE) return null

  const gaps: number[] = []
  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1]
    const cur = unique[i]
    if (prev === undefined || cur === undefined) continue
    gaps.push(cur - prev)
  }
  const mid = median(gaps)
  if (mid === null) return null

  const days = Math.round(mid)
  if (days < MIN_CYCLE_DAYS || days > MAX_CYCLE_DAYS) return null

  const spread = median(gaps.map((g) => Math.abs(g - mid))) ?? 0
  // Two days of slack regardless: a monthly refill collected on a Sunday rather
  // than the Friday is the same rhythm, and a proportional test alone calls a
  // short cycle erratic for a variation nobody would notice.
  return { days, steady: spread <= Math.max(2, mid * STEADY_SPREAD), samples: gaps.length }
}

// ------------------------------------------------------------------ items ---

export interface ItemHistory {
  medicineId: number
  brandName: string
  packLabel: string
  schedule: DrugSchedule
  /** Separate DATES it was bought on, not lines: two strips on one bill is one buy. */
  times: number
  qty: Qty
  spend: Money
  firstBought: IsoDate
  lastBought: IsoDate
  /** Whole days since the last purchase. Null when the date will not parse. */
  daysSince: number | null
  cycle: Cycle | null
  /** `lastBought` + the cycle. Null whenever there is no cycle to project. */
  dueOn: IsoDate | null
  /** Negative is overdue. Null without a cycle. */
  dueInDays: number | null
}

interface ItemAccumulator {
  medicineId: number
  brandName: string
  packLabel: string
  schedule: DrugSchedule
  dates: string[]
  qty: D.Decimal
  spend: D.Decimal
}

export type Segment = 'chronic' | 'occasional' | 'dormant' | 'none'

export const SEGMENT_LABEL: Record<Segment, string> = {
  chronic: 'Chronic',
  occasional: 'Occasional',
  dormant: 'Dormant',
  none: 'No bills loaded',
}

/** Spelled out wherever the chip is drawn: the word carries it, never the tint. */
export const SEGMENT_MEANING: Record<Segment, string> = {
  chronic: 'Refills at least one medicine on a monthly cycle',
  occasional: 'Buys, but on no regular cycle',
  dormant: `Nothing bought in ${DORMANT_DAYS} days`,
  none: 'No bill for this account is in the loaded window',
}

export interface Prescriber {
  name: string
  times: number
  last: IsoDate
}

export interface PurchaseProfile {
  /** POSTED bills in the loaded window. */
  bills: number
  voided: number
  /** Every medicine ever dispensed, most-repeated first. */
  items: ItemHistory[]
  /** Only the ones with a projected next refill, soonest first. */
  refills: ItemHistory[]
  units: Qty
  spend: Money
  average: Money | null
  first: IsoDate | null
  last: IsoDate | null
  daysSince: number | null
  /** Median days between VISITS, whatever was bought. Null under three visits. */
  visitCycle: Cycle | null
  prescribers: Prescriber[]
  segment: Segment
}

const EMPTY_PROFILE: PurchaseProfile = {
  bills: 0,
  voided: 0,
  items: [],
  refills: [],
  units: '0',
  spend: '0.00',
  average: null,
  first: null,
  last: null,
  daysSince: null,
  visitCycle: null,
  prescribers: [],
  segment: 'none',
}

/**
 * One account's buying history, folded out of its bills.
 *
 * `bills` arrive newest-first from `buildRows`, so the first line seen for a
 * medicine carries the most recent brand and pack label — which is the one to
 * show, because a pack size changes and the old label would misdescribe what is
 * actually being refilled.
 */
export function profileOf(bills: readonly SaleInvoice[], today: Date): PurchaseProfile {
  if (bills.length === 0) return EMPTY_PROFILE

  const byMedicine = new Map<number, ItemAccumulator>()
  const byPrescriber = new Map<string, Prescriber>()
  const visitDates = new Set<string>()
  let posted = 0
  let voided = 0
  let spend = D.ZERO
  let units = D.ZERO
  let first: IsoDate | null = null
  let last: IsoDate | null = null

  for (const inv of bills) {
    // Rule 2: a cancelled bill was never dispensed. It is counted, and nothing
    // more — it must not vote on a cycle, a favourite or a quantity.
    if (inv.status !== 'POSTED') { voided += 1; continue }
    posted += 1
    visitDates.add(inv.invoiceDate)
    if (first === null || inv.invoiceDate < first) first = inv.invoiceDate
    if (last === null || inv.invoiceDate > last) last = inv.invoiceDate

    const net = money(inv.quote.netAmount)
    if (net) spend = D.add(spend, net)

    const prescriber = inv.prescription?.prescriberName.trim()
    if (prescriber) {
      const seen = byPrescriber.get(prescriber)
      if (seen) {
        seen.times += 1
        if (inv.invoiceDate > seen.last) seen.last = inv.invoiceDate
      } else {
        byPrescriber.set(prescriber, { name: prescriber, times: 1, last: inv.invoiceDate })
      }
    }

    for (const line of inv.quote.lines) {
      const qty = money(line.allocatedQty)
      if (qty) units = D.add(units, qty)
      const amount = money(line.lineTotal)

      const seen = byMedicine.get(line.medicineId)
      if (seen) {
        seen.dates.push(inv.invoiceDate)
        if (qty) seen.qty = D.add(seen.qty, qty)
        if (amount) seen.spend = D.add(seen.spend, amount)
        continue
      }
      byMedicine.set(line.medicineId, {
        medicineId: line.medicineId,
        brandName: line.brandName,
        packLabel: line.packLabel,
        schedule: line.drugSchedule,
        dates: [inv.invoiceDate],
        qty: qty ?? D.ZERO,
        spend: amount ?? D.ZERO,
      })
    }
  }

  const items: ItemHistory[] = []
  for (const acc of byMedicine.values()) {
    const sorted = [...new Set(acc.dates)].sort()
    const firstBought = sorted[0]
    const lastBought = sorted[sorted.length - 1]
    if (firstBought === undefined || lastBought === undefined) continue

    const cycle = cycleOf(acc.dates)
    const dueOn = cycle ? addDays(lastBought, cycle.days) : null
    const dueInDays = dueOn ? daysUntil(dueOn, today) : null

    items.push({
      medicineId: acc.medicineId,
      brandName: acc.brandName,
      packLabel: acc.packLabel,
      schedule: acc.schedule,
      times: sorted.length,
      qty: D.toStr(acc.qty, 3),
      spend: D.toStr(acc.spend, 2),
      firstBought,
      lastBought,
      daysSince: daysBetween(lastBought, toIsoDate(today)),
      cycle,
      dueOn,
      dueInDays: dueInDays !== null && Number.isFinite(dueInDays) ? dueInDays : null,
    })
  }

  /* Repeats first, then money. "Bought eleven times" is what a refill list is
     built on; spend only breaks the tie, because one expensive one-off is not a
     favourite medicine. */
  items.sort((a, b) => b.times - a.times || D.cmp(D.dec(b.spend), D.dec(a.spend)) || a.brandName.localeCompare(b.brandName))

  const refills = items
    .filter((i) => i.dueOn !== null && i.dueInDays !== null)
    .sort((a, b) => (a.dueInDays ?? 0) - (b.dueInDays ?? 0))

  const daysSince = last === null ? null : daysBetween(last, toIsoDate(today))
  const average = posted > 0 ? D.toStr(D.div(spend, D.dec(posted)), 2) : null

  return {
    bills: posted,
    voided,
    items,
    refills,
    units: D.toStr(units, 3),
    spend: D.toStr(spend, 2),
    average,
    first,
    last,
    daysSince,
    visitCycle: cycleOf([...visitDates]),
    prescribers: [...byPrescriber.values()].sort((a, b) => b.times - a.times || a.name.localeCompare(b.name)),
    segment: segmentFrom(posted, daysSince, items),
  }
}

/**
 * Which of four the account is, in one word.
 *
 * DORMANT OUTRANKS CHRONIC deliberately. A diabetic who has not collected in
 * four months is the single most valuable name on this screen — they have gone
 * somewhere else and they are still on the medicine — and filing them under
 * "chronic" hides them among the customers who are turning up perfectly well.
 */
function segmentFrom(
  posted: number,
  daysSince: number | null,
  items: readonly ItemHistory[],
): Segment {
  if (posted === 0) return 'none'
  if (daysSince !== null && daysSince > DORMANT_DAYS) return 'dormant'
  const chronic = items.some(
    (i) => i.cycle !== null
      && i.cycle.steady
      && i.cycle.days >= CHRONIC_MIN_DAYS
      && i.cycle.days <= CHRONIC_MAX_DAYS,
  )
  return chronic ? 'chronic' : 'occasional'
}

// ------------------------------------------------------------------ book ---

export function buildProfiles(
  rows: readonly CustomerRow[],
  today: Date,
): Map<number, PurchaseProfile> {
  const out = new Map<number, PurchaseProfile>()
  for (const row of rows) out.set(row.customer.id, profileOf(row.bills, today))
  return out
}

export function segmentOf(
  profiles: ReadonlyMap<number, PurchaseProfile>,
  customerId: number,
): Segment {
  return profiles.get(customerId)?.segment ?? 'none'
}

export interface RefillDue {
  customerId: number
  name: string
  phone: string
  item: ItemHistory
  dueOn: IsoDate
  /** Negative is overdue. */
  dueInDays: number
}

/**
 * The refills a shop can act on today.
 *
 * Bounded at BOTH ends, and the lower bound is the one that matters. An item a
 * full cycle overdue is not a reminder any more, it is a customer who has
 * stopped — leaving those in produces a list that grows forever and gets closed
 * unread, which costs the shop the reminders that were still live. The dormant
 * segment is where that customer resurfaces, as a call rather than a refill.
 */
export function refillsDue(
  rows: readonly CustomerRow[],
  profiles: ReadonlyMap<number, PurchaseProfile>,
  aheadDays: number,
): RefillDue[] {
  const out: RefillDue[] = []
  for (const row of rows) {
    const profile = profiles.get(row.customer.id)
    if (!profile) continue
    for (const item of profile.refills) {
      const { dueOn, dueInDays, cycle } = item
      if (dueOn === null || dueInDays === null || cycle === null) continue
      if (dueInDays > aheadDays) continue
      if (dueInDays < -cycle.days) continue
      out.push({
        customerId: row.customer.id,
        name: row.customer.name,
        phone: row.customer.phone,
        item,
        dueOn,
        dueInDays,
      })
    }
  }
  // Most overdue first: the list is worked from the top and the top is the one
  // whose strip ran out longest ago.
  return out.sort((a, b) => a.dueInDays - b.dueInDays || a.name.localeCompare(b.name))
}

export function countSegments(
  profiles: ReadonlyMap<number, PurchaseProfile>,
): Record<Segment, number> {
  const counts: Record<Segment, number> = { chronic: 0, occasional: 0, dormant: 0, none: 0 }
  for (const profile of profiles.values()) counts[profile.segment] += 1
  return counts
}
