import type { IsoDate, Money, PurchaseInvoice, Qty, Supplier, SupplierReturn } from '@contract'
import * as D from '@/domain/decimal'
import { daysUntil } from '@/lib/format'

/**
 * Everything the suppliers screen KNOWS, with nothing it draws.
 *
 * All of it is a fold over two things the screen already has in memory — the
 * distributor master and one window of the purchase register — because there is
 * no per-supplier purchase call in the contract and asking for one per selection
 * would make arrowing down the list N+1 round trips for numbers already loaded.
 *
 * Pure and clock-injected throughout, so every one of these is testable without
 * a DOM and none of them can disagree with the screen that renders them.
 */

// ------------------------------------------------------------------ money ---

const DECIMALISH = /^-?\d+(\.\d+)?$/

/**
 * `D.dec` throws on anything that is not a decimal string, which is right for
 * arithmetic and wrong for a screen that must still render a half-migrated row.
 * Everything below treats an unreadable amount as absent, never as zero: a
 * confident ₹0.00 payable is the one wrong answer a buyer would act on.
 */
export function money(v: string | null | undefined): D.Decimal | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return DECIMALISH.test(t) ? D.dec(t) : null
}

/** Whole days since a bill was raised. Null when the date is unreadable. */
export function ageInDays(iso: IsoDate, today: Date): number | null {
  const d = daysUntil(iso, today)
  return Number.isFinite(d) ? -d : null
}

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function addDays(iso: IsoDate, days: number): IsoDate | null {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

/** The unpaid remainder of one bill, or null when it is cancelled or unreadable. */
function balanceOf(inv: PurchaseInvoice): D.Decimal | null {
  if (inv.status !== 'POSTED') return null
  const net = money(inv.netAmount)
  if (!net) return null
  return D.sub(net, money(inv.amountPaid) ?? D.ZERO)
}

// ----------------------------------------------------------------- ageing ---

export type AgeingKey = 'b30' | 'b60' | 'b90' | 'b90p'

export interface AgeingBucket {
  key: AgeingKey
  /** Spelled out. The bar carries severity; the word carries the meaning. */
  label: string
  short: string
  tone: string
  amount: Money
  count: number
}

export interface Ageing {
  /** Always four, always in age order, even when every one of them is zero. */
  buckets: AgeingBucket[]
  /** Sum of the buckets — what is owed on bills inside the loaded window. */
  onBills: Money
  /** The adapter's figure. Authoritative; the buckets explain it, not replace it. */
  outstanding: Money
  /**
   * `outstanding` − `onBills`, when the two disagree.
   *
   * Positive means bills older than the loaded window, or an opening balance
   * carried in from the previous software. Negative means money paid that is
   * not sitting against any bill here — an advance, or a credit note for
   * expiry that has not been adjusted yet. Either way it is shown rather than
   * absorbed, because a stacked bar that silently fails to add up to the total
   * printed beside it is how a screen loses its reader for good.
   */
  unallocated: Money | null
  /** Past this supplier's own credit days, not past a bucket boundary. */
  overdue: Money
  overdueCount: number
  oldestDays: number | null
  openCount: number
}

interface BucketSpec {
  key: AgeingKey
  label: string
  short: string
  tone: string
  /** Inclusive upper bound in days; null closes the series. */
  upTo: number | null
}

/* Green → amber → orange → red, in one direction. Every segment is also
   labelled in the panel below the bar, so the ramp is a reinforcement and never
   the only carrier of the meaning. */
const BUCKET_SPECS: BucketSpec[] = [
  { key: 'b30', label: '0–30 days', short: '0–30', tone: 'var(--success-11)', upTo: 30 },
  { key: 'b60', label: '31–60 days', short: '31–60', tone: 'var(--warning-11)', upTo: 60 },
  { key: 'b90', label: '61–90 days', short: '61–90', tone: 'var(--status-expiry-60)', upTo: 90 },
  { key: 'b90p', label: 'Over 90 days', short: '90+', tone: 'var(--danger-11)', upTo: null },
]

/** A stable identity, so a supplier with no bills does not remount the sheet. */
export const EMPTY_INVOICES: readonly PurchaseInvoice[] = []

/** Clamped at zero: a negative figure on a half-migrated row would make every
 *  bill raised today already late, a louder wrong answer than "cash". */
export function termsOf(supplier: Supplier): number {
  return Number.isFinite(supplier.paymentTermsDays) ? Math.max(0, supplier.paymentTermsDays) : 0
}

/**
 * Bill-wise ageing of one supplier's payable.
 *
 * Bucketed on the INVOICE date, which is the convention every Indian
 * outstanding report uses, while `overdue` is measured against the supplier's
 * own credit days — the two answer different questions and a screen that
 * conflates them tells a shop with 45-day terms that everything is late.
 *
 * A cancelled bill owes nothing. A bill paid in full or overpaid contributes no
 * bucket; the overpayment surfaces through `unallocated` instead, where it can
 * be read as the advance it is.
 */
export function ageingOf(
  supplier: Supplier,
  invoices: readonly PurchaseInvoice[],
  today: Date,
): Ageing {
  const totals = BUCKET_SPECS.map(() => ({ amount: D.ZERO, count: 0 }))
  let overdue = D.ZERO
  let overdueCount = 0
  let oldestDays: number | null = null
  let openCount = 0

  const terms = termsOf(supplier)

  for (const inv of invoices) {
    const balance = balanceOf(inv)
    if (!balance || !D.gt(balance, D.ZERO)) continue

    const age = ageInDays(inv.invoiceDate, today)
    if (age === null) continue

    openCount += 1
    if (oldestDays === null || age > oldestDays) oldestDays = age

    const found = BUCKET_SPECS.findIndex((b) => b.upTo !== null && age <= b.upTo)
    const slot = totals[found === -1 ? totals.length - 1 : found]
    if (slot) {
      slot.amount = D.add(slot.amount, balance)
      slot.count += 1
    }

    if (age > terms) {
      overdue = D.add(overdue, balance)
      overdueCount += 1
    }
  }

  const onBills = D.sum(totals.map((t) => t.amount))
  const stated = money(supplier.outstanding)
  const gap = stated ? D.sub(stated, onBills) : null

  return {
    buckets: BUCKET_SPECS.map((spec, i) => ({
      key: spec.key,
      label: spec.label,
      short: spec.short,
      tone: spec.tone,
      amount: D.toStr(totals[i]?.amount ?? D.ZERO, 2),
      count: totals[i]?.count ?? 0,
    })),
    onBills: D.toStr(onBills, 2),
    outstanding: stated ? D.toStr(stated, 2) : supplier.outstanding,
    unallocated: gap && !D.isZero(gap) ? D.toStr(gap, 2) : null,
    overdue: D.toStr(overdue, 2),
    overdueCount,
    oldestDays,
    openCount,
  }
}

/**
 * The whole book, aged.
 *
 * Folded from the per-supplier results rather than recomputed over every bill,
 * so the total on the header bar and the four numbers under it are provably the
 * same arithmetic the rows show — a summary that can disagree with the list it
 * summarises is the fastest way to lose a screen's credibility.
 *
 * `unallocated` stays null unless at least one supplier had one: a book where
 * every balance ties to a loaded bill should say nothing rather than say zero.
 */
export function mergeAgeing(parts: readonly Ageing[]): Ageing {
  const amounts = BUCKET_SPECS.map(() => ({ amount: D.ZERO, count: 0 }))
  let onBills = D.ZERO
  let outstanding = D.ZERO
  let unallocated = D.ZERO
  let anyUnallocated = false
  let overdue = D.ZERO
  let overdueCount = 0
  let oldestDays: number | null = null
  let openCount = 0

  for (const part of parts) {
    part.buckets.forEach((b, i) => {
      const slot = amounts[i]
      const value = money(b.amount)
      if (!slot || !value) return
      slot.amount = D.add(slot.amount, value)
      slot.count += b.count
    })
    onBills = D.add(onBills, money(part.onBills) ?? D.ZERO)
    outstanding = D.add(outstanding, money(part.outstanding) ?? D.ZERO)
    if (part.unallocated) {
      anyUnallocated = true
      unallocated = D.add(unallocated, money(part.unallocated) ?? D.ZERO)
    }
    overdue = D.add(overdue, money(part.overdue) ?? D.ZERO)
    overdueCount += part.overdueCount
    openCount += part.openCount
    if (part.oldestDays !== null && (oldestDays === null || part.oldestDays > oldestDays)) {
      oldestDays = part.oldestDays
    }
  }

  return {
    buckets: BUCKET_SPECS.map((spec, i) => ({
      key: spec.key,
      label: spec.label,
      short: spec.short,
      tone: spec.tone,
      amount: D.toStr(amounts[i]?.amount ?? D.ZERO, 2),
      count: amounts[i]?.count ?? 0,
    })),
    onBills: D.toStr(onBills, 2),
    outstanding: D.toStr(outstanding, 2),
    unallocated: anyUnallocated ? D.toStr(unallocated, 2) : null,
    overdue: D.toStr(overdue, 2),
    overdueCount,
    oldestDays,
    openCount,
  }
}

// ---------------------------------------------------------------- licence ---

export type LicenceKey = 'missing' | 'undated' | 'lapsed' | 'expiring' | 'valid'

export interface LicenceState {
  key: LicenceKey
  /** The word, always. Colour never carries a status on its own here. */
  label: string
  tone: string
  /** Days until it lapses; negative once it has. Null when there is no date. */
  days: number | null
}

/**
 * A wholesale drug licence is renewed, and the renewal is missed.
 *
 * Form 20B/21B runs five years, and the distributor's own lapse becomes the
 * BUYING shop's problem: stock received on a bill from a licence that was not
 * live on that date has no lawful source, and it is the receiver's register the
 * inspector reads. Every supplier master ships the licence NUMBER and almost
 * none of them ship the date it dies, which is why the number alone has never
 * once prevented this.
 *
 * Sixty days is the warning, not thirty: a renewal moves through a state
 * licensing authority, and a month is not enough notice to chase a distributor
 * for a copy of the new certificate before the next delivery.
 */
export const LICENCE_WARN_DAYS = 60

export function licenceState(supplier: Supplier, today: Date): LicenceState {
  if (!supplier.dlNo) {
    return { key: 'missing', label: 'No licence on file', tone: 'var(--danger-11)', days: null }
  }
  const validUpto = supplier.dlValidUpto ?? null
  if (!validUpto) {
    return { key: 'undated', label: 'Validity not recorded', tone: 'var(--fg-muted)', days: null }
  }
  const days = daysUntil(validUpto, today)
  if (!Number.isFinite(days)) {
    return { key: 'undated', label: 'Validity not recorded', tone: 'var(--fg-muted)', days: null }
  }
  if (days < 0) {
    return { key: 'lapsed', label: `Lapsed ${-days}d ago`, tone: 'var(--danger-11)', days }
  }
  if (days <= LICENCE_WARN_DAYS) {
    return {
      key: 'expiring',
      label: days === 0 ? 'Lapses today' : `Lapses in ${days}d`,
      tone: 'var(--warning-11)',
      days,
    }
  }
  return { key: 'valid', label: 'Licence valid', tone: 'var(--success-11)', days }
}

/** The three states a buyer has to do something about. */
export function licenceNeedsAction(state: LicenceState): boolean {
  return state.key === 'missing' || state.key === 'lapsed' || state.key === 'expiring'
}

// --------------------------------------------------------- payment planner ---

export type DueBucketKey = 'overdue' | 'today' | 'week' | 'fortnight' | 'later'

export interface DueBucketSpec {
  key: DueBucketKey
  label: string
  /** What the number under the heading means, in a buyer's words. */
  note: string
  tone: string
}

/* Ordered by when the money leaves, which is the only order a payment run is
   ever built in. "Later" closes the series so nothing open is invisible. */
/* Labels stay SHORT — two words at most — because they sit in a five-column
   strip that is 133px wide at the 1366 floor, and a heading that wraps to three
   lines there is worse than a heading that says less. The sentence lives in
   `note`, which has the room. "Past terms" is also the ledger's own word for
   this, and one screen must not have two names for one state. */
export const DUE_BUCKETS: readonly DueBucketSpec[] = [
  { key: 'overdue', label: 'Past terms', note: 'Supply is at risk on these', tone: 'var(--danger-11)' },
  { key: 'today', label: 'Due today', note: 'Release before the day ends', tone: 'var(--status-expiry-60)' },
  { key: 'week', label: 'Within 7 days', note: 'This week’s cheque run', tone: 'var(--warning-11)' },
  { key: 'fortnight', label: 'In 8–14 days', note: 'Next week, plan the cash', tone: 'var(--info-11)' },
  { key: 'later', label: 'Later', note: 'Nothing to do yet', tone: 'var(--fg-subtle)' },
]

export interface DueBill {
  purchaseId: number
  purchaseNo: string
  supplierInvoiceNo: string
  supplierId: number
  supplierName: string
  invoiceDate: IsoDate
  /** Bill date plus the supplier's own credit days. */
  dueOn: IsoDate
  /** Negative once the due date is past. */
  daysToDue: number
  termsDays: number
  balance: Money
  bucket: DueBucketKey
  /**
   * Every balance up to and including this bill, in due order.
   *
   * The one number a buyer actually wants from a payables list: "if I release
   * this much, everything down to here is clear." A per-row amount cannot
   * answer it and a grand total answers a question nobody asked.
   */
  cumulative: Money
}

export interface PaymentPlan {
  bills: DueBill[]
  /** Keyed by bucket, in `DUE_BUCKETS` order. */
  totals: Array<{ spec: DueBucketSpec; amount: Money; count: number }>
  /** Overdue + today + the next seven days: the cheque run being written now. */
  dueThisWeek: Money
  dueThisWeekCount: number
  overdue: Money
  overdueCount: number
  /** Distinct suppliers with something due inside the week. */
  suppliersThisWeek: number
  total: Money
}

function bucketFor(daysToDue: number): DueBucketKey {
  if (daysToDue < 0) return 'overdue'
  if (daysToDue === 0) return 'today'
  if (daysToDue <= 7) return 'week'
  if (daysToDue <= 14) return 'fortnight'
  return 'later'
}

const WEEK_BUCKETS = new Set<DueBucketKey>(['overdue', 'today', 'week'])

/**
 * Every open bill in the window, in the order the money has to leave.
 *
 * The due date is computed per bill from the SUPPLIER'S terms rather than from a
 * shop-wide default, because that is the whole point of recording terms: a
 * 45-day distributor and a cash trader do not belong in the same week's run just
 * because their bills are the same age.
 */
export function buildPaymentPlan(
  entries: ReadonlyArray<{ supplier: Supplier; invoices: readonly PurchaseInvoice[] }>,
  today: Date,
): PaymentPlan {
  const bills: DueBill[] = []

  for (const { supplier, invoices } of entries) {
    const terms = termsOf(supplier)
    for (const inv of invoices) {
      const balance = balanceOf(inv)
      if (!balance || !D.gt(balance, D.ZERO)) continue
      const dueOn = addDays(inv.invoiceDate, terms)
      if (dueOn === null) continue
      const daysToDue = daysUntil(dueOn, today)
      if (!Number.isFinite(daysToDue)) continue

      bills.push({
        purchaseId: inv.id,
        purchaseNo: inv.purchaseNo,
        supplierInvoiceNo: inv.supplierInvoiceNo,
        supplierId: supplier.id,
        supplierName: supplier.name,
        invoiceDate: inv.invoiceDate,
        dueOn,
        daysToDue,
        termsDays: terms,
        balance: D.toStr(balance, 2),
        bucket: bucketFor(daysToDue),
        cumulative: '0.00',
      })
    }
  }

  /* Soonest first; the larger bill first within a day, because that is the one a
     buyer releases when the day's cash only covers part of it. The id closes the
     sort so two identical bills never swap places between renders. */
  bills.sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn)
      || D.cmp(money(b.balance) ?? D.ZERO, money(a.balance) ?? D.ZERO)
      || a.purchaseId - b.purchaseId,
  )

  let running = D.ZERO
  const perBucket = new Map<DueBucketKey, { amount: D.Decimal; count: number }>()
  const weekSuppliers = new Set<number>()
  let week = D.ZERO
  let weekCount = 0
  let overdue = D.ZERO
  let overdueCount = 0

  for (const bill of bills) {
    const value = money(bill.balance) ?? D.ZERO
    running = D.add(running, value)
    bill.cumulative = D.toStr(running, 2)

    const slot = perBucket.get(bill.bucket) ?? { amount: D.ZERO, count: 0 }
    slot.amount = D.add(slot.amount, value)
    slot.count += 1
    perBucket.set(bill.bucket, slot)

    if (WEEK_BUCKETS.has(bill.bucket)) {
      week = D.add(week, value)
      weekCount += 1
      weekSuppliers.add(bill.supplierId)
    }
    if (bill.bucket === 'overdue') {
      overdue = D.add(overdue, value)
      overdueCount += 1
    }
  }

  return {
    bills,
    totals: DUE_BUCKETS.map((spec) => {
      const slot = perBucket.get(spec.key)
      return {
        spec,
        amount: D.toStr(slot?.amount ?? D.ZERO, 2),
        count: slot?.count ?? 0,
      }
    }),
    dueThisWeek: D.toStr(week, 2),
    dueThisWeekCount: weekCount,
    overdue: D.toStr(overdue, 2),
    overdueCount,
    suppliersThisWeek: weekSuppliers.size,
    total: D.toStr(running, 2),
  }
}

