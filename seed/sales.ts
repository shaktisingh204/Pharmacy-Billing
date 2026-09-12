/**
 * Demo sales history.
 *
 * The catalogue seed authors a shelf and an opening stock but no trading, so
 * every dashboard KPI reads zero and four charts render "No data". This replays
 * roughly four months of counter sales against that shelf.
 *
 * DEMO DATA — the trading rhythm, the prescribers and the patients are
 * invented. See seed/README.md and docs/UNVERIFIED.md.
 *
 * THE OPENING-STOCK INVERSION. `batches[].qtyOnHand` from the catalogue is what
 * the shop holds TODAY, at the END of the history, not at its start.
 * Decrementing it while generating would drive the fast movers negative and
 * leave the current stock disagreeing with what the catalogue authored. So the
 * history is generated BACKWARDS from today: the stock a bill may draw on is
 * today's stock plus everything sold after it, which is exactly the forward
 * balance standing before that bill. Opening stock then falls out as
 * authored + total sold, and the forward replay lands back on the authored
 * figure by construction — asserted at the end anyway, because a silent
 * mismatch here makes the ledger-vs-stock reconciliation permanently red.
 *
 * No money is computed here. Lines are assembled and handed to `computeQuote`,
 * the same engine the counter uses, so a demo bill foots exactly like a real
 * one. `Math.random()` and `Date.now()` are never used: screenshots, fixtures
 * and tests all depend on two runs being byte-identical.
 */

import type {
  Batch,
  IsoDate,
  Medicine,
  PaymentInput,
  PaymentMode,
  PrescriptionInput,
  Quote,
  QuoteLineInput,
  QuoteRequest,
  SaleInvoice,
  StoreProfile,
} from '../contract/types'
import * as D from '../web/src/domain/decimal'
import type { Decimal } from '../web/src/domain/decimal'
import { isSellable } from '../web/src/domain/fefo'
import type { TaxRateRow } from '../web/src/domain/gst'
import { computeQuote } from '../web/src/domain/quote'

export interface SalesHistoryInput {
  medicines: readonly Medicine[]
  batches: readonly Batch[]
  taxRates: readonly TaxRateRow[]
  store: StoreProfile
  customers: ReadonlyArray<{ id: number; name: string; phone: string }>
  today: Date
  days?: number
}

export interface SalesHistoryOutput {
  invoices: SaleInvoice[]
  /** Opening qtyOnHand per batch id BEFORE the history is applied. */
  openingQty: Map<number, string>
  /** Stock movements, one per invoice allocation, oldest first. */
  movements: Array<{
    batchId: number
    medicineId: number
    at: string
    qtyDelta: string
    balanceAfter: string
  }>
}

// ------------------------------------------------------------------- prng ---

/** mulberry32 — small, fast, and the only property that matters here: seeded. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cumulate(weights: readonly number[]): number[] {
  const out: number[] = []
  let acc = 0
  for (const w of weights) {
    acc += w
    out.push(acc)
  }
  return out
}

/**
 * Index into a cumulative weight table. Binary search rather than a linear
 * scan: the medicine table is 1,500 rows and is drawn from once per line.
 */
