import type {
  ActivityRow, AttentionCounts, Batch, BranchSummaryRow, CategoryShare, DashboardData,
  DashboardKpis, DashboardRange, DrugSchedule, ExpiringBatchRow, HeldBill, InventoryHealth,
  IsoDate, Kpi, LowStockRow, Medicine, Money, MoverRow, Pct, Qty, SaleInvoice, StoreProfile,
  TopMedicineRow, TrendPoint,
} from '@contract'
import * as D from '@/domain/decimal'
import { apportion } from '@/domain/gst'
import { daysToExpiry, fefoOrder, isExpired, isSellable } from '@/domain/fefo'

/**
 * The dashboard, computed from the local tables.
 *
 * `computeDashboard` is a pure function of its inputs: the adapter reads Dexie,
 * this decides what the rows mean. That split is the whole point — the numbers
 * are then testable against a dozen hand-written fixtures instead of a seeded
 * IndexedDB, and the same deps always produce byte-identical output. Hence no
 * `Date.now()` and no argless `new Date()` anywhere below: "now" is `deps.today`.
 */

export interface DashboardDeps {
  medicines: readonly Medicine[]
  batches: readonly Batch[]
  invoices: readonly SaleInvoice[]
  shortbook: ReadonlyArray<{ medicineId: number | null; term: string; at: string }>
  heldBills: readonly HeldBill[]
  store: StoreProfile
  today: IsoDate
  /** The window the KPIs, the takings chart and the movers read. Default `today`. */
  range?: DashboardRange
}

// ------------------------------------------------------------------ dates ---

const MS_PER_DAY = 86_400_000
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Calendar arithmetic in UTC, so a machine in another zone gets the same day. */
function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

interface YearMonth {
  year: number
  month: number
}

const monthOf = (date: IsoDate): YearMonth => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
})

const monthKey = (ym: YearMonth): string => `${ym.year}-${pad2(ym.month)}`

function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  const zeroBased = ym.year * 12 + (ym.month - 1) + delta
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 }
}

/** India runs April-March: March 2026 is FY 2025-26, April 2026 is FY 2026-27. */
function financialYearLabel(ym: YearMonth, startMonth: number): string {
  const start = ym.month >= startMonth ? ym.year : ym.year - 1
  return `${start}-${pad2((start + 1) % 100)}`
}

/**
 * Midnight at the start of `date` on the shop's own clock.
 *
 * The fence only has to sit below the day's first sale and above the previous
 * day's last one. `createdAt` is a UTC instant, so UTC midnight can land after
 * the shutters are already up — at UTC+14 a 9 a.m. sale carries a stamp from
 * the previous UTC day and would sort under the alerts. This therefore assumes
 * `today` is the shop's LOCAL calendar date; a caller that hands it a UTC date
 * shifts the fence by its own offset. See `hourOf`, which reads local hours for
 * the same reason.
 */
function startOfLocalDay(date: IsoDate): string {
  const ym = monthOf(date)
  return new Date(ym.year, ym.month - 1, Number(date.slice(8, 10))).toISOString()
}

/** Epoch millis, or 0 for an unparseable stamp — used only to order activity. */
function instant(stamp: string): number {
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? 0 : t
}

/** The selected window, and the equally long one immediately before it. */
export interface DashboardWindow {
  start: IsoDate
  end: IsoDate
  prevStart: IsoDate
  prevEnd: IsoDate
  /** Inclusive day count. 1 for `today`, 7 for `7d`, day-of-month for `month`. */
  days: number
  /** What the deltas compare against, in the words the tile prints. */
  comparedTo: string
}

/**
 * A range preset to two inclusive windows.
 *
 * The comparison window is always the SAME LENGTH and immediately before the
 * selected one — including for `month`, where the obvious alternative (the whole
 * of last month) compares eight days of trading against thirty-one and reports a
 * catastrophe every month on the 8th. Month-to-date versus the equally long
 * stretch that just ended is the only comparison that answers "are we ahead".
 */