export interface SupplierDue {
  supplierId: number
  supplierName: string
  /** Every open bill of his, still in due order. */
  bills: DueBill[]
  total: Money
  /** The soonest of his due dates — where the whole group sorts. */
  dueOn: IsoDate
  daysToDue: number
  /** How much of his total is already past terms. */
  overdue: Money
  bucket: DueBucketKey
}

/**
 * The same plan, one row per distributor.
 *
 * A cheque is written to a supplier, not to an invoice — so the bill-wise list
 * is the working and this is the instruction. Grouping keeps the bills inside
 * the row rather than summarising them away, because the man being paid will
 * ask which bills it covers and the answer has to be on the same screen.
 */
export function groupPlanBySupplier(bills: readonly DueBill[]): SupplierDue[] {
  const groups = new Map<number, SupplierDue>()

  for (const bill of bills) {
    const held = groups.get(bill.supplierId)
    if (!held) {
      groups.set(bill.supplierId, {
        supplierId: bill.supplierId,
        supplierName: bill.supplierName,
        bills: [bill],
        total: bill.balance,
        dueOn: bill.dueOn,
        daysToDue: bill.daysToDue,
        overdue: bill.bucket === 'overdue' ? bill.balance : '0.00',
        bucket: bill.bucket,
      })
      continue
    }
    held.bills.push(bill)
    held.total = D.toStr(D.add(money(held.total) ?? D.ZERO, money(bill.balance) ?? D.ZERO), 2)
    if (bill.bucket === 'overdue') {
      held.overdue = D.toStr(D.add(money(held.overdue) ?? D.ZERO, money(bill.balance) ?? D.ZERO), 2)
    }
    /* The group takes its urgency from its SOONEST bill. A supplier with one
       bill three months late and four due next month is a supplier to pay now,
       and an average or a latest date would hide that. */
    if (bill.dueOn < held.dueOn) {
      held.dueOn = bill.dueOn
      held.daysToDue = bill.daysToDue
      held.bucket = bill.bucket
    }
  }

  return [...groups.values()].sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn)
      || D.cmp(money(b.total) ?? D.ZERO, money(a.total) ?? D.ZERO)
      || a.supplierId - b.supplierId,
  )
}