function weightedIndex(rnd: () => number, cum: readonly number[]): number {
  const target = rnd() * (cum.at(-1) ?? 0)
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((cum[mid] ?? 0) <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

// --------------------------------------------------------------- calendar ---

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local components, exactly as the adapter writes `invoiceDate`. Reading them
 *  in UTC would file a 9 a.m. sale under the previous day east of Greenwich. */
function isoDate(d: Date): IsoDate {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** India runs April-March. FY 2026-27 is written "2627" in a document number. */
function financialYear(d: Date, startMonth: number): string {
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`
}

// ----------------------------------------------------------------- rhythm ---

const DEFAULT_DAYS = 120
const TERMINAL_ID = 1
const OPERATOR_NAME = 'Counter 1'

/** Sunday to Saturday. A chemist's Sunday is a half day and Saturday is busy. */
const WEEKDAY_FACTOR = [0.55, 1, 1, 0.97, 1, 1.03, 0.85] as const

/** A weekday's takings, before the trend, the weekday factor and the noise. The
 *  three together have to stay inside BILLS_MIN..BILLS_MAX, or clamping eats
 *  the growth at the busy end and the trend chart flattens again. */
const BILLS_BASE = 48
/** The shop grows across the window so the trend chart slopes instead of sitting flat. */
const TREND_GROWTH = 0.15
const BILLS_MIN = 25
const BILLS_MAX = 60

/**
 * Two rushes — before work and after it — with a lull while the counter
 * restocks. Nothing before 08:00 or after 23:00: the shutter is down.
 */
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const
const HOUR_WEIGHT = [3, 8, 12, 13, 11, 6, 3, 2, 3, 8, 12, 13, 11, 6, 2] as const

/** Weighted low: most people come in for one thing. */
const LINE_COUNT_WEIGHT = [34, 28, 18, 11, 6, 3] as const

/** At or above this many base units the pack is a bottle, not a strip. */
const BULK_PACK_UNITS = 30

const WALK_IN_SHARE = 0.72

const PAY_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const satisfies readonly PaymentMode[]
const PAY_WEIGHT = [55, 30, 10, 5] as const

/**
 * Invented, like every other name in this seed. A Schedule H1 line may not be
 * dispensed without prescriber and patient details — `computeQuote` marks it
 * blocking — so a bill carrying one carries a prescription too.
 */
const PRESCRIBERS = [
  { name: 'Dr. A. K. Joshi', reg: 'MMC/2004/18422' },
  { name: 'Dr. Sheetal Ranade', reg: 'MMC/2011/29714' },
  { name: 'Dr. Imran Qureshi', reg: 'MMC/1998/10233' },
  { name: 'Dr. P. R. Sathe', reg: 'MMC/2015/40155' },
] as const

const PATIENTS = [
  'Anil Gokhale', 'Shraddha More', 'Kiran Bhosale',
  'Nafisa Merchant', 'Raghav Nair', 'Ujjwala Kale',
] as const

// ------------------------------------------------------------------- main ---

interface PlannedBill {
  date: Date
  iso: IsoDate
  createdAt: string
  customerId: number | null
  customerName: string | null
  customerPhone: string | null
  quote: Quote
  payments: PaymentInput[]
  amountPaid: string
  changeDue: string
  prescription: PrescriptionInput | null
  allocations: Array<{ batchId: number; medicineId: number; qty: Decimal }>
}

export function generateSalesHistory(input: SalesHistoryInput): SalesHistoryOutput {
  const { medicines, batches, taxRates, store, customers, today } = input
  const days = input.days ?? DEFAULT_DAYS
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer: ${days}`)

  // Three streams rather than one: adding a draw inside a bill must not reshuffle
  // which days were busy, or every screenshot in the repo shifts.
  const rndDay = mulberry32(0x5a1e0d47)
  const rndBill = mulberry32(0x5a1eb111)
  const rndStock = mulberry32(0x5a1e57c4)

  const anchorY = today.getFullYear()
  const anchorM = today.getMonth()
  const anchorD = today.getDate()
  /** Component arithmetic, so a DST boundary inside the window shifts no dates. */
  const dayAt = (offset: number): Date => new Date(anchorY, anchorM, anchorD + offset)

  const dates: Date[] = []
  for (let i = 0; i < days; i++) dates.push(dayAt(i - (days - 1)))
  const isoOfDay = dates.map(isoDate)
  const windowStart = isoOfDay[0] ?? isoDate(today)

  // -- indexes -------------------------------------------------------------
  const medById = new Map(medicines.map((m) => [m.id, m]))
  const batchesByMedicine = new Map<number, Batch[]>()
  for (const b of batches) {
    const list = batchesByMedicine.get(b.medicineId)
    if (list) list.push(b)
    else batchesByMedicine.set(b.medicineId, [b])
  }

  /** Running stock. Walking backwards this GROWS: it is authored + sold-after. */
  const balance = new Map<number, Decimal>(batches.map((b) => [b.id, D.dec(b.qtyOnHand)]))

  /**
   * `Batch` carries no receipt date, so one is drawn. Within a medicine the
   * earliest-expiry batch was already on the shelf when the window opened and
   * the later ones land part-way through as restocks. Without this a bill dated
   * four months ago dispenses from a batch that expires in 2030, and the FEFO
   * pick never changes across the whole history.
   */
  const arrivedOn = new Map<number, IsoDate>()
  for (const list of batchesByMedicine.values()) {
    const byExpiry = [...list].sort((a, b) =>
      a.expiryDate < b.expiryDate ? -1 : a.expiryDate > b.expiryDate ? 1 : a.id - b.id)
    byExpiry.forEach((b, i) => {
      const lateRoll = rndStock()
      const whenRoll = rndStock()
      const late = i > 0 && lateRoll < 0.45
      // Restocks land in the first four fifths of the window; one arriving
      // yesterday would have no history to explain the stock sitting on it.
      const at = late ? isoOfDay[Math.floor(whenRoll * days * 0.8)] ?? windowStart : windowStart
      arrivedOn.set(b.id, at)
    })
  }

  /**
   * `saleRank` is the catalogue's own dispense count, so weighting selection by
   * it makes the fast movers genuinely the top sellers. A uniform draw over
   * 1,500 SKUs turns the "Top medicines" panel into a random sample.
   * Schedule X needs a narcotics register this demo does not model.
   */
  const dispensable = medicines.filter(
    (m) => m.isActive && m.drugSchedule !== 'X' && m.saleRank > 0,
  )
  const medCum = cumulate(dispensable.map((m) => m.saleRank))
  const hourCum = cumulate([...HOUR_WEIGHT])
  const lineCum = cumulate([...LINE_COUNT_WEIGHT])
  const payCum = cumulate([...PAY_WEIGHT])

  // -- the day plan --------------------------------------------------------
  const billTimes: number[][] = dates.map((date, i) => {
    const trend = 1 + TREND_GROWTH * (days === 1 ? 1 : i / (days - 1))
    const dow = WEEKDAY_FACTOR[date.getDay()] ?? 1
    const noise = 0.94 + rndDay() * 0.12
    const count = clamp(Math.round(BILLS_BASE * trend * dow * noise), BILLS_MIN, BILLS_MAX)

    const times: number[] = []
    for (let k = 0; k < count; k++) {
      const hour = HOURS[weightedIndex(rndDay, hourCum)] ?? 10
      times.push(hour * 3600 + Math.floor(rndDay() * 3600))
    }
    return times.sort((a, b) => a - b)
  })

  // -- one bill ------------------------------------------------------------

  /** Batches this medicine could actually be dispensed from on `on`. */
  const availableBatches = (medicineId: number, on: IsoDate): Batch[] => {
    const out: Batch[] = []
    for (const b of batchesByMedicine.get(medicineId) ?? []) {
      if ((arrivedOn.get(b.id) ?? on) > on) continue
      const asOf: Batch = { ...b, qtyOnHand: D.toStr(balance.get(b.id) ?? D.ZERO, 3) }
      if (isSellable(asOf, on)) out.push(asOf)
    }
    return out
  }

  /**
   * A strip is the unit a customer asks in; a chronic refill is a month's
   * course, counted loose out of the pack where the strip may be cut.
   *
   * A 100-tablet thyroid bottle already IS the month, so bulk packs are not
   * bought in multiples — left unchecked they walk off with the "Top medicines"
   * board on unit count alone, which says nothing about what the shop sells.
   *
   * Capped at what the batches hold and snapped to whole packs where the strip
   * may not be cut, so no line oversells or trips the blocking
   * LOOSE_SALE_NOT_ALLOWED warning.
   */
  const chooseQty = (m: Medicine, avail: readonly Batch[]): Decimal => {
    const onHand = D.trunc(D.sum(avail.map((b) => D.dec(b.qtyOnHand))), 0)
    const pack = D.dec(m.unitsPerPack)
    const bulk = m.unitsPerPack >= BULK_PACK_UNITS
    const looseRoll = rndBill()
    const sizeRoll = rndBill()
    const courseRoll = rndBill()

    const want = m.allowLooseSale && looseRoll < (bulk ? 0.55 : 0.12)
      ? D.dec(courseRoll < 0.4 ? 10 : courseRoll < 0.65 ? 15 : 30)
      : D.mul(pack, D.dec(
          bulk ? (sizeRoll < 0.9 ? 1 : 2)
            : sizeRoll < 0.62 ? 1 : sizeRoll < 0.8 ? 2 : sizeRoll < 0.9 ? 3 : sizeRoll < 0.97 ? 4 : 6))

    const capped = D.min(want, onHand)
    const take = m.allowLooseSale ? capped : D.mul(D.trunc(D.div(capped, pack), 0), pack)

    // A counter that can only part-fill a request sends the customer next door.
    // Shrinking every short line instead would make the newest bills — where the
    // shelf is thinnest, because it is the shelf the catalogue authored —
    // systematically smaller than the oldest, and the sales trend would read as
    // a decline that never happened.
    return D.lt(D.mul(take, D.dec(2)), want) ? D.ZERO : take
  }

  /** A round-ish note above the total, or the exact amount when they have it. */
  const tender = (net: Decimal): Decimal => {
    const roll = rndBill()
    if (roll < 0.18) return net
    const step = D.dec(roll < 0.58 ? 10 : roll < 0.85 ? 50 : 100)
    const units = D.div(net, step)
    const whole = D.trunc(units, 0)
    return D.mul(D.eq(whole, units) ? whole : D.add(whole, D.ONE), step)
  }

  const digits = (n: number): string =>
    String(Math.floor(rndBill() * 10 ** n)).padStart(n, '0')

  const buildBill = (date: Date, iso: IsoDate, secondOfDay: number): PlannedBill | null => {
    const lineCount = weightedIndex(rndBill, lineCum) + 1
    const chosen: Array<{ medicine: Medicine; qty: Decimal; batches: Batch[] }> = []
    const used = new Set<number>()

    for (let slot = 0; slot < lineCount; slot++) {
      // Skip rather than oversell: a medicine with nothing sellable on this date
      // is simply not what was bought that afternoon.
      for (let attempt = 0; attempt < 6; attempt++) {
        const medicine = dispensable[weightedIndex(rndBill, medCum)]
        if (!medicine || used.has(medicine.id)) continue
        const avail = availableBatches(medicine.id, iso)
        if (avail.length === 0) continue
        const qty = chooseQty(medicine, avail)
        if (!D.gt(qty, D.ZERO)) continue
        used.add(medicine.id)
        chosen.push({ medicine, qty, batches: avail })
        break
      }
    }
    if (chosen.length === 0) return null

    const walkIn = rndBill() < WALK_IN_SHARE
    const pickCustomer = rndBill()
    const customer = walkIn ? null : customers[Math.floor(pickCustomer * customers.length)] ?? null

    const lines: QuoteLineInput[] = chosen.map((c, i) => ({
      lineId: `L${i + 1}`,
      medicineId: c.medicine.id,
      qty: D.toStr(c.qty, 3),
    }))

    // A Pune chemist bills its own state; IGST needs a customer registered
    // elsewhere and the demo has none.
    const req: QuoteRequest = {
      storeId: store.id,
      invoiceDate: iso,
      interState: false,
      lines,
      ...(customer ? { customerId: customer.id } : {}),
    }

    const quote = computeQuote(req, {
      today: iso,
      expiryGuardDays: store.expiryGuardDays,
      nearExpiryWarnDays: store.nearExpiryBuckets.at(-1) ?? 30,
      roundOffEnabled: store.roundOffEnabled,
      taxRates,
      medicines: medById,
      batchesByMedicine: new Map(chosen.map((c) => [c.medicine.id, c.batches])),
    })

    const net = D.dec(quote.netAmount)
    if (!D.gt(net, D.ZERO)) return null

    // Credit is a ledger entry against a named account, so a walk-in pays cash.
    const drawn = PAY_MODES[weightedIndex(rndBill, payCum)] ?? 'CASH'
    const mode: PaymentMode = drawn === 'CREDIT' && !customer ? 'CASH' : drawn
    const paid = mode === 'CASH' ? tender(net) : net
    const payments: PaymentInput[] = [{
      mode,
      amount: D.toStr(paid),
      ...(mode === 'UPI' ? { reference: `UPI${digits(12)}` } : {}),
      ...(mode === 'CARD' ? { reference: `XXXX${digits(4)}` } : {}),
    }]

    const prescriber = PRESCRIBERS[Math.floor(rndBill() * PRESCRIBERS.length)] ?? PRESCRIBERS[0]
    const patient = PATIENTS[Math.floor(rndBill() * PATIENTS.length)] ?? PATIENTS[0]
    const rxDaysAgo = Math.floor(rndBill() * 10)
    const prescription: PrescriptionInput | null =
      chosen.some((c) => c.medicine.drugSchedule === 'H1')
        ? {
            prescriberName: prescriber.name,
            prescriberRegNo: prescriber.reg,
            patientName: customer?.name ?? patient,
            prescriptionDate: isoDate(
              new Date(date.getFullYear(), date.getMonth(), date.getDate() - rxDaysAgo),
            ),
          }
        : null

    return {
      date,
      iso,
      // Seconds overflow into hours, so the stamp reads back at the intended
      // local hour — which is how the takings-by-hour chart buckets it.
      createdAt: new Date(
        date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, secondOfDay,
      ).toISOString(),
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      quote,
      payments,
      amountPaid: D.toStr(paid),
      changeDue: D.toStr(mode === 'CREDIT' ? D.ZERO : D.max(D.sub(paid, net), D.ZERO)),
      prescription,
      allocations: quote.lines.flatMap((l) =>
        l.allocations.map((a) => ({
          batchId: a.batchId,
          medicineId: l.medicineId,
          qty: D.add(D.dec(a.qty), D.dec(a.freeQty)),
        }))),
    }
  }

  // -- generate backwards --------------------------------------------------
  const newestFirst: PlannedBill[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = dates[i]
    const times = billTimes[i]
    const iso = isoOfDay[i]
    if (!date || !times || iso === undefined) continue
    for (let k = times.length - 1; k >= 0; k--) {
      const bill = buildBill(date, iso, times[k] ?? 0)
      if (!bill) continue
      // Only now does the batch become "unsold", which is what makes the stock
      // available to the bill BEFORE this one.
      for (const a of bill.allocations) {
        balance.set(a.batchId, D.add(balance.get(a.batchId) ?? D.ZERO, a.qty))
      }
      newestFirst.push(bill)
    }
  }

  // -- replay forwards -----------------------------------------------------
  const openingQty = new Map<number, string>()
  const running = new Map<number, Decimal>()
  for (const b of batches) {
    const opening = balance.get(b.id) ?? D.ZERO
    openingQty.set(b.id, D.toStr(opening, 3))
    running.set(b.id, opening)
  }

  const invoices: SaleInvoice[] = []
  const movements: SalesHistoryOutput['movements'] = []
  const seqByFy = new Map<string, number>()

  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const bill = newestFirst[i]
    if (!bill) continue

    // The counter is a row per (store, financial year, terminal) and restarts
    // each April, so the number is allocated on the replay rather than carried
    // out of the backwards pass.
    const fy = financialYear(bill.date, store.financialYearStartMonth)
    const seq = (seqByFy.get(fy) ?? 0) + 1
    seqByFy.set(fy, seq)

    invoices.push({
      id: invoices.length + 1,
      invoiceNo: `${store.invoicePrefix}${fy}-T${TERMINAL_ID}-${String(seq).padStart(5, '0')}`,
      storeId: store.id,
      terminalId: TERMINAL_ID,
      invoiceDate: bill.iso,
      createdAt: bill.createdAt,
      customerId: bill.customerId,
      customerName: bill.customerName,
      customerPhone: bill.customerPhone,
      interState: false,
      quote: bill.quote,
      payments: bill.payments,
      amountPaid: bill.amountPaid,
      changeDue: bill.changeDue,
      status: 'POSTED',
      prescription: bill.prescription,
      operatorName: OPERATOR_NAME,
    })

    for (const a of bill.allocations) {
      const after = D.sub(running.get(a.batchId) ?? D.ZERO, a.qty)
      if (D.lt(after, D.ZERO)) {
        throw new Error(`batch ${a.batchId} goes negative replaying invoice ${invoices.length}`)
      }
      running.set(a.batchId, after)
      movements.push({
        batchId: a.batchId,
        medicineId: a.medicineId,
        at: bill.createdAt,
        qtyDelta: D.toStr(D.neg(a.qty), 3),
        balanceAfter: D.toStr(after, 3),
      })
    }
  }

  // The whole point of the inversion. A drift here would leave the ledger and
  // the batch table permanently disagreeing, which no later screen can repair.
  for (const b of batches) {
    const final = running.get(b.id) ?? D.ZERO
    if (!D.eq(final, D.dec(b.qtyOnHand))) {
      throw new Error(
        `batch ${b.id} (${b.batchNo}) replays to ${D.toStr(final, 3)}, catalogue authored ${b.qtyOnHand}`,
      )
    }
  }

  return { invoices, openingQty, movements }
}
