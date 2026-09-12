import type {
  IsoDate, Money, Pct, PurchaseInvoice, PurchaseOrder, Qty, Supplier, SupplierReturn,
} from '@contract'
import * as D from '@/domain/decimal'

/**
 * What the purchase book says about the people you buy from.
 *
 * Everything here is DERIVED from documents already on file — bills, orders and
 * claims — and nothing is stored. A pharmacy's leverage over a distributor is
 * almost entirely informational: the shop knows what it paid last time and the
 * salesman knows what he wants to charge this time, and whoever has the number
 * to hand wins. These functions produce that number.
 *
 * Four rules hold the module together:
 *
 *  1. MONEY IS DECIMAL THROUGHOUT. Every sum, share and percentage is computed
 *     on `src/domain/decimal` and leaves as a string. A rate move of 4.9% and
 *     one of 5.0% sit either side of an alert threshold, and float arithmetic
 *     decides which one you are told about.
 *  2. A CANCELLED DOCUMENT BOUGHT NOTHING. Cancelled bills and cancelled orders
 *     are excluded everywhere rather than netted off, because a supplier is not
 *     credited for a bill that was voided the same day it was raised.
 *  3. AN UNKNOWN IS NULL, NEVER ZERO. A supplier with no orders on file has no
 *     fill rate — it is not 0%, and printing 0% next to a distributor who has
 *     never been ordered from through this software is a lie that gets quoted
 *     back to them.
 *  4. A RECEIPT IS CONSUMED ONCE. Matching goods against orders is greedy and
 *     stateful for exactly this reason: one delivery cannot fill two orders, and
 *     a naive per-order match reports 100% twice on a shop that ordered twice
 *     and was delivered once.
 */

const MONTH_LABEL = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const DAY_MS = 86_400_000

/** Posted only — see rule 2. */
function posted(purchases: readonly PurchaseInvoice[]): PurchaseInvoice[] {
  return purchases.filter((p) => p.status === 'POSTED')
}

/** `2026-04-17` → `2026-04`. Substring, not a Date: the string is already local. */
function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

function monthLabel(key: string): string {
  const month = Number(key.slice(5, 7))
  const name = MONTH_LABEL[month - 1] ?? key
  return `${name} ${key.slice(2, 4)}`
}

/**
 * Whole days between two local calendar dates.
 *
 * Built from the parts rather than by parsing the ISO string as an instant:
 * `new Date('2026-04-17')` is midnight UTC, which is 05:30 on the 17th in India
 * — so a same-day delivery in Pune measures as an hour before it was ordered.
 */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / DAY_MS)
}

function addDaysIso(from: IsoDate, days: number): IsoDate {
  const base = Date.parse(`${from}T00:00:00Z`)
  if (Number.isNaN(base)) return from
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10)
}