/** What a ticked set of bills adds up to, and who it has to be paid to. */
export function selectionTotal(
  bills: readonly DueBill[],
  picked: ReadonlySet<number>,
): { amount: Money; count: number; suppliers: number } {
  let amount = D.ZERO
  let count = 0
  const suppliers = new Set<number>()
  for (const bill of bills) {
    if (!picked.has(bill.purchaseId)) continue
    amount = D.add(amount, money(bill.balance) ?? D.ZERO)
    count += 1
    suppliers.add(bill.supplierId)
  }
  return { amount: D.toStr(amount, 2), count, suppliers: suppliers.size }
}

// ----------------------------------------------------------- rate history ---

export interface RatePoint {
  purchaseId: number
  purchaseNo: string
  supplierInvoiceNo: string
  at: IsoDate
  ratePerPack: Money
  mrpPerPack: Money
  landedCostPerUnit: Money
  qtyPacks: Qty
  freePacks: Qty
}

export interface RateRow {
  medicineId: number
  brandName: string
  packLabel: string
  latest: RatePoint
  /** The purchase before it — not the last DIFFERENT rate. "Held" is news too. */
  previous: RatePoint | null
  /** Signed, one decimal place. Null when there is nothing to compare against. */
  changePct: string | null
  points: RatePoint[]
}