export function rangeWindow(today: IsoDate, range: DashboardRange = 'today'): DashboardWindow {
  const start =
    range === 'today' ? today
      : range === '7d' ? addDays(today, -6)
        : range === '30d' ? addDays(today, -29)
          : `${today.slice(0, 8)}01`
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY,
  ) + 1
  const prevEnd = addDays(start, -1)
  return {
    start,
    end: today,
    prevStart: addDays(prevEnd, -(days - 1)),
    prevEnd,
    days,
    comparedTo: days === 1 ? 'yesterday' : `previous ${days} days`,
  }
}

// ------------------------------------------------------------------ money ---

const money = (x: D.Decimal): Money => D.toStr(x, 2)
/** Qty is written at 3dp everywhere the adapter writes it; match that. */
const qty = (x: D.Decimal): Qty => D.toStr(x, 3)
/** Counts wear the Kpi shape but are not rupees — "12.00 orders" reads as a bug. */
const countValue = (n: number): Money => D.toStr(D.dec(n), 0)

/**
 * Signed movement against the comparison period.
 *
 * Null unless the baseline is positive. A yesterday of zero would make every
 * first-day-of-trading tile read "+100%", and a NEGATIVE baseline inverts the
 * sign outright — profit swinging from a 100 loss to a 50 gain divides out to
 * -150%, painting the best news of the week red. Neither is a fact about the
 * business; both are divisions that should never have been performed.
 */
function deltaPct(current: D.Decimal, previous: D.Decimal): Pct | null {
  if (!D.gt(previous, D.ZERO)) return null
  return D.toStr(D.mul(D.div(D.sub(current, previous), previous), D.HUNDRED), 2)
}

const kpi = (value: Money, current: D.Decimal, previous: D.Decimal, riseIsGood: boolean): Kpi => ({
  value,
  deltaPct: deltaPct(current, previous),
  riseIsGood,
})

// ------------------------------------------------------------- day totals ---

interface DayTotals {
  sales: D.Decimal
  profit: D.Decimal
  taxable: D.Decimal
  orders: number
  customers: number
}

/**
 * One window's trading, from posted invoices only. `from` and `to` are inclusive.
 *
 * Profit is line taxable value minus the `costBasis` snapshotted onto each
 * allocation at post time. Re-deriving it from today's landed cost would
 * revalue history every time a new purchase lands.
 */
function periodTotals(posted: readonly SaleInvoice[], from: IsoDate, to: IsoDate): DayTotals {
  let sales = D.ZERO
  let profit = D.ZERO
  let taxable = D.ZERO
  let orders = 0
  const identified = new Set<number>()
  let hasWalkIn = false

  for (const inv of posted) {
    if (inv.invoiceDate < from || inv.invoiceDate > to) continue
    orders += 1
    sales = D.add(sales, D.dec(inv.quote.netAmount))
    if (inv.customerId === null) hasWalkIn = true
    else identified.add(inv.customerId)

    for (const line of inv.quote.lines) {
      for (const alloc of line.allocations) {
        const lineTaxable = D.dec(alloc.taxableValue)
        taxable = D.add(taxable, lineTaxable)
        profit = D.add(profit, D.sub(lineTaxable, D.dec(alloc.costBasis)))
      }
    }
  }

  // Every walk-in is the same anonymous bucket. Counting them individually turns
  // this tile into the order count wearing a different label.
  const customers = identified.size + (hasWalkIn ? 1 : 0)
  return { sales, profit, taxable, orders, customers }
}

const marginPct = (profit: D.Decimal, taxable: D.Decimal): D.Decimal =>
  D.isZero(taxable) ? D.ZERO : D.mul(D.div(profit, taxable), D.HUNDRED)

/**
 * Receivables as at `asOf`.
 *
 * Customers are not in `deps` — and they need not be, because the balance is the
 * credit taken on posted bills. Walk-ins are excluded: there is no ledger to owe
 * on. Only positive balances count, so an over-paid account cannot quietly net
 * off somebody else's debt.
 */