function localIso(d: Date): IsoDate {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** `a / b * 100`, or null when there is nothing to divide by. */
function pctOf(part: D.Decimal, whole: D.Decimal, dp = 1): Pct | null {
  if (D.isZero(whole)) return null
  return D.toStr(D.div(D.mul(part, D.HUNDRED), whole), dp)
}

// -------------------------------------------------------------- spend ------

export interface MonthSpend {
  /** `YYYY-MM`. */
  key: string
  /** `Apr 26` — the chart's category label. */
  label: string
  amount: Money
  bills: number
}

/**
 * Spend per calendar month, INCLUDING the months nothing was bought in.
 *
 * A bar chart built only from months that have data silently closes the gap
 * where a shop stopped buying, which is the single most interesting shape a
 * purchase history has.
 */
export function spendByMonth(
  purchases: readonly PurchaseInvoice[],
  opts: { months: number; today: Date },
): MonthSpend[] {
  const totals = new Map<string, { amount: D.Decimal; bills: number }>()
  for (const p of posted(purchases)) {
    const key = monthOf(p.invoiceDate)
    const cell = totals.get(key) ?? { amount: D.ZERO, bills: 0 }
    totals.set(key, { amount: D.add(cell.amount, D.dec(p.netAmount)), bills: cell.bills + 1 })
  }

  const out: MonthSpend[] = []
  const anchor = new Date(opts.today.getFullYear(), opts.today.getMonth(), 1)
  for (let back = opts.months - 1; back >= 0; back--) {
    const at = new Date(anchor.getFullYear(), anchor.getMonth() - back, 1)
    const key = localIso(at).slice(0, 7)
    const cell = totals.get(key)
    out.push({
      key,
      label: monthLabel(key),
      amount: D.toStr(cell?.amount ?? D.ZERO, 2),
      bills: cell?.bills ?? 0,
    })
  }
  return out
}

export interface SupplierSpend {
  supplierId: number
  supplierName: string
  amount: Money
  bills: number
  sharePct: Pct
}

/** Spend per distributor, biggest first, with each one's share of the total. */
export function spendBySupplier(
  purchases: readonly PurchaseInvoice[],
  opts?: { from?: IsoDate },
): SupplierSpend[] {
  const from = opts?.from
  const rows = new Map<number, { name: string; amount: D.Decimal; bills: number }>()
  let total = D.ZERO
  for (const p of posted(purchases)) {
    if (from !== undefined && p.invoiceDate < from) continue
    const cell = rows.get(p.supplierId) ?? { name: p.supplierName, amount: D.ZERO, bills: 0 }
    const amount = D.add(cell.amount, D.dec(p.netAmount))
    rows.set(p.supplierId, { name: p.supplierName, amount, bills: cell.bills + 1 })
    total = D.add(total, D.dec(p.netAmount))
  }

  return [...rows.entries()]
    .map(([supplierId, cell]) => ({
      supplierId,
      supplierName: cell.name,
      amount: D.toStr(cell.amount, 2),
      bills: cell.bills,
      sharePct: pctOf(cell.amount, total) ?? '0.0',
    }))
    .sort((a, b) => D.cmp(D.dec(b.amount), D.dec(a.amount)) || a.supplierName.localeCompare(b.supplierName))
}

export interface PurchaseSummary {
  monthKey: string
  monthLabel: string
  monthSpend: Money
  monthBills: number
  previousMonthSpend: Money
  /** Month on month. Null when last month was zero — a rise from nothing has no %. */
  monthMovePct: Pct | null
  yearSpend: Money
  yearBills: number
  yearLines: number
  avgBill: Money | null
  suppliersUsed: number
}

/** The figures the top of the Insights tab exists to state. */
export function purchaseSummary(
  purchases: readonly PurchaseInvoice[],
  today: Date,
): PurchaseSummary {
  const live = posted(purchases)
  const thisMonth = localIso(today).slice(0, 7)
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const prevMonth = localIso(prev).slice(0, 7)
  const yearFrom = localIso(new Date(today.getFullYear(), today.getMonth() - 11, 1))

  let monthSpend = D.ZERO
  let monthBills = 0
  let previousMonthSpend = D.ZERO
  let yearSpend = D.ZERO
  let yearBills = 0
  let yearLines = 0
  const suppliers = new Set<number>()

  for (const p of live) {
    const month = monthOf(p.invoiceDate)
    if (month === thisMonth) {
      monthSpend = D.add(monthSpend, D.dec(p.netAmount))
      monthBills += 1
    }
    if (month === prevMonth) previousMonthSpend = D.add(previousMonthSpend, D.dec(p.netAmount))
    if (p.invoiceDate >= yearFrom) {
      yearSpend = D.add(yearSpend, D.dec(p.netAmount))
      yearBills += 1
      yearLines += p.lines.length
      suppliers.add(p.supplierId)
    }
  }

  return {
    monthKey: thisMonth,
    monthLabel: monthLabel(thisMonth),
    monthSpend: D.toStr(monthSpend, 2),
    monthBills,
    previousMonthSpend: D.toStr(previousMonthSpend, 2),
    monthMovePct: D.isZero(previousMonthSpend)
      ? null
      : D.toStr(D.div(D.mul(D.sub(monthSpend, previousMonthSpend), D.HUNDRED), previousMonthSpend), 1),
    yearSpend: D.toStr(yearSpend, 2),
    yearBills,
    yearLines,
    avgBill: yearBills === 0 ? null : D.toStr(D.div(yearSpend, D.dec(String(yearBills))), 2),
    suppliersUsed: suppliers.size,
  }
}

// --------------------------------------------------------- rate moves ------

export interface RateMove {
  /** Stable across renders: one line of one bill. */
  id: string
  purchaseId: number
  purchaseNo: string
  supplierInvoiceNo: string
  invoiceDate: IsoDate
  supplierId: number
  supplierName: string
  medicineId: number
  brandName: string
  packLabel: string
  /** Per pack, GST-exclusive, as the purchase side always is. */
  from: Money
  to: Money
  /** Signed: negative is a rate that came DOWN. */
  movePct: Pct
  /** Margin at MRP after this move, and before it. Null when no MRP was keyed. */
  marginPct: Pct | null
  marginPctBefore: Pct | null
}

/**
 * Every rate move in the book, oldest first.
 *
 * The comparison is per (supplier, medicine): distributors do not all charge
 * the same rate and never have, so comparing across them produces an "alert" on
 * every line of every bill and the feature becomes noise within a week.
 *
 * `PurchaseLine.rateChangedFrom` is used when the register carries it, and the
 * history is walked when it does not — an imported bill and a bill posted before
 * the flag existed both have to be readable, and an alert the shop cannot see
 * because of how the document arrived is worse than no alert.
 */
export function rateMoves(purchases: readonly PurchaseInvoice[]): RateMove[] {
  const ordered = [...posted(purchases)].sort(
    (a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.id - b.id,
  )
  const lastRate = new Map<string, D.Decimal>()
  const out: RateMove[] = []

  for (const p of ordered) {
    for (const line of p.lines) {
      const key = `${p.supplierId}:${line.medicineId}`
      const now = D.dec(line.ratePerPack)
      const previous = lastRate.get(key)
        ?? (line.rateChangedFrom === null ? null : D.dec(line.rateChangedFrom))
      lastRate.set(key, now)
      if (previous === null || D.isZero(previous) || D.eq(previous, now)) continue

      const mrp = D.dec(line.mrpPerPack)
      const margin = (rate: D.Decimal): Pct | null =>
        D.isZero(mrp) ? null : D.toStr(D.div(D.mul(D.sub(mrp, rate), D.HUNDRED), mrp), 1)

      out.push({
        id: `${p.id}:${line.lineId}`,
        purchaseId: p.id,
        purchaseNo: p.purchaseNo,
        supplierInvoiceNo: p.supplierInvoiceNo,
        invoiceDate: p.invoiceDate,
        supplierId: p.supplierId,
        supplierName: p.supplierName,
        medicineId: line.medicineId,
        brandName: line.brandName,
        packLabel: line.packLabel,
        from: D.toStr(previous, 2),
        to: D.toStr(now, 2),
        movePct: D.toStr(D.div(D.mul(D.sub(now, previous), D.HUNDRED), previous), 1),
        marginPct: margin(now),
        marginPctBefore: margin(previous),
      })
    }
  }
  return out
}

/**
 * The moves worth interrupting somebody about: newest first, biggest first
 * within a day.
 *
 * Rises and falls both qualify. A rate that quietly dropped is a rate the shop
 * has been over-paying for months and has every right to ask about.
 */
export function rateAlerts(
  moves: readonly RateMove[],
  opts: { thresholdPct: string; limit?: number; supplierId?: number | null },
): RateMove[] {
  const threshold = D.abs(D.dec(opts.thresholdPct))
  const wanted = moves.filter((m) => {
    if (opts.supplierId !== undefined && opts.supplierId !== null && m.supplierId !== opts.supplierId) {
      return false
    }
    return D.gte(D.abs(D.dec(m.movePct)), threshold)
  })
  wanted.sort((a, b) =>
    b.invoiceDate.localeCompare(a.invoiceDate)
    || D.cmp(D.abs(D.dec(b.movePct)), D.abs(D.dec(a.movePct)))
    || a.brandName.localeCompare(b.brandName))
  return opts.limit === undefined ? wanted : wanted.slice(0, opts.limit)
}

// -------------------------------------------------------- the scorecard ----

export interface SupplierScore {
  supplierId: number
  supplierName: string
  /** Over the scoring window. */
  spend: Money
  bills: number
  lines: number
  sharePct: Pct
  outstanding: Money
  paymentTermsDays: number
  /** Ordered vs delivered. `pct` is null when nothing has been ordered on file. */
  fill: { orderedUnits: Qty; receivedUnits: Qty; pct: Pct | null; orders: number }
  /** Days from placing an order to the first goods against it. */
  leadTimeDays: number | null
  leadSamples: number
  rateRises: number
  rateFalls: number
  /** The typical rise, so one 40% outlier does not describe the relationship. */
  medianRisePct: Pct | null
  /** Free packs as a share of packs paid for. The scheme, in one number. */
  schemePct: Pct | null
  claims: {
    claimed: Money
    received: Money
    shortfall: Money
    /** Credit received as a share of what was claimed AND settled. */
    settledPct: Pct | null
    open: number
    settled: number
  }
}

export interface ScorecardInput {
  suppliers: readonly Supplier[]
  purchases: readonly PurchaseInvoice[]
  orders: readonly PurchaseOrder[]
  returns: readonly SupplierReturn[]
  today: Date
  /** How far back the score looks. A year, so seasonal buying is included. */
  windowDays?: number
  /** How long after an order goods may still be attributed to it. */
  receiptWindowDays?: number
  /**
   * How long an order is left alone before it counts against the fill rate.
   *
   * Two days, which is what a distributor in an Indian city actually takes.
   * Without it the rate drops the moment an order is placed and climbs back
   * when the van arrives, which measures the calendar rather than the supplier
   * — and the number is at its worst exactly when it is being read, because the
   * reason anyone opens this screen is that they just ordered something.
   */
  graceDays?: number
}

/** One receipt of one medicine, with what is left of it to attribute. */
interface ReceiptUnit {
  date: IsoDate
  medicineId: number
  remaining: D.Decimal
}

export function supplierScorecards(input: ScorecardInput): SupplierScore[] {
  const windowDays = input.windowDays ?? 365
  const receiptWindow = input.receiptWindowDays ?? 45
  const from = addDaysIso(localIso(input.today), -windowDays)

  const live = posted(input.purchases).filter((p) => p.invoiceDate >= from)
  const moves = rateMoves(input.purchases).filter((m) => m.invoiceDate >= from)

  let total = D.ZERO
  for (const p of live) total = D.add(total, D.dec(p.netAmount))

  return input.suppliers
    .map((supplier) => {
      const bills = live.filter((p) => p.supplierId === supplier.id)

      let spend = D.ZERO
      let lines = 0
      let paidPacks = D.ZERO
      let freePacks = D.ZERO
      const receipts: ReceiptUnit[] = []
      for (const bill of bills) {
        spend = D.add(spend, D.dec(bill.netAmount))
        lines += bill.lines.length
        for (const line of bill.lines) {
          paidPacks = D.add(paidPacks, D.dec(line.qtyPacks))
          freePacks = D.add(freePacks, D.dec(line.freePacks))
          /* Packs to base units, and free goods count: what arrived on the shelf
             is what fills an order, whether or not it was charged for. */
          const units = D.mul(
            D.add(D.dec(line.qtyPacks), D.dec(line.freePacks)),
            D.dec(String(line.unitsPerPack || 1)),
          )
          receipts.push({ date: bill.invoiceDate, medicineId: line.medicineId, remaining: units })
        }
      }
      receipts.sort((a, b) => a.date.localeCompare(b.date))

      const fill = fillAgainstOrders({
        orders: input.orders.filter((o) => o.supplierId === supplier.id && o.status !== 'CANCELLED'),
        receipts,
        receiptWindow,
        today: localIso(input.today),
        graceDays: input.graceDays ?? 2,
      })

      const mine = moves.filter((m) => m.supplierId === supplier.id)
      const rises = mine.filter((m) => !D.isNeg(D.dec(m.movePct)))

      const claims = claimPositionFor(input.returns, supplier.id)

      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        spend: D.toStr(spend, 2),
        bills: bills.length,
        lines,
        sharePct: pctOf(spend, total) ?? '0.0',
        outstanding: supplier.outstanding,
        paymentTermsDays: supplier.paymentTermsDays,
        fill: fill.fill,
        leadTimeDays: fill.leadTimeDays,
        leadSamples: fill.leadSamples,
        rateRises: rises.length,
        rateFalls: mine.length - rises.length,
        medianRisePct: median(rises.map((m) => m.movePct)),
        schemePct: D.isZero(paidPacks) ? null : pctOf(freePacks, paidPacks),
        claims,
      }
    })
    .sort((a, b) => D.cmp(D.dec(b.spend), D.dec(a.spend)) || a.supplierName.localeCompare(b.supplierName))
}

/**
 * Ordered against delivered, one supplier at a time.
 *
 * Greedy and destructive over `receipts`: a delivery already counted against
 * the order that asked for it cannot be counted again against the next one. A
 * per-order match without this reports a perfect fill rate for a shop that
 * ordered the same line twice and was delivered it once, which is precisely the
 * supplier this number exists to catch.
 */
function fillAgainstOrders(v: {
  orders: readonly PurchaseOrder[]
  receipts: ReceiptUnit[]
  receiptWindow: number
  today: IsoDate
  graceDays: number
}): { fill: SupplierScore['fill']; leadTimeDays: number | null; leadSamples: number } {
  /* An order still inside its delivery window has not been failed yet — see
     `graceDays`. Its own expected date wins over the default where one was
     agreed, because that is the promise the distributor actually made. */
  const due = (o: PurchaseOrder): boolean => (o.expectedOn !== null
    ? o.expectedOn < v.today
    : daysBetween(o.placedOn, v.today) >= v.graceDays)

  const orders = [...v.orders]
    .filter(due)
    .sort((a, b) => a.placedOn.localeCompare(b.placedOn))
  let ordered = D.ZERO
  let received = D.ZERO
  const leadDays: number[] = []

  for (const order of orders) {
    const until = addDaysIso(order.placedOn, v.receiptWindow)
    let firstAt: IsoDate | null = null

    for (const line of order.lines) {
      const want = D.dec(line.qty)
      ordered = D.add(ordered, want)

      /* A backend that tracks receipt against the order line itself is believed
         over anything inferred here. Nothing does yet; when one does, this stops
         guessing without the screen changing. */
      const recorded = D.dec(line.receivedQty)
      if (D.gt(recorded, D.ZERO)) {
        received = D.add(received, D.min(recorded, want))
        continue
      }

      let need = want
      for (const receipt of v.receipts) {
        if (D.isZero(need)) break
        if (receipt.medicineId !== line.medicineId) continue
        if (receipt.date < order.placedOn || receipt.date > until) continue
        if (!D.gt(receipt.remaining, D.ZERO)) continue
        const take = D.min(need, receipt.remaining)
        receipt.remaining = D.sub(receipt.remaining, take)
        need = D.sub(need, take)
        received = D.add(received, take)
        if (firstAt === null || receipt.date < firstAt) firstAt = receipt.date
      }
    }

    if (firstAt !== null) leadDays.push(Math.max(0, daysBetween(order.placedOn, firstAt)))
  }

  const pct = D.isZero(ordered)
    ? null
    : D.toStr(D.min(D.HUNDRED, D.div(D.mul(received, D.HUNDRED), ordered)), 1)

  return {
    fill: {
      orderedUnits: D.toStr(ordered, 2),
      receivedUnits: D.toStr(received, 2),
      pct,
      orders: orders.length,
    },
    leadTimeDays: leadDays.length === 0
      ? null
      : Math.round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length),
    leadSamples: leadDays.length,
  }
}