export function pctChange(from: D.Decimal, to: D.Decimal): string | null {
  if (D.isZero(from) || D.isNeg(from)) return null
  return D.toStr(D.mul(D.div(D.sub(to, from), from), D.HUNDRED), 1)
}

/**
 * What this supplier has charged, per medicine, newest first.
 *
 * This is the single number Marg reaches for with `Alt+L` ("last deal") and
 * `F6` ("old purchase rate") mid-entry, and the reason both keys exist is that
 * a distributor's rate moves quietly and nobody remembers last month's. Showing
 * the change against the previous purchase is what turns a price list into a
 * negotiating position.
 */
export function rateHistory(invoices: readonly PurchaseInvoice[]): RateRow[] {
  const byMedicine = new Map<number, { brandName: string; packLabel: string; points: RatePoint[] }>()

  for (const inv of invoices) {
    if (inv.status !== 'POSTED') continue
    for (const line of inv.lines) {
      const bucket = byMedicine.get(line.medicineId) ?? {
        brandName: line.brandName,
        packLabel: line.packLabel,
        points: [],
      }
      bucket.points.push({
        purchaseId: inv.id,
        purchaseNo: inv.purchaseNo,
        supplierInvoiceNo: inv.supplierInvoiceNo,
        at: inv.invoiceDate,
        ratePerPack: line.ratePerPack,
        mrpPerPack: line.mrpPerPack,
        landedCostPerUnit: line.landedCostPerUnit,
        qtyPacks: line.qtyPacks,
        freePacks: line.freePacks,
      })
      byMedicine.set(line.medicineId, bucket)
    }
  }

  const rows: RateRow[] = []
  for (const [medicineId, bucket] of byMedicine) {
    /* Newest first, and the id breaks the tie: two bills keyed on one day under
       an unstable sort would swap "latest" and "previous" between renders, and
       the change percentage would flip sign on its own. */
    const points = [...bucket.points].sort(
      (a, b) => b.at.localeCompare(a.at) || b.purchaseId - a.purchaseId,
    )
    const latest = points[0]
    if (!latest) continue
    /* The previous PURCHASE, not the previous line. One bill routinely carries
       the same medicine twice — two batches, or two MRPs — and those two lines
       sort adjacent (same date, same id, stable order). Taking points[1] would
       then price a bill against itself and print a change percentage for a rate
       that never moved. */
    const previous = points.find((p) => p.purchaseId !== latest.purchaseId) ?? null
    const from = previous ? money(previous.ratePerPack) : null
    const to = money(latest.ratePerPack)
    rows.push({
      medicineId,
      brandName: bucket.brandName,
      packLabel: bucket.packLabel,
      latest,
      previous,
      changePct: from && to ? pctChange(from, to) : null,
      points,
    })
  }

  return rows.sort(
    (a, b) => b.latest.at.localeCompare(a.latest.at)
      || a.brandName.localeCompare(b.brandName)
      || a.medicineId - b.medicineId,
  )
}