function outstandingAsOf(posted: readonly SaleInvoice[], asOf: IsoDate): D.Decimal {
  const byCustomer = new Map<number, D.Decimal>()
  for (const inv of posted) {
    if (inv.invoiceDate > asOf || inv.customerId === null) continue
    let credit = D.ZERO
    for (const p of inv.payments) {
      if (p.mode === 'CREDIT') credit = D.add(credit, D.dec(p.amount))
    }
    if (D.isZero(credit)) continue
    byCustomer.set(inv.customerId, D.add(byCustomer.get(inv.customerId) ?? D.ZERO, credit))
  }
  return D.sum([...byCustomer.values()].filter((v) => D.gt(v, D.ZERO)))
}

// ------------------------------------------------------------- categories ---

/**
 * Medicine has no category column, and inventing one from the brand name would
 * be a guess that changes whenever a name changes. The drug schedule is real, is
 * present on every row, and is the grouping a pharmacist already thinks in.
 */
const SCHEDULE_LABELS: Record<DrugSchedule, string> = {
  OTC: 'OTC',
  G: 'Schedule G',
  H: 'Schedule H',
  H1: 'Schedule H1',
  X: 'Schedule X',
  NRx: 'NRx',
}

const MIX_LIMIT = 5

function categoryMix(postedInPeriod: readonly SaleInvoice[]): CategoryShare[] {
  const bySchedule = new Map<string, D.Decimal>()
  for (const inv of postedInPeriod) {
    for (const line of inv.quote.lines) {
      bySchedule.set(
        line.drugSchedule,
        D.add(bySchedule.get(line.drugSchedule) ?? D.ZERO, D.dec(line.lineTotal)),
      )
    }
  }

  let groups = [...bySchedule.entries()]
    .map(([key, value]) => ({
      key,
      label: SCHEDULE_LABELS[key as DrugSchedule] ?? key,
      value,
    }))
    .sort((a, b) => D.cmp(b.value, a.value) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  if (D.isZero(D.sum(groups.map((g) => g.value)))) return []

  if (groups.length > MIX_LIMIT) {
    const tail = groups.slice(MIX_LIMIT - 1)
    groups = [
      ...groups.slice(0, MIX_LIMIT - 1),
      { key: 'OTHER', label: 'Other', value: D.sum(tail.map((t) => t.value)) },
    ]
  }

  // Largest-remainder, so the shares sum to exactly 100.00 and the donut has no
  // sliver of unexplained arc.
  const shares = apportion(D.HUNDRED, groups.map((g) => g.value))
  return groups.map((g, i) => ({
    key: g.key,
    label: g.label,
    value: money(g.value),
    sharePct: D.toStr(shares[i] ?? D.ZERO, 2),
  }))
}

// ----------------------------------------------------------------- movers ---

const MOVERS_N = 5

/** Revenue and units per medicine inside an inclusive window. */
function revenueByMedicine(
  posted: readonly SaleInvoice[],
  from: IsoDate,
  to: IsoDate,
): { revenue: Map<number, D.Decimal>; units: Map<number, D.Decimal> } {
  const revenue = new Map<number, D.Decimal>()
  const units = new Map<number, D.Decimal>()
  for (const inv of posted) {
    if (inv.invoiceDate < from || inv.invoiceDate > to) continue
    for (const line of inv.quote.lines) {
      revenue.set(line.medicineId, D.add(revenue.get(line.medicineId) ?? D.ZERO, D.dec(line.lineTotal)))
      units.set(line.medicineId, D.add(units.get(line.medicineId) ?? D.ZERO, D.dec(line.allocatedQty)))
    }
  }
  return { revenue, units }
}

/**
 * What moved, and by how much, against the previous window.
 *
 * Ranked by the RUPEE change rather than the percentage. A line that went from
 * ₹50 to ₹250 is +400% and buys nothing; the line that carries the shop moving
 * 8% is the week's actual news, and a percentage ranking buries it under noise
 * from the tail. The percentage still ships on the row, as context for the rupees.
 */
function computeMovers(
  posted: readonly SaleInvoice[],
  medById: ReadonlyMap<number, Medicine>,
  win: DashboardWindow,
): { risers: MoverRow[]; fallers: MoverRow[] } {
  const now = revenueByMedicine(posted, win.start, win.end)
  const before = revenueByMedicine(posted, win.prevStart, win.prevEnd)

  const rows: Array<{ row: MoverRow; delta: D.Decimal }> = []
  for (const medicineId of new Set([...now.revenue.keys(), ...before.revenue.keys()])) {
    const med = medById.get(medicineId)
    if (!med) continue
    const current = now.revenue.get(medicineId) ?? D.ZERO
    const previous = before.revenue.get(medicineId) ?? D.ZERO
    const delta = D.sub(current, previous)
    if (D.isZero(delta)) continue
    rows.push({
      delta,
      row: {
        medicineId,
        brandName: med.brandName,
        packLabel: med.packLabel,
        current: money(current),
        previous: money(previous),
        deltaAmount: money(delta),
        deltaPct: deltaPct(current, previous),
        unitsSold: qty(now.units.get(medicineId) ?? D.ZERO),
      },
    })
  }

  const byMagnitude = (dir: 1 | -1) => (a: typeof rows[number], b: typeof rows[number]) =>
    dir * D.cmp(b.delta, a.delta) || a.row.medicineId - b.row.medicineId

  return {
    risers: rows.filter((r) => D.gt(r.delta, D.ZERO)).sort(byMagnitude(1)).slice(0, MOVERS_N)
      .map((r) => r.row),
    fallers: rows.filter((r) => D.lt(r.delta, D.ZERO)).sort(byMagnitude(-1)).slice(0, MOVERS_N)
      .map((r) => r.row),
  }
}

// --------------------------------------------------------------- branches ---

export interface BranchInputs {
  stores: readonly StoreProfile[]
  /** EVERY branch's posted-or-not invoices, unfiltered. Scoped here by storeId. */
  invoices: readonly SaleInvoice[]
  /** EVERY branch's batches, unfiltered. */
  batches: readonly Batch[]
  /** The branch this session is billing for. */
  currentStoreId: number
  from: IsoDate
  to: IsoDate
  today: IsoDate
}

/**
 * Every branch side by side: what it took, and what is on its shelf.
 *
 * Trading alone would be a comparison of one number against a blank for any
 * branch that has not billed yet today, which is most branches at 9 a.m. The
 * shelf columns are what make the row worth reading at every hour — and they are
 * the columns an owner uses to decide which branch to move stock to.
 *
 * Scoped by `storeId` here rather than by the caller: `computeDashboard` is
 * deliberately handed ONE branch's rows, and this is the one view that must see
 * across them.
 */
export function branchComparison(input: BranchInputs): BranchSummaryRow[] {
  const { stores, invoices, batches, currentStoreId, from, to, today } = input
  return [...stores]
    .sort((a, b) => a.id - b.id)
    .map((store) => {
      const window = store.nearExpiryBuckets.length > 0
        ? Math.max(...store.nearExpiryBuckets)
        : 90

      let sales = D.ZERO
      let orders = 0
      for (const inv of invoices) {
        if (inv.storeId !== store.id || inv.status !== 'POSTED') continue
        if (inv.invoiceDate < from || inv.invoiceDate > to) continue
        orders += 1
        sales = D.add(sales, D.dec(inv.quote.netAmount))
      }

      let stockAtCost = D.ZERO
      let batchCount = 0
      let nearExpiry = 0
      for (const b of batches) {
        if (b.storeId !== store.id) continue
        batchCount += 1
        if (!isSellable(b, today)) continue
        stockAtCost = D.add(stockAtCost, D.mul(D.dec(b.qtyOnHand), D.dec(b.landedCostPerUnit)))
        if (daysToExpiry(b, today) <= window) nearExpiry += 1
      }

      return {
        storeId: store.id,
        name: store.name,
        city: store.city,
        isCurrent: store.id === currentStoreId,
        sales: money(sales),
        orders,
        stockAtCost: money(stockAtCost),
        batches: batchCount,
        nearExpiry,
      }
    })
}

// ------------------------------------------------------------------- main ---

const TOP_N = 8
const ACTIVITY_N = 8
const ALERTS_N = 3
const TREND_MONTHS = 12
const TREND_SERIES_MAX = 3
const NEAR_EXPIRY_ATTENTION_DAYS = 30
const HOUR_OPEN = 8
const HOUR_CLOSE = 23

/**
 * The shop's own clock. `createdAt` is a UTC instant; takings at 10 a.m. must
 * land in the 10 a.m. column of the counter that took them, so the hour is read
 * in local time exactly as `invoiceDate` was written in local time.
 */
function hourOf(createdAt: string): number {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return HOUR_OPEN
  const h = new Date(t).getHours()
  // Trading outside the plotted window folds into the end bars rather than
  // vanishing, so the chart still foots to the sales KPI.
  return Math.min(HOUR_CLOSE, Math.max(HOUR_OPEN, h))
}

export function computeDashboard(deps: DashboardDeps): DashboardData {
  const { medicines, batches, invoices, shortbook, heldBills, store, today } = deps
  const range = deps.range ?? 'today'
  const win = rangeWindow(today, range)

  // Everything below reads as at `today`, which `getDashboard(date)` lets the
  // caller choose. A bill dated after it must not surface in the trend or the
  // activity feed while every KPI beside them stops at `today`.
  const posted = invoices.filter((i) => i.status === 'POSTED' && i.invoiceDate <= today)
  const postedToday = posted.filter((i) => i.invoiceDate === today)
  const postedInPeriod = posted.filter((i) => i.invoiceDate >= win.start)

  const medById = new Map(medicines.map((m) => [m.id, m]))
  const nearExpiryWindow =
    store.nearExpiryBuckets.length > 0 ? Math.max(...store.nearExpiryBuckets) : 90

  // -- stock position ------------------------------------------------------
  const sellableQty = new Map<number, D.Decimal>()
  for (const b of batches) {
    if (!isSellable(b, today)) continue
    sellableQty.set(b.medicineId, D.add(sellableQty.get(b.medicineId) ?? D.ZERO, D.dec(b.qtyOnHand)))
  }

  const lowStockCandidates: Array<{ row: LowStockRow; shortfall: D.Decimal }> = []
  const atOrBelowReorder = new Set<number>()
  let outOfStock = 0

  for (const m of medicines) {
    // A delisted medicine has no reorder queue to be in. Telling the counter to
    // buy more of something the shop has stopped selling — and raising a standing
    // low-stock alert for it — is worse than saying nothing.
    if (!m.isActive) continue
    const onHand = sellableQty.get(m.id) ?? D.ZERO
    const reorder = D.dec(m.reorderLevel)
    if (D.lte(onHand, reorder)) atOrBelowReorder.add(m.id)
    if (D.isZero(onHand)) outOfStock += 1
    if (D.isZero(onHand) || D.gt(onHand, reorder)) continue

    // reorder > 0 here: onHand is positive and no greater than it.
    const shortfall = D.mul(D.div(D.sub(reorder, onHand), reorder), D.HUNDRED)
    lowStockCandidates.push({
      shortfall,
      row: {
        medicineId: m.id,
        brandName: m.brandName,
        packLabel: m.packLabel,
        qtyOnHand: qty(onHand),
        reorderLevel: m.reorderLevel,
        shortfallPct: D.toStr(shortfall, 2),
        rackLocation: m.rackLocation,
      },
    })
  }

  const lowStock = lowStockCandidates
    .sort((a, b) => D.cmp(b.shortfall, a.shortfall) || a.row.medicineId - b.row.medicineId)
    .slice(0, TOP_N)
    .map((c) => c.row)

  // -- inventory health ----------------------------------------------------
  // Priority expired > nearExpiry > lowStock > healthy, so a batch lands in
  // exactly one bucket and the four sum to totalBatches.
  const health: InventoryHealth = {
    healthy: 0,
    lowStock: 0,
    nearExpiry: 0,
    expired: 0,
    totalBatches: batches.length,
    valueAtRisk: '0.00',
  }
  let valueAtRisk = D.ZERO
  let nearExpiry30 = 0
  let expiredHoldingStock = 0

  for (const b of batches) {
    const holdsStock = D.gt(D.dec(b.qtyOnHand), D.ZERO)
    if (isExpired(b, today)) {
      health.expired += 1
      // Quarantined ones count too: an expired strip on the shelf is a write-off
      // whether or not it has already been blocked from sale.
      if (holdsStock) expiredHoldingStock += 1
      continue
    }
    const days = daysToExpiry(b, today)
    if (days <= nearExpiryWindow) {
      health.nearExpiry += 1
      valueAtRisk = D.add(valueAtRisk, D.mul(D.dec(b.qtyOnHand), D.dec(b.landedCostPerUnit)))
      if (days <= NEAR_EXPIRY_ATTENTION_DAYS && isSellable(b, today)) nearExpiry30 += 1
      continue
    }
    // A batch is "low stock" when the medicine it belongs to is at or below its
    // reorder level — the batch is fine, the shelf behind it is not.
    if (atOrBelowReorder.has(b.medicineId)) health.lowStock += 1
    else health.healthy += 1
  }
  health.valueAtRisk = money(valueAtRisk)

  // -- expiring ------------------------------------------------------------
  const expiring = fefoOrder(batches, today)
    .filter((b) => daysToExpiry(b, today) <= nearExpiryWindow)
    .flatMap<ExpiringBatchRow>((b) => {
      const med = medById.get(b.medicineId)
      if (!med) return []
      const onHand = D.dec(b.qtyOnHand)
      return [{
        batchId: b.id,
        medicineId: b.medicineId,
        brandName: med.brandName,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate,
        daysLeft: daysToExpiry(b, today),
        qtyOnHand: qty(onHand),
        valueAtMrp: money(D.mul(onHand, D.dec(b.mrpPerUnit))),
        valueAtCost: money(D.mul(onHand, D.dec(b.landedCostPerUnit))),
      }]
    })
    .slice(0, TOP_N)

  // -- KPIs ----------------------------------------------------------------
  const todayTotals = periodTotals(posted, win.start, win.end)
  const prevTotals = periodTotals(posted, win.prevStart, win.prevEnd)
  /* Receivables are a BALANCE, not a flow: the figure is what is owed as at the
     end of each window, never the credit taken inside it. A shop that collected
     an old debt this week has less outstanding, and a flow would show it as more. */
  const overdueNow = outstandingAsOf(posted, win.end)
  const overduePrev = outstandingAsOf(posted, win.prevEnd)

  const marginNow = marginPct(todayTotals.profit, todayTotals.taxable)
  const marginPrev = marginPct(prevTotals.profit, prevTotals.taxable)

  const kpis: DashboardKpis = {
    sales: kpi(money(todayTotals.sales), todayTotals.sales, prevTotals.sales, true),
    orders: kpi(
      countValue(todayTotals.orders),
      D.dec(todayTotals.orders),
      D.dec(prevTotals.orders),
      true,
    ),
    profit: kpi(money(todayTotals.profit), todayTotals.profit, prevTotals.profit, true),
    customers: kpi(
      countValue(todayTotals.customers),
      D.dec(todayTotals.customers),
      D.dec(prevTotals.customers),
      true,
    ),
    grossMarginPct: kpi(D.toStr(marginNow, 2), marginNow, marginPrev, true),
    // Rising receivables is bad news; the tile must colour the delta the other way.
    overdue: kpi(money(overdueNow), overdueNow, overduePrev, false),
  }

  const attention: AttentionCounts = {
    lowStock: lowStockCandidates.length,
    outOfStock,
    nearExpiry30,
    expired: expiredHoldingStock,
    heldBills: heldBills.length,
    /* Zero here, and filled in by the adapter from `api/attention` — the same
       rules the bell applies. Computing them a second time in this file is how
       the two would drift apart, and the dashboard is the copy people look at. */
    claimsUnsettled: 0,
    ordersOverdue: 0,
    dayUnclosed: 0,
    shortbook: shortbook.length,
  }

  // -- sales trend ---------------------------------------------------------
  const salesByMonth = new Map<string, D.Decimal>()
  for (const inv of posted) {
    const key = inv.invoiceDate.slice(0, 7)
    salesByMonth.set(key, D.add(salesByMonth.get(key) ?? D.ZERO, D.dec(inv.quote.netAmount)))
  }

  const anchor = monthOf(today)
  const months = Array.from({ length: TREND_MONTHS }, (_, i) =>
    shiftMonth(anchor, i - (TREND_MONTHS - 1)))
  const fyOf = months.map((ym) => financialYearLabel(ym, store.financialYearStartMonth))

  const seriesSeen: string[] = []
  for (const fy of fyOf) if (!seriesSeen.includes(fy)) seriesSeen.push(fy)
  const salesTrendSeries = seriesSeen.slice(-TREND_SERIES_MAX)

  const salesTrend: TrendPoint[] = months.map((ym, i) => {
    const amount = salesByMonth.get(monthKey(ym)) ?? D.ZERO
    const values: Record<string, Money> = {}
    // Every series gets a key on every point: a grouped bar with a missing key
    // silently drops a bar and shifts the axis.
    for (const key of salesTrendSeries) values[key] = key === fyOf[i] ? money(amount) : '0.00'
    return { label: MONTH_LABELS[ym.month - 1] ?? monthKey(ym), values }
  })

  // -- today by hour -------------------------------------------------------
  const byHour = new Map<number, D.Decimal>()
  for (const inv of postedToday) {
    const h = hourOf(inv.createdAt)
    byHour.set(h, D.add(byHour.get(h) ?? D.ZERO, D.dec(inv.quote.netAmount)))
  }
  const todayByHour: TrendPoint[] = Array.from(
    { length: HOUR_CLOSE - HOUR_OPEN + 1 },
    (_, i) => {
      const h = HOUR_OPEN + i
      return { label: `${pad2(h)}:00`, values: { sales: money(byHour.get(h) ?? D.ZERO) } }
    },
  )

  /* -- the selected period's shape ----------------------------------------
     A single day is read hour by hour, because the question inside a day is
     "when is the counter busy". A longer window is read day by day: 30 days of
     hourly buckets is 720 points, and nobody has ever asked what 3 p.m. on a
     Tuesday three weeks ago took. Every day in the window gets a point even when
     it took nothing — a shop that was shut on Sunday must show a gap rather than
     silently closing it and drawing a straight line through the week. */
  const periodTrend: TrendPoint[] = win.days === 1
    ? todayByHour
    : (() => {
      const byDay = new Map<string, D.Decimal>()
      for (const inv of postedInPeriod) {
        byDay.set(inv.invoiceDate, D.add(byDay.get(inv.invoiceDate) ?? D.ZERO, D.dec(inv.quote.netAmount)))
      }
      return Array.from({ length: win.days }, (_, i) => {
        const date = addDays(win.start, i)
        const ym = monthOf(date)
        return {
          label: `${date.slice(8, 10)} ${MONTH_LABELS[ym.month - 1] ?? ''}`,
          values: { sales: money(byDay.get(date) ?? D.ZERO) },
        }
      })
    })()

  // -- top medicines -------------------------------------------------------
  const windowStart = addDays(today, -29)
  const unitsSold = new Map<number, D.Decimal>()
  const revenue = new Map<number, D.Decimal>()
  for (const inv of posted) {
    if (inv.invoiceDate < windowStart || inv.invoiceDate > today) continue
    for (const line of inv.quote.lines) {
      unitsSold.set(
        line.medicineId,
        D.add(unitsSold.get(line.medicineId) ?? D.ZERO, D.dec(line.allocatedQty)),
      )
      revenue.set(
        line.medicineId,
        D.add(revenue.get(line.medicineId) ?? D.ZERO, D.dec(line.lineTotal)),
      )
    }
  }

  /*
   * Ranked by REVENUE, not by units.
   *
   * Units are base units, and base units are not comparable across pack shapes:
   * one 100-tablet bottle of Thyronorm scores 100 while a 10-tablet strip scores
   * 10, so a units ranking is really a ranking of pack size. Revenue is the only
   * comparator that means the same thing for a strip, a bottle and a vial.
   */
  const topMedicines = [...unitsSold.entries()]
    .sort((a, b) => {
      const ra = revenue.get(a[0]) ?? D.ZERO
      const rb = revenue.get(b[0]) ?? D.ZERO
      return D.cmp(rb, ra) || a[0] - b[0]
    })
    .flatMap<TopMedicineRow>(([medicineId, units]) => {
      const med = medById.get(medicineId)
      if (!med) return []
      return [{
        medicineId,
        brandName: med.brandName,
        packLabel: med.packLabel,
        unitsSold: qty(units),
        revenue: money(revenue.get(medicineId) ?? D.ZERO),
        qtyOnHand: qty(sellableQty.get(medicineId) ?? D.ZERO),
      }]
    })
    .slice(0, TOP_N)

  // -- activity ------------------------------------------------------------
  // Alerts are a standing condition rather than an event, so they are stamped at
  // the start of the day: below today's trading, above yesterday's.
  const dayStart = startOfLocalDay(today)
  const activity: ActivityRow[] = [
    ...posted.map((inv): ActivityRow => ({
      id: `sale:${inv.id}`,
      kind: 'SALE',
      title: 'Sale completed',
      detail: inv.invoiceNo,
      at: inv.createdAt,
      amount: inv.quote.netAmount,
    })),
    ...shortbook.map((s): ActivityRow => ({
      id: `shortbook:${s.at}:${s.medicineId ?? s.term}`,
      kind: 'SHORTBOOK',
      title: 'Added to short book',
      detail: s.term,
      at: s.at,
      amount: null,
    })),
    ...lowStock.slice(0, ALERTS_N).map((r): ActivityRow => ({
      id: `low-stock:${r.medicineId}`,
      kind: 'LOW_STOCK',
      title: 'Low stock',
      detail: `${r.brandName} — ${r.qtyOnHand} left, reorder at ${r.reorderLevel}`,
      at: dayStart,
      amount: null,
    })),
    ...expiring.slice(0, ALERTS_N).map((r): ActivityRow => ({
      id: `expiry:${r.batchId}`,
      kind: 'EXPIRY',
      title: 'Batch nearing expiry',
      detail: `${r.brandName} ${r.batchNo} — ${r.daysLeft} days left`,
      at: dayStart,
      amount: null,
    })),
  ]
    .sort((a, b) => instant(b.at) - instant(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ACTIVITY_N)

  return {
    date: today,
    range,
    periodStart: win.start,
    periodEnd: win.end,
    comparedTo: win.comparedTo,
    kpis,
    attention,
    categoryMix: categoryMix(postedInPeriod),
    inventoryHealth: health,
    salesTrend,
    salesTrendSeries,
    todayByHour,
    periodTrend,
    topMovers: computeMovers(posted, medById, win),
    /* Empty here, and filled in by the adapter — the same split the three newer
       attention queues use. This function is deliberately handed ONE branch's
       rows, and a cross-branch view computed from them would be a comparison of
       a shop against itself. */
    branches: [],
    expiring,
    lowStock,
    topMedicines,
    activity,
  }
}