/**
 * How a supplier settles expiry claims.
 *
 * The percentage is over SETTLED claims only. Including the ones still open
 * would read as a settlement rate falling every time a new claim is raised,
 * which says nothing about the supplier and everything about the calendar.
 */
function claimPositionFor(
  returns: readonly SupplierReturn[],
  supplierId: number,
): SupplierScore['claims'] {
  let claimed = D.ZERO
  let received = D.ZERO
  let settledValue = D.ZERO
  let open = 0
  let settled = 0

  for (const doc of returns) {
    if (doc.supplierId !== supplierId) continue
    if (doc.kind !== 'EXPIRY_CLAIM' || doc.status !== 'POSTED') continue
    const net = D.dec(doc.netAmount)
    claimed = D.add(claimed, net)
    if (doc.creditReceived === null) {
      open += 1
      continue
    }
    settled += 1
    settledValue = D.add(settledValue, net)
    received = D.add(received, D.dec(doc.creditReceived))
  }

  return {
    claimed: D.toStr(claimed, 2),
    received: D.toStr(received, 2),
    shortfall: D.toStr(D.max(D.ZERO, D.sub(settledValue, received)), 2),
    settledPct: settled === 0 ? null : pctOf(received, settledValue),
    open,
    settled,
  }
}

/** The middle value, by magnitude. Returns the original string, never a float. */
function median(values: readonly Pct[]): Pct | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => D.cmp(D.dec(a), D.dec(b)))
  const mid = Math.floor(sorted.length / 2)
  return sorted[mid] ?? null
}