// ------------------------------------------------- cross-supplier compare ---

export interface SupplierQuote {
  supplierId: number
  supplierName: string
  at: IsoDate
  purchaseId: number
  purchaseNo: string
  supplierInvoiceNo: string
  /** The rate on his bill — the number the two of you argue about. */
  ratePerPack: Money
  mrpPerPack: Money
  /**
   * Landed cost per pack: freight apportioned in, free goods divided through.
   *
   * The comparison is made on THIS and not on the printed rate, because a
   * distributor who wins on rate and loses on the scheme is the commonest way a
   * "cheaper" supplier is more expensive. Packs of one medicine hold the same
   * number of units whoever supplies them, so per-pack landed cost is directly
   * comparable across suppliers in the unit a buyer thinks in.
   */
  landedPerPack: Money
  freePacks: Qty
  /** Paid + free, as received on that bill. */
  packsReceived: Qty
}

export interface CompareRow {
  medicineId: number
  brandName: string
  packLabel: string
  /** Cheapest landed cost first. Always at least two — see `rateBoard`. */
  quotes: SupplierQuote[]
  best: SupplierQuote
  worst: SupplierQuote
  /** worst − best, per pack. */
  spread: Money
  /** Signed against the best, one decimal. Null when the best is unusable. */
  spreadPct: string | null
  packsReceived: Qty
  /**
   * What the window cost above the best landed rate on offer.
   *
   * Not a projection and not a promise: it is arithmetic on bills already
   * received — every pack bought from anyone dearer than the cheapest quote,
   * times the difference. It is the number that makes a buyer pick up a phone.
   */
  overpaid: Money
}

/**
 * The same medicine, priced across every distributor who has supplied it.
 *
 * A per-supplier rate history answers "is he charging me more than last time".
 * It cannot answer "is he charging me more than the other one", which is the
 * question that actually moves money in a trade where two distributors carry
 * the same brand at rates that differ by four percent and neither volunteers it.
 *
 * Only medicines with TWO OR MORE suppliers appear: a single-source row has no
 * comparison in it, and padding the board with them buries the ones that do.
 */
export function rateBoard(
  invoices: readonly PurchaseInvoice[],
  today: Date,
  windowDays = 365,
): CompareRow[] {
  interface Bucket {
    brandName: string
    packLabel: string
    /** Latest quote per supplier — a rate from March is not today's position. */
    bySupplier: Map<number, SupplierQuote>
    /** Every line in the window, for the overpaid arithmetic. */
    lines: Array<{ landedPerPack: D.Decimal; packs: D.Decimal }>
    packs: D.Decimal
  }

  const byMedicine = new Map<number, Bucket>()

  for (const inv of invoices) {
    if (inv.status !== 'POSTED') continue
    const age = ageInDays(inv.invoiceDate, today)
    if (age === null || age > windowDays) continue

    for (const line of inv.lines) {
      const qty = money(line.qtyPacks)
      const free = money(line.freePacks) ?? D.ZERO
      const unitCost = money(line.landedCostPerUnit)
      if (!qty || !unitCost || !Number.isFinite(line.unitsPerPack) || line.unitsPerPack <= 0) continue

      const packs = D.add(qty, free)
      if (!D.gt(packs, D.ZERO)) continue
      const landedPerPack = D.mul(unitCost, D.dec(line.unitsPerPack))

      const bucket = byMedicine.get(line.medicineId) ?? {
        brandName: line.brandName,
        packLabel: line.packLabel,
        bySupplier: new Map<number, SupplierQuote>(),
        lines: [],
        packs: D.ZERO,
      }

      const held = bucket.bySupplier.get(inv.supplierId)
      /* Newest bill wins, the purchase id breaking a same-day tie — the same
         rule the per-supplier history uses, so the two screens never disagree
         about which bill is this distributor's current rate.
         ONE bill routinely carries the same medicine twice, on two batches or
         two MRPs. Between those the cheaper line is kept: it is a rate this
         distributor demonstrably quoted, and holding him to his own best number
         is the only defensible way to pick one of the two. */
      const sameBill = held !== undefined && held.purchaseId === inv.id
      const newer = !held
        || (sameBill
          ? D.lt(landedPerPack, money(held.landedPerPack) ?? D.ZERO)
          : inv.invoiceDate > held.at
            || (inv.invoiceDate === held.at && inv.id > held.purchaseId))
      if (newer) {
        bucket.bySupplier.set(inv.supplierId, {
          supplierId: inv.supplierId,
          supplierName: inv.supplierName,
          at: inv.invoiceDate,
          purchaseId: inv.id,
          purchaseNo: inv.purchaseNo,
          supplierInvoiceNo: inv.supplierInvoiceNo,
          ratePerPack: line.ratePerPack,
          mrpPerPack: line.mrpPerPack,
          landedPerPack: D.toStr(landedPerPack, 4),
          freePacks: line.freePacks,
          packsReceived: D.toStr(packs, 3),
        })
      }

      bucket.lines.push({ landedPerPack, packs })
      bucket.packs = D.add(bucket.packs, packs)
      byMedicine.set(line.medicineId, bucket)
    }
  }

  const rows: CompareRow[] = []
  for (const [medicineId, bucket] of byMedicine) {
    if (bucket.bySupplier.size < 2) continue

    const quotes = [...bucket.bySupplier.values()].sort(
      (a, b) => D.cmp(money(a.landedPerPack) ?? D.ZERO, money(b.landedPerPack) ?? D.ZERO)
        || a.supplierName.localeCompare(b.supplierName),
    )
    const best = quotes[0]
    const worst = quotes[quotes.length - 1]
    if (!best || !worst) continue

    const bestCost = money(best.landedPerPack) ?? D.ZERO
    const worstCost = money(worst.landedPerPack) ?? D.ZERO

    let overpaid = D.ZERO
    for (const line of bucket.lines) {
      const over = D.sub(line.landedPerPack, bestCost)
      if (D.gt(over, D.ZERO)) overpaid = D.add(overpaid, D.mul(over, line.packs))
    }

    rows.push({
      medicineId,
      brandName: bucket.brandName,
      packLabel: bucket.packLabel,
      quotes,
      best,
      worst,
      spread: D.toStr(D.sub(worstCost, bestCost), 2),
      spreadPct: D.gt(bestCost, D.ZERO) ? pctChange(bestCost, worstCost) : null,
      packsReceived: D.toStr(bucket.packs, 3),
      overpaid: D.toStr(overpaid, 2),
    })
  }

  /* Biggest recoverable amount first: the board is a work queue, not a
     catalogue, and a buyer works down it until the savings stop being worth a
     phone call. Name breaks the tie so the order is stable. */
  return rows.sort(
    (a, b) => D.cmp(money(b.overpaid) ?? D.ZERO, money(a.overpaid) ?? D.ZERO)
      || a.brandName.localeCompare(b.brandName)
      || a.medicineId - b.medicineId,
  )
}

/** What working the whole board down to the best quote would have been worth. */
export function boardSavings(rows: readonly CompareRow[]): Money {
  return D.toStr(D.sum(rows.map((r) => money(r.overpaid) ?? D.ZERO)), 2)
}

// ------------------------------------------------------ returns and claims ---

export interface ReturnsPosition {
  /** Debit notes: already off what this supplier is owed. */
  debitNotes: Money
  debitNoteCount: number
  /** Expiry claims raised, at claim value. */
  claimed: Money
  claimCount: number
  /** Credit actually received against those claims. */
  received: Money
  /** Claims with no credit note against them yet. */
  awaiting: Money
  awaitingCount: number
  /**
   * Claim value settled short.
   *
   * A manufacturer settles net of a breakage allowance, and the difference is
   * real money the shop either recovers or writes off. It has to be a number of
   * its own or it disappears into "the claim was settled".
   */
  shortfall: Money
  oldestAwaitingDays: number | null
}

/**
 * Debit notes and expiry claims raised against one distributor.
 *
 * The two are NOT summed together, and that is the whole point. A debit note is
 * already adjusted against his bill — the payable on this screen is net of it.
 * An expiry claim is a fresh outward invoice from this shop that he has not paid
 * yet: it is money owed TO the shop, sitting outside the payable entirely. Add
 * them and the screen understates what is owed by exactly the claim value.
 */
export function returnsPosition(docs: readonly SupplierReturn[], today: Date): ReturnsPosition {
  let debitNotes = D.ZERO
  let debitNoteCount = 0
  let claimed = D.ZERO
  let claimCount = 0
  let received = D.ZERO
  let awaiting = D.ZERO
  let awaitingCount = 0
  let shortfall = D.ZERO
  let oldestAwaitingDays: number | null = null

  for (const doc of docs) {
    if (doc.status !== 'POSTED') continue
    const value = money(doc.netAmount) ?? D.ZERO

    if (doc.kind === 'PURCHASE_RETURN') {
      debitNotes = D.add(debitNotes, value)
      debitNoteCount += 1
      continue
    }

    claimed = D.add(claimed, value)
    claimCount += 1
    if (doc.creditReceived === null) {
      awaiting = D.add(awaiting, value)
      awaitingCount += 1
      const age = ageInDays(doc.issuedOn, today)
      if (age !== null && (oldestAwaitingDays === null || age > oldestAwaitingDays)) {
        oldestAwaitingDays = age
      }
      continue
    }
    const got = money(doc.creditReceived) ?? D.ZERO
    received = D.add(received, got)
    shortfall = D.add(shortfall, D.sub(value, got))
  }

  return {
    debitNotes: D.toStr(debitNotes, 2),
    debitNoteCount,
    claimed: D.toStr(claimed, 2),
    claimCount,
    received: D.toStr(received, 2),
    awaiting: D.toStr(awaiting, 2),
    awaitingCount,
    shortfall: D.toStr(shortfall, 2),
    oldestAwaitingDays,
  }
}

// ----------------------------------------------------------------- spend ---

export interface SpendMonth {
  /** `YYYY-MM`. */
  key: string
  label: string
  amount: Money
}

/**
 * Twelve months of purchases from one distributor, oldest first.
 *
 * Months with no bill are present and zero rather than absent: a trend drawn
 * over only the months that had a purchase makes a supplier the shop stopped
 * buying from look steady right up to the last point.
 */
export function monthlySpend(
  invoices: readonly PurchaseInvoice[],
  today: Date,
  months = 12,
): SpendMonth[] {
  const totals = new Map<string, D.Decimal>()
  const order: SpendMonth[] = []

  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    totals.set(key, D.ZERO)
    order.push({
      key,
      label: d.toLocaleDateString('en-IN', { month: 'short' }),
      amount: '0.00',
    })
  }

  for (const inv of invoices) {
    if (inv.status !== 'POSTED') continue
    const key = inv.invoiceDate.slice(0, 7)
    const held = totals.get(key)
    if (held === undefined) continue
    totals.set(key, D.add(held, money(inv.netAmount) ?? D.ZERO))
  }

  return order.map((m) => ({ ...m, amount: D.toStr(totals.get(m.key) ?? D.ZERO, 2) }))
}
