import type {
  CreditNote, CreditNoteLine, DayClose, DayCloseInput, HourlyTotal, IsoDate, Money, OperatorTotal,
  PaymentMode, PaymentModeTotal, Pct, Qty, QuoteAllocation, ReturnDisposition, SaleInvoice,
  SaleRegisterRow, SaleReturnInput, SaleRowStatus, SalesFilters, SalesPage, SalesSummary,
} from '@contract'
import { ApiError, PAYMENT_MODES } from '@contract'
import * as D from '@/domain/decimal'
import { splitInclusive } from '@/domain/gst'

/**
 * The sale register, returns and the day close — as pure value logic.
 *
 * Everything the Sales screen means lives here as functions over arrays, and
 * `localAdapter` only feeds them from Dexie. The reason is the same one
 * `api/purchases` gives: these are the rules the Phase-5 Rust server has to
 * reproduce exactly, and rules that can only be reached through IndexedDB get
 * tested once and then trusted forever.
 *
 * TWO RULES HERE ARE NOT NEGOTIABLE, and both are invariants:
 *
 *  - I20, POSTED DOCUMENTS ARE IMMUTABLE. Nothing below edits an invoice. A
 *    void writes `status`, `voidReason` and `voidedAt` onto a document that
 *    stays exactly where it was; a return produces a SECOND document. There is
 *    no function here that changes a line, a quantity or an amount on a bill.
 *  - I21, A RETURN REVERSES THE ORIGINAL TAX. `priceSaleReturn` reads the rate
 *    off the allocation the sale recorded and never calls `resolveGstRate`.
 *    Slabs move — 22 September 2025 moved a great many of them — and a credit
 *    note re-rated at today's slab reverses a liability the shop never had,
 *    which shows up as a GSTR-1 that disagrees with its own credit notes.
 */

const money = (d: D.Decimal): Money => D.toStr(d, 2)

/** The shortest EXACT form: "4.000" -> "4", "0.500" -> "0.5". */
const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s)

const qtyStr = (d: D.Decimal): Qty => trimZeros(D.toStr(d, 3))

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ')

const DECIMALISH = /^-?\d+(\.\d+)?$/

function invalid(code: string, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError({ code, message, ...(details ? { details } : {}) })
}

// ------------------------------------------------------------------ dates ---

const MS_PER_DAY = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Calendar arithmetic in UTC over the ISO string, never through a local Date.
 *
 * `new Date('2026-03-29')` is midnight UTC, and adding 86,400,000 ms to it in a
 * zone that changes offset that night lands on the same calendar day. The dates
 * on this screen are the shop's local calendar dates as strings; treating them
 * as UTC instants for arithmetic and never converting back is what keeps a
 * range from silently losing or repeating a day.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * Monday. India's retail week runs Monday to Sunday and the shop's own weekly
 * comparison is Monday-based; a Sunday-start week would put the busiest two
 * days of a pharmacy's week on opposite sides of the boundary.
 */
export function startOfWeek(date: IsoDate): IsoDate {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, -((day + 6) % 7))
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`
}

/** Inclusive, so a single day is 1 and never 0. */
export function daysInRange(from: IsoDate, to: IsoDate): number {
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY
  return Number.isFinite(span) ? Math.max(1, Math.round(span) + 1) : 1
}

/**
 * The period immediately before this one, of the SAME length.
 *
 * The comparison a shop actually makes is "against the last one of these":
 * today against yesterday, this week against last week, a 90-day custom range
 * against the 90 days before it. It is deliberately NOT the same period last
 * year — a pharmacy's year-on-year figure is dominated by which week Diwali
 * fell in, and a comparison an operator cannot reproduce in their head is a
 * comparison they will not trust.
 *
 * Month-to-date is the honest exception and the reason this is length-based:
 * on the 9th, "this month" is nine days and it is compared with the nine days
 * before it, not with the whole of last month, which would report every month
 * as collapsing until its final week.
 */
export function previousRange(from: IsoDate, to: IsoDate): DateRange {
  const length = daysInRange(from, to)
  const prevTo = addDays(from, -1)
  return { from: addDays(prevTo, -(length - 1)), to: prevTo }
}

/**
 * The change from `before` to `after`, as a percentage string, or null.
 *
 * Null when there is no basis: a period that took nothing cannot be "up 100%",
 * and printing ∞ or 100% against a zero opening is how a comparison starts
 * lying. The screen says "no trade in the previous period" instead, which is
 * the fact.
 */
export function pctChange(before: Money, after: Money): Pct | null {
  const base = D.dec(before)
  if (D.isZero(base)) return null
  return D.toStr(D.round(D.mul(D.div(D.sub(D.dec(after), base), D.abs(base)), D.HUNDRED), 1), 1)
}

export const RANGE_PRESETS = ['today', 'yesterday', 'week', 'month', 'custom'] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

export interface DateRange {
  from: IsoDate
  to: IsoDate
}

export const RANGE_LABEL: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  custom: 'Custom',
}

/**
 * A preset to an inclusive range.
 *
 * A custom range with the ends the wrong way round is swapped rather than
 * refused: it is what dragging two date inputs produces, and answering "no
 * bills" to a range that holds four hundred is a worse failure than quietly
 * reading the operator's intent.
 */
export function resolveRange(preset: RangePreset, today: IsoDate, custom?: Partial<DateRange>): DateRange {
  switch (preset) {
    case 'yesterday': {
      const d = addDays(today, -1)
      return { from: d, to: d }
    }
    case 'week':
      return { from: startOfWeek(today), to: today }
    case 'month':
      return { from: startOfMonth(today), to: today }
    case 'custom': {
      const from = ISO_DATE.test(custom?.from ?? '') ? (custom?.from as IsoDate) : today
      const to = ISO_DATE.test(custom?.to ?? '') ? (custom?.to as IsoDate) : today
      return from <= to ? { from, to } : { from: to, to: from }
    }
    case 'today':
    default:
      return { from: today, to: today }
  }
}

// ------------------------------------------------------------- the search ---

/**
 * A typed number, reduced to what can be matched against a stored one.
 *
 * Customer phones reach the book already normalised to ten national digits, but
 * a SEARCH TERM is whatever was typed: '+91 98220 41100' carries a country code
 * the stored value does not, and a plain substring test would then miss the
 * customer standing at the counter reading their own number off their phone.
 * Keeping the trailing ten digits is this search's own tolerance, not a second
 * copy of the storage rule.
 */
const searchDigits = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

/**
 * Invoice number, customer name, or phone.
 *
 * The phone clause is guarded on the term actually holding digits, because
 * `''.includes('')` is true and an unguarded clause makes every name search
 * match every bill with a phone on it.
 */
export function matchesSale(inv: SaleInvoice, term: string): boolean {
  const q = collapse(term).toLowerCase()
  if (!q) return true
  if (inv.invoiceNo.toLowerCase().includes(q)) return true
  if ((inv.customerName ?? '').toLowerCase().includes(q)) return true
  const digits = searchDigits(q)
  return digits.length > 0 && searchDigits(inv.customerPhone ?? '').includes(digits)
}

// ---------------------------------------------------------------- tenders ---

/** Distinct tenders in PAYMENT_MODES order, so a split bill reads the same way
 *  on every row rather than in the order the operator happened to key them. */
export function saleModes(inv: SaleInvoice): PaymentMode[] {
  const seen = new Set(inv.payments.map((p) => p.mode))
  return PAYMENT_MODES.filter((m) => seen.has(m))
}

/**
 * What this bill actually left in the drawer.
 *
 * Cash tendered MINUS the change handed back, because the change comes out of
 * the same drawer. A ₹650 bill settled with a ₹500 note and ₹200 by UPI leaves
 * ₹450 in cash, not ₹500, and a day close that counts the tender gross is short
 * by every rupee of change given that day.
 *
 * Deliberately not floored at zero: change given against a card overpayment
 * really does take cash out of a drawer no cash went into.
 */
export function cashInDrawer(inv: SaleInvoice): D.Decimal {
  const cash = D.sum(inv.payments.filter((p) => p.mode === 'CASH').map((p) => D.dec(p.amount)))
  return D.sub(cash, D.dec(inv.changeDue))
}

function tenderIn(inv: SaleInvoice, mode: PaymentMode): D.Decimal {
  if (mode === 'CASH') return cashInDrawer(inv)
  return D.sum(inv.payments.filter((p) => p.mode === mode).map((p) => D.dec(p.amount)))
}

// -------------------------------------------------------- what came back ---

/** An allocation is identified by its line AND its batch: one cart row can fan
 *  across several batches, and they return independently. */
export const allocationKey = (lineId: string, batchId: number): string => `${lineId}|${batchId}`

export interface ReturnedTally {
  /** Units already credited back, per allocation. */
  qty: Map<string, D.Decimal>
  /** Inclusive value already credited, per allocation. */
  value: Map<string, D.Decimal>
  /** Credit-note value against the whole bill, round-off included. */
  total: D.Decimal
}

export function tallyReturns(notes: readonly CreditNote[]): ReturnedTally {
  const qty = new Map<string, D.Decimal>()
  const value = new Map<string, D.Decimal>()
  let total = D.ZERO
  for (const note of notes) {
    total = D.add(total, D.dec(note.netAmount))
    for (const line of note.lines) {
      const key = allocationKey(line.lineId, line.batchId)
      qty.set(key, D.add(qty.get(key) ?? D.ZERO, D.dec(line.qty)))
      value.set(key, D.add(value.get(key) ?? D.ZERO, D.dec(line.lineTotal)))
    }
  }
  return { qty, value, total }
}

/** Every charged allocation on a bill, with what is left to return on it. */
export interface ReturnableAllocation {
  lineId: string
  medicineId: number
  brandName: string
  packLabel: string
  hsnCode: string
  batchId: number
  batchNo: string
  expiryDate: IsoDate
  gstRatePct: Pct
  ratePerUnit: Money
  soldQty: Qty
  returnedQty: Qty
  returnableQty: Qty
  /** Inclusive value of the whole allocation, and of what is still open. */
  soldValue: Money
  remainingValue: Money
}

/**
 * FREE UNITS ARE NOT RETURNABLE HERE, and that is deliberate.
 *
 * `allocation.freeQty` was dispensed and never charged, so there is nothing to
 * credit against it — a credit note for zero rupees is not a document. If the
 * scheme unit physically comes back it is a stock adjustment with a note, which
 * the Inventory screen already does properly. Capping the returnable quantity
 * at the CHARGED units is what keeps a credit note from ever crediting goods
 * the customer was given.
 */
export function returnableAllocations(
  inv: SaleInvoice,
  notes: readonly CreditNote[],
): ReturnableAllocation[] {
  const tally = tallyReturns(notes)
  const out: ReturnableAllocation[] = []
  for (const line of inv.quote.lines) {
    for (const a of line.allocations) {
      const key = allocationKey(line.lineId, a.batchId)
      const sold = D.dec(a.qty)
      const returned = tally.qty.get(key) ?? D.ZERO
      const credited = tally.value.get(key) ?? D.ZERO
      out.push({
        lineId: line.lineId,
        medicineId: line.medicineId,
        brandName: line.brandName,
        packLabel: line.packLabel,
        hsnCode: line.hsnCode,
        batchId: a.batchId,
        batchNo: a.batchNo,
        expiryDate: a.expiryDate,
        gstRatePct: a.gstRatePct,
        ratePerUnit: a.ratePerUnit,
        soldQty: qtyStr(sold),
        returnedQty: qtyStr(returned),
        returnableQty: qtyStr(D.max(D.sub(sold, returned), D.ZERO)),
        soldValue: a.lineTotal,
        remainingValue: money(D.max(D.sub(D.dec(a.lineTotal), credited), D.ZERO)),
      })
    }
  }
  return out
}

/** True once every charged unit on the bill has been credited back. */
export function isFullyReturned(inv: SaleInvoice, notes: readonly CreditNote[]): boolean {
  const tally = tallyReturns(notes)
  let anyCharged = false
  for (const line of inv.quote.lines) {
    for (const a of line.allocations) {
      const sold = D.dec(a.qty)
      if (!D.gt(sold, D.ZERO)) continue
      anyCharged = true
      if (D.lt(tally.qty.get(allocationKey(line.lineId, a.batchId)) ?? D.ZERO, sold)) return false
    }
  }
  return anyCharged
}

// -------------------------------------------------------- the credit note ---

/** The minimum a reason has to be before it explains anything. "ok" is not one. */
export const REASON_MIN = 6

/**
 * The paperwork check, separate from the arithmetic on purpose.
 *
 * `priceSaleReturn` is pure arithmetic and the return screen runs it on every
 * keystroke to show the operator what the refund comes to. Folding the reason
 * into it would mean the amount stayed blank until a sentence had been typed —
 * so the counter would have to explain a refund before it could tell the
 * customer what the refund is. Posting still requires it; `postSaleReturn`
 * calls this first, the way `voidSale` calls `checkVoidable`.
 */
export function requireReturnReason(reason: string): string {
  const trimmed = collapse(reason ?? '')
  if (trimmed.length < REASON_MIN) {
    throw invalid('RETURN_REASON_REQUIRED', 'Say why the goods came back — the credit note carries it', { field: 'reason' })
  }
  return trimmed
}

export interface CreditNoteContext {
  storeId: number
  operatorName: string
  /** The date the credit note is ISSUED on — today, not the invoice's date. */
  issuedOn: IsoDate
  createdAt: string
}

/**
 * A priced credit note is missing exactly the two fields a DOCUMENT has.
 *
 * Leaving `id` and `creditNoteNo` out of the type rather than filling them with
 * sentinels is what makes "pricing creates nothing" a compile-time fact — the
 * same shape `api/purchases.PricedInvoice` uses, for the same reason.
 */
export type PricedCreditNote = Omit<CreditNote, 'id' | 'creditNoteNo'>

/** One ledger movement the adapter has to write, in order. */
export interface ReturnMovement {
  batchId: number
  medicineId: number
  /** Signed, in base units. */
  qtyDelta: Qty
  reason: 'SALE_RETURN' | 'ADJUSTMENT'
  note: string | null
}

export interface PricedSaleReturn {
  note: PricedCreditNote
  /** Applied in order: a DESTROY line is a receipt AND a write-off, and the
   *  running balance only reads correctly if they land in that sequence. */
  movements: ReturnMovement[]
  /** Batches to block from allocation, because a QUARANTINE line came back. */
  quarantineBatchIds: number[]
}

/**
 * Price a return against a posted bill. Pure: moves nothing, numbers nothing.
 *
 * THE REVERSAL IS TAKEN INCLUSIVE-FIRST, exactly as the sale was built. What
 * the customer gets back is a share of what they PAID, and the tax inside it is
 * then backed out at the rate recorded on the original allocation
 * (`splitInclusive`, residual arithmetic) — so `taxable + cgst + sgst` equals
 * the refund exactly and the credit note foots by construction (I10, I12).
 *
 * The LAST return against an allocation credits the remainder rather than a
 * fresh proportional share. Three partial returns of a ₹100 line each rounding
 * to ₹33.33 would leave a paisa un-credited forever; taking the remainder means
 * the parts always sum to the whole, which is the only way a fully-returned
 * bill can net to zero.
 */
export function priceSaleReturn(
  invoice: SaleInvoice,
  existingNotes: readonly CreditNote[],
  input: SaleReturnInput,
  ctx: CreditNoteContext,
): PricedSaleReturn {
  if (invoice.status !== 'POSTED') {
    throw invalid('SALE_NOT_POSTED', `${invoice.invoiceNo} is cancelled — there is nothing to credit back`)
  }
  // The reason is NOT checked here — see `requireReturnReason`, which the poster
  // calls. This function is the arithmetic, and the screen runs it live.
  const reason = collapse(input.reason ?? '')
  if (!PAYMENT_MODES.includes(input.refundMode)) {
    throw invalid('RETURN_INVALID', 'Choose how the money goes back', { field: 'refundMode' })
  }
  if (!input.lines || input.lines.length === 0) {
    throw invalid('RETURN_EMPTY', 'Nothing selected to return')
  }

  const allocations = new Map<string, { line: SaleInvoice['quote']['lines'][number]; alloc: QuoteAllocation }>()
  for (const line of invoice.quote.lines) {
    for (const alloc of line.allocations) allocations.set(allocationKey(line.lineId, alloc.batchId), { line, alloc })
  }
  const tally = tallyReturns(existingNotes)

  const seen = new Set<string>()
  const lines: CreditNoteLine[] = []
  const movements: ReturnMovement[] = []
  const quarantine = new Set<number>()
  /** Post-return totals per allocation, to decide whether the bill is now closed. */
  const returnedAfter = new Map<string, D.Decimal>()

  for (const req of input.lines) {
    const key = allocationKey(req.lineId, req.batchId)
    const found = allocations.get(key)
    if (!found) {
      throw invalid('RETURN_LINE_UNKNOWN', `${invoice.invoiceNo} has no line ${req.lineId} on batch ${req.batchId}`, { lineId: req.lineId })
    }
    // Two rows against one allocation would each be checked against the same
    // remaining quantity and both would pass, so the pair could over-return.
    if (seen.has(key)) {
      throw invalid('RETURN_LINE_REPEATED', `${found.line.brandName} appears twice on this return`, { lineId: req.lineId })
    }
    seen.add(key)

    const raw = (req.qty ?? '').trim()
    if (!DECIMALISH.test(raw)) {
      throw invalid('RETURN_INVALID', `${found.line.brandName}: quantity must be a number`, { lineId: req.lineId, field: 'qty' })
    }
    const qty = D.dec(raw)
    if (!D.gt(qty, D.ZERO)) {
      throw invalid('RETURN_INVALID', `${found.line.brandName}: nothing to return on this line`, { lineId: req.lineId, field: 'qty' })
    }

    const sold = D.dec(found.alloc.qty)
    const already = tally.qty.get(key) ?? D.ZERO
    const remainingQty = D.sub(sold, already)
    // THE CAP: sold minus already returned. Without it the same strip can be
    // credited twice, which is a refund the shop pays for out of its own pocket.
    if (D.gt(qty, remainingQty)) {
      throw invalid(
        'RETURN_EXCEEDS_SOLD',
        `${found.line.brandName}: ${qtyStr(remainingQty)} left to return from batch ${found.alloc.batchNo}, not ${qtyStr(qty)}`,
        { lineId: req.lineId, batchId: req.batchId, returnable: qtyStr(remainingQty) },
      )
    }

    const soldValue = D.dec(found.alloc.lineTotal)
    const creditedValue = tally.value.get(key) ?? D.ZERO
    const remainingValue = D.sub(soldValue, creditedValue)
    const inclusive = D.eq(qty, remainingQty)
      ? remainingValue
      : D.min(D.round(D.div(D.mul(soldValue, qty), sold), 2), remainingValue)

    // The rate comes off the ALLOCATION. This is invariant I21 in one line, and
    // it is the reason this function does not take a tax-rate table at all.
    const split = splitInclusive(inclusive, found.alloc.gstRatePct, invoice.interState)
    const disposition: ReturnDisposition = req.disposition
    lines.push({
      lineId: req.lineId,
      medicineId: found.line.medicineId,
      brandName: found.line.brandName,
      packLabel: found.line.packLabel,
      hsnCode: found.line.hsnCode,
      batchId: found.alloc.batchId,
      batchNo: found.alloc.batchNo,
      expiryDate: found.alloc.expiryDate,
      qty: qtyStr(qty),
      // Sold at, not "worth today". The strip goes back to the shelf at the
      // price printed on it, which is why MRP is part of batch identity.
      ratePerUnit: found.alloc.ratePerUnit,
      gstRatePct: found.alloc.gstRatePct,
      taxableValue: money(split.taxableValue),
      cgst: money(split.cgst),
      sgst: money(split.sgst),
      igst: money(split.igst),
      lineTotal: money(inclusive),
      disposition,
    })
    returnedAfter.set(key, D.add(already, qty))

    const back: ReturnMovement = {
      batchId: found.alloc.batchId,
      medicineId: found.line.medicineId,
      qtyDelta: qtyStr(qty),
      reason: 'SALE_RETURN',
      note: disposition === 'RESTOCK'
        ? null
        : `${disposition === 'QUARANTINE' ? 'Held' : 'For destruction'}${reason ? `: ${reason}` : ''}`,
    }
    movements.push(back)
    if (disposition === 'QUARANTINE') quarantine.add(found.alloc.batchId)
    if (disposition === 'DESTROY') {
      // Two movements, not none. "The goods never came back" and "they came
      // back and we binned them" are different facts, and only the second one
      // explains why the shelf is short. The write-off is an ADJUSTMENT rather
      // than an EXPIRY_WRITEOFF because the goods did not expire.
      movements.push({
        batchId: found.alloc.batchId,
        medicineId: found.line.medicineId,
        qtyDelta: qtyStr(D.neg(qty)),
        reason: 'ADJUSTMENT',
        note: `Destroyed on return against ${invoice.invoiceNo}${reason ? `: ${reason}` : ''}`,
      })
    }
  }

  const taxableValue = D.sum(lines.map((l) => D.dec(l.taxableValue)))
  const cgst = D.sum(lines.map((l) => D.dec(l.cgst)))
  const sgst = D.sum(lines.map((l) => D.dec(l.sgst)))
  const igst = D.sum(lines.map((l) => D.dec(l.igst)))
  const lineTotal = D.sum(lines.map((l) => D.dec(l.lineTotal)))

  /*
   * The invoice's round-off rides on the LAST credit note and on no other.
   *
   * A bill of 1,284.60 was collected as 1,285.00; the 40 paise belongs to the
   * document, not to any line on it. Handing it back on a partial return would
   * refund money the line did not carry, and never handing it back would leave
   * a fully-returned bill netting to 40 paise of sales the shop did not make.
   */
  const closesTheBill = closesEveryAllocation(invoice, tally, returnedAfter)
  const roundOff = closesTheBill ? D.dec(invoice.quote.roundOff) : D.ZERO

  return {
    note: {
      storeId: ctx.storeId,
      terminalId: input.terminalId,
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      originalInvoiceDate: invoice.invoiceDate,
      issuedOn: ctx.issuedOn,
      createdAt: ctx.createdAt,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      interState: invoice.interState,
      lines,
      taxableValue: money(taxableValue),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      roundOff: money(roundOff),
      netAmount: money(D.add(lineTotal, roundOff)),
      refundMode: input.refundMode,
      reason,
      operatorName: ctx.operatorName,
    },
    movements,
    quarantineBatchIds: [...quarantine],
  }
}

function closesEveryAllocation(
  invoice: SaleInvoice,
  tally: ReturnedTally,
  returnedAfter: ReadonlyMap<string, D.Decimal>,
): boolean {
  for (const line of invoice.quote.lines) {
    for (const alloc of line.allocations) {
      const key = allocationKey(line.lineId, alloc.batchId)
      const sold = D.dec(alloc.qty)
      if (!D.gt(sold, D.ZERO)) continue
      const returned = returnedAfter.get(key) ?? tally.qty.get(key) ?? D.ZERO
      if (D.lt(returned, sold)) return false
    }
  }
  return true
}

// ---------------------------------------------------------------- the void ---

/**
 * What `voidSale` must decide before it writes anything.
 *
 * A void is not a general-purpose undo. It cancels a bill on the day it was
 * raised, before the day's figures are anywhere; a bill from a past period is
 * corrected by a credit note, because cancelling it retrospectively changes a
 * GSTR-1 that has already been filed and leaves the shop's own turnover
 * disagreeing with the return it lodged. And a bill a credit note already
 * points at cannot be cancelled at all: the reversing document would then
 * reference an invoice that no longer exists.
 */
export function checkVoidable(
  invoice: SaleInvoice,
  notes: readonly CreditNote[],
  today: IsoDate,
  reason: string,
  /**
   * True once the drawer has been counted for the bill's own date.
   *
   * A day close records an expected cash figure and the variance against the
   * count. Cancelling a cash bill afterwards moves the expected figure and
   * leaves the stored variance quoting an amount that no longer reconciles —
   * the header chip goes on showing "Closed · 0.00" while the drawer is short by
   * the value of the cancelled bill, and the control it represents is gone with
   * nothing on the screen saying so. The correction belongs to the open day: a
   * credit note, which is what the refusal message says to raise.
   *
   * Optional so a caller with no day-close information behaves exactly as before
   * rather than silently refusing everything.
   */
  dayIsClosed = false,
): string {
  if (invoice.status === 'VOIDED') {
    throw invalid('SALE_ALREADY_VOID', `${invoice.invoiceNo} is already cancelled`)
  }
  if (notes.length > 0) {
    throw invalid(
      'SALE_HAS_CREDIT_NOTE',
      `${invoice.invoiceNo} has a credit note against it — return the rest instead of cancelling the bill`,
      { creditNoteNo: notes[0]?.creditNoteNo },
    )
  }
  if (invoice.invoiceDate !== today) {
    throw invalid(
      'SALE_TOO_OLD_TO_VOID',
      `${invoice.invoiceNo} was raised on ${invoice.invoiceDate}. A bill from a closed day is corrected by a credit note, not cancelled`,
      { invoiceDate: invoice.invoiceDate },
    )
  }
  /* AFTER the too-old check, because a bill from another day is refused for the
     older, plainer reason and hearing about a day close it was never part of
     would only confuse. Before the reason check, so an operator is not asked to
     justify something that was going to be refused anyway. */
  if (dayIsClosed) {
    throw invalid(
      'DAY_ALREADY_CLOSED',
      `${invoice.invoiceDate} has been closed and counted. Raise a credit note instead — cancelling this bill would leave the recorded variance quoting a figure that no longer reconciles`,
      { invoiceDate: invoice.invoiceDate },
    )
  }
  const trimmed = collapse(reason ?? '')
  if (trimmed.length < REASON_MIN) {
    throw invalid('VOID_REASON_REQUIRED', 'A cancelled bill has to say why', { field: 'reason' })
  }
  return trimmed
}

/** Is this bill still cancellable? The screen asks so it can show the action or
 *  the explanation, rather than a button that is only there to be refused. */
export function isVoidable(
  invoice: SaleInvoice,
  notes: readonly CreditNote[],
  today: IsoDate,
  dayIsClosed = false,
): boolean {
  return invoice.status === 'POSTED'
    && notes.length === 0
    && invoice.invoiceDate === today
    && !dayIsClosed
}

/** Stock a void has to put back: everything the bill took, free units included. */
export function voidMovements(invoice: SaleInvoice): ReturnMovement[] {
  return invoice.quote.lines.flatMap((line) =>
    line.allocations.map((a): ReturnMovement => ({
      batchId: a.batchId,
      medicineId: line.medicineId,
      // Free units left the shelf with the sale, so they come back with the
      // cancellation. This is the one path where `freeQty` moves stock.
      qtyDelta: qtyStr(D.add(D.dec(a.qty), D.dec(a.freeQty))),
      reason: 'SALE_RETURN',
      note: `Void of ${invoice.invoiceNo}`,
    })),
  )
}

// ------------------------------------------------------------- the register ---

const LIMIT_DEFAULT = 150
const LIMIT_MAX = 500

const clampLimit = (raw: number | undefined): number =>
  raw === undefined ? LIMIT_DEFAULT : Math.max(1, Math.min(Math.floor(raw), LIMIT_MAX))

const clampCursor = (raw: number | undefined, total: number): number =>
  raw === undefined || raw <= 0 ? 0 : Math.min(Math.floor(raw), total)

export interface SalesRegisterDeps {
  /** Already narrowed to the date range, in any order. */
  invoices: readonly SaleInvoice[]
  /** Every credit note touching those bills, plus any issued inside the range. */
  creditNotes: readonly CreditNote[]
}

function notesByInvoice(notes: readonly CreditNote[]): Map<number, CreditNote[]> {
  const out = new Map<number, CreditNote[]>()
  for (const n of notes) {
    const list = out.get(n.invoiceId)
    if (list) list.push(n)
    else out.set(n.invoiceId, [n])
  }
  return out
}

export function rowStatus(inv: SaleInvoice, notes: readonly CreditNote[]): SaleRowStatus {
  if (inv.status === 'VOIDED') return 'VOIDED'
  if (notes.length === 0) return 'POSTED'
  return isFullyReturned(inv, notes) ? 'RETURNED' : 'PART_RETURNED'
}

export function buildRegisterRow(inv: SaleInvoice, notes: readonly CreditNote[]): SaleRegisterRow {
  const allocations = inv.quote.lines.flatMap((l) => l.allocations)
  return {
    id: inv.id,
    invoiceNo: inv.invoiceNo,
    invoiceDate: inv.invoiceDate,
    createdAt: inv.createdAt,
    customerName: inv.customerName,
    customerPhone: inv.customerPhone,
    lineCount: inv.quote.lines.length,
    itemQty: qtyStr(D.sum(allocations.map((a) => D.dec(a.qty)))),
    netAmount: inv.quote.netAmount,
    modes: saleModes(inv),
    status: rowStatus(inv, notes),
    returnedAmount: money(tallyReturns(notes).total),
    terminalId: inv.terminalId,
    operatorName: inv.operatorName,
  }
}

const EMPTY_NOTES: CreditNote[] = []

function matchesFilters(
  inv: SaleInvoice,
  status: SaleRowStatus,
  filters: SalesFilters,
): boolean {
  const want = filters.status ?? 'all'
  if (want === 'posted' && status !== 'POSTED') return false
  if (want === 'voided' && status !== 'VOIDED') return false
  if (want === 'returned' && status !== 'RETURNED' && status !== 'PART_RETURNED') return false
  if (filters.mode !== undefined && !inv.payments.some((p) => p.mode === filters.mode)) return false
  return matchesSale(inv, filters.term ?? '')
}

/**
 * The register page AND the range summary, in one pass.
 *
 * The summary is computed over the whole DATE RANGE and deliberately ignores
 * the search term, the tender filter and the status filter. The tiles are the
 * day's numbers; if typing an invoice number rewrote them, the operator would
 * watch the day's takings collapse to one bill every time they went looking for
 * one — and would then have no way to read the day at all while filtered.
 */
export function buildSalesPage(deps: SalesRegisterDeps, filters: SalesFilters): SalesPage {
  const byInvoice = notesByInvoice(deps.creditNotes)
  const inRange = deps.invoices.filter((i) => i.invoiceDate >= filters.from && i.invoiceDate <= filters.to)

  const rows = inRange
    .map((inv) => ({ inv, row: buildRegisterRow(inv, byInvoice.get(inv.id) ?? EMPTY_NOTES) }))
    .filter(({ inv, row }) => matchesFilters(inv, row.status, filters))
    .map(({ row }) => row)

  rows.sort(compareRows(filters.sort ?? 'time'))

  const start = clampCursor(filters.cursor, rows.length)
  const page = rows.slice(start, start + clampLimit(filters.limit))
  const next = start + page.length

  return {
    rows: page,
    total: rows.length,
    nextCursor: next < rows.length ? next : null,
    summary: summariseSales(inRange, deps.creditNotes, filters.from, filters.to),
  }
}

function compareRows(sort: NonNullable<SalesFilters['sort']>): (a: SaleRegisterRow, b: SaleRegisterRow) => number {
  switch (sort) {
    case 'amount':
      return (a, b) => D.cmp(D.dec(b.netAmount), D.dec(a.netAmount)) || b.id - a.id
    case 'invoiceNo':
      return (a, b) => a.invoiceNo.localeCompare(b.invoiceNo) || a.id - b.id
    case 'time':
    default:
      // Newest first. The tie-break on id is not decoration: two bills posted in
      // the same second must not swap places between two renders of one page.
      return (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id
  }
}

const HOURS_IN_DAY = 24

/**
 * The trading profile, hour by hour on the SHOP'S clock.
 *
 * `new Date(...).getHours()` deliberately, not a UTC hour: the question this
 * answers is "when do I need a second person behind the counter", and in IST
 * the UTC hour files the 11 a.m. rush under 05:30 and splits the evening trade
 * across two calendar days. All twenty-four buckets are emitted whether or not
 * anything happened in them, so the shape of a quiet day and a busy one can be
 * laid over each other.
 */
function hourlyProfile(posted: readonly SaleInvoice[]): HourlyTotal[] {
  const bills = new Array<number>(HOURS_IN_DAY).fill(0)
  const amounts = new Array<D.Decimal>(HOURS_IN_DAY).fill(D.ZERO)
  for (const inv of posted) {
    const at = Date.parse(inv.createdAt)
    if (Number.isNaN(at)) continue
    const hour = new Date(at).getHours()
    bills[hour] = (bills[hour] ?? 0) + 1
    amounts[hour] = D.add(amounts[hour] ?? D.ZERO, D.dec(inv.quote.netAmount))
  }
  return Array.from({ length: HOURS_IN_DAY }, (_, hour) => ({
    hour,
    bills: bills[hour] ?? 0,
    amount: money(amounts[hour] ?? D.ZERO),
  }))
}

/**
 * Who rang what up.
 *
 * Keyed on the operator NAME the invoice snapshotted. The bill is the record of
 * who served the customer, and joining to a user table would rewrite last
 * month's figures the day somebody is renamed or leaves.
 *
 * Sorted by takings, then by name so a tie is stable rather than dependent on
 * which bill happened to be read first.
 */
function operatorTotals(posted: readonly SaleInvoice[]): OperatorTotal[] {
  const byName = new Map<string, { bills: number; amount: D.Decimal; units: D.Decimal }>()
  for (const inv of posted) {
    const name = collapse(inv.operatorName) || 'Unattributed'
    const agg = byName.get(name) ?? { bills: 0, amount: D.ZERO, units: D.ZERO }
    agg.bills += 1
    agg.amount = D.add(agg.amount, D.dec(inv.quote.netAmount))
    agg.units = D.add(
      agg.units,
      D.sum(inv.quote.lines.flatMap((l) => l.allocations.map((a) => D.dec(a.qty)))),
    )
    byName.set(name, agg)
  }
  return [...byName.entries()]
    .map(([operatorName, agg]): OperatorTotal => ({
      operatorName,
      bills: agg.bills,
      amount: money(agg.amount),
      averageBill: money(D.div(agg.amount, D.dec(agg.bills))),
      itemsSold: qtyStr(agg.units),
    }))
    .sort((a, b) => D.cmp(D.dec(b.amount), D.dec(a.amount)) || a.operatorName.localeCompare(b.operatorName))
}

/**
 * The range's numbers.
 *
 * `returns` counts credit notes by the date they were ISSUED, not by the date
 * of the bill they reverse. A return of a bill from last month reduces THIS
 * month's takings, which is both how the drawer behaves and how GSTR-1 reports
 * it — the credit note is a document of its own period.
 */
export function summariseSales(
  invoices: readonly SaleInvoice[],
  notes: readonly CreditNote[],
  from: IsoDate,
  to: IsoDate,
): SalesSummary {
  const posted = invoices.filter((i) => i.status === 'POSTED')
  const voided = invoices.filter((i) => i.status === 'VOIDED')
  const issued = notes.filter((n) => n.issuedOn >= from && n.issuedOn <= to)

  const netSales = D.sum(posted.map((i) => D.dec(i.quote.netAmount)))
  const byMode: PaymentModeTotal[] = PAYMENT_MODES.map((mode) => {
    const bills = posted.filter((i) => i.payments.some((p) => p.mode === mode))
    return {
      mode,
      amount: money(D.sum(bills.map((i) => tenderIn(i, mode)))),
      bills: bills.length,
    }
  })

  return {
    from,
    to,
    bills: posted.length,
    netSales: money(netSales),
    // Guarded: an empty day divided by zero bills is a crash, and "₹0.00" is a
    // truer answer than any number invented for it.
    averageBill: posted.length === 0 ? '0.00' : money(D.div(netSales, D.dec(posted.length))),
    returns: money(D.sum(issued.map((n) => D.dec(n.netAmount)))),
    returnCount: issued.length,
    voidedBills: voided.length,
    voidedAmount: money(D.sum(voided.map((i) => D.dec(i.quote.netAmount)))),
    byMode,
    itemsSold: qtyStr(
      D.sum(posted.flatMap((i) => i.quote.lines.flatMap((l) => l.allocations.map((a) => D.dec(a.qty))))),
    ),
    byHour: hourlyProfile(posted),
    byOperator: operatorTotals(posted),
  }
}

// ------------------------------------------------------- the return register ---

export type CreditNoteSort = 'time' | 'amount' | 'noteNo'

export interface CreditNoteFilters {
  /** Credit-note number, the bill it reverses, or the customer. */
  term?: string
  /** How the money went back. */
  refundMode?: PaymentMode
  sort?: CreditNoteSort
}

/**
 * Does this credit note answer the search box?
 *
 * The ORIGINAL invoice number is searchable and that is the point of the tab:
 * somebody standing at the counter with a bill in their hand asks "has anything
 * come back against this", and typing the bill number has to answer it without
 * first finding the bill.
 */
export function matchesCreditNote(note: CreditNote, term: string): boolean {
  const q = collapse(term).toLowerCase()
  if (!q) return true
  return note.creditNoteNo.toLowerCase().includes(q)
    || note.invoiceNo.toLowerCase().includes(q)
    || (note.customerName ?? '').toLowerCase().includes(q)
}

/**
 * The returns register, filtered and ordered.
 *
 * Client-side over the notes already fetched for the range rather than a second
 * paged endpoint: a shop that issues more than a handful of credit notes a day
 * has a problem no pagination will fix, and the whole range is what the
 * analytics header is summing anyway.
 */
export function filterCreditNotes(
  notes: readonly CreditNote[],
  filters: CreditNoteFilters,
): CreditNote[] {
  const out = notes.filter(
    (n) =>
      (filters.refundMode === undefined || n.refundMode === filters.refundMode)
      && matchesCreditNote(n, filters.term ?? ''),
  )
  switch (filters.sort ?? 'time') {
    case 'amount':
      out.sort((a, b) => D.cmp(D.dec(b.netAmount), D.dec(a.netAmount)) || b.id - a.id)
      break
    case 'noteNo':
      out.sort((a, b) => a.creditNoteNo.localeCompare(b.creditNoteNo) || a.id - b.id)
      break
    default:
      // Newest first, tie-broken on id: two notes written in the same second
      // must not swap places between two renders.
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  }
  return out
}

/** What came back in the range, as one line for the header. */
export interface ReturnsTotals {
  notes: number
  value: Money
  /** Units credited back, across every note. */
  units: Qty
  /** Notes whose goods did NOT go back on the shelf. */
  quarantined: number
  destroyed: number
  /** Refund value per tender, so a cash refund can be reconciled to the drawer. */
  byRefundMode: PaymentModeTotal[]
}

export function summariseReturns(notes: readonly CreditNote[]): ReturnsTotals {
  const lines = notes.flatMap((n) => n.lines)
  return {
    notes: notes.length,
    value: money(D.sum(notes.map((n) => D.dec(n.netAmount)))),
    units: qtyStr(D.sum(lines.map((l) => D.dec(l.qty)))),
    quarantined: lines.filter((l) => l.disposition === 'QUARANTINE').length,
    destroyed: lines.filter((l) => l.disposition === 'DESTROY').length,
    byRefundMode: PAYMENT_MODES.map((mode) => {
      const hits = notes.filter((n) => n.refundMode === mode)
      return {
        mode,
        amount: money(D.sum(hits.map((n) => D.dec(n.netAmount)))),
        bills: hits.length,
      }
    }),
  }
}

// -------------------------------------------------------------- day close ---

export interface DayCloseDeps {
  /** Posted and voided bills for the date, this terminal only. */
  invoices: readonly SaleInvoice[]
  /** Credit notes ISSUED on the date, this terminal only. */
  creditNotes: readonly CreditNote[]
  operatorName: string
  closedAt: string
}

/**
 * The blind count, reconciled.
 *
 * The count is an INPUT and the expected figure is an OUTPUT. There is
 * deliberately no function in this module that returns the expected cash on its
 * own: an operator who can see the figure before counting will find that figure
 * in the drawer every single evening, and the day a till is short is exactly
 * the day nobody says so. Handing the count in first is what makes the variance
 * a measurement rather than a formality.
 *
 * Only CASH moves the drawer. A UPI refund and a card refund go back the way
 * they came, and counting them here would manufacture a shortage every time
 * somebody returned a strip they had paid for by phone.
 */
export function computeDayClose(input: DayCloseInput, deps: DayCloseDeps): DayClose {
  const openingFloat = parseAmount(input.openingFloat, 'openingFloat', 'The opening float must be an amount like 2000.00')
  const countedCash = parseAmount(input.countedCash, 'countedCash', 'Enter the counted cash as an amount, e.g. 18450.00')

  const posted = deps.invoices.filter((i) => i.status === 'POSTED')
  const cashTaken = D.sum(posted.map(cashInDrawer))
  const cashRefunded = D.sum(
    deps.creditNotes.filter((n) => n.refundMode === 'CASH').map((n) => D.dec(n.netAmount)),
  )
  const expected = D.sub(D.add(openingFloat, cashTaken), cashRefunded)
  const summary = summariseSales(deps.invoices, deps.creditNotes, input.date, input.date)
  const note = collapse(input.note ?? '')

  return {
    date: input.date,
    terminalId: input.terminalId,
    closedAt: deps.closedAt,
    openingFloat: money(openingFloat),
    countedCash: money(countedCash),
    expectedCash: money(expected),
    // Counted minus expected: negative is SHORT. The other sign convention
    // reads "the drawer is up 400" as a negative number, which nobody does.
    variance: money(D.sub(countedCash, expected)),
    bills: summary.bills,
    netSales: summary.netSales,
    returns: summary.returns,
    byMode: summary.byMode,
    note: note ? note : null,
    operatorName: deps.operatorName,
  }
}

function parseAmount(raw: Money, field: string, message: string): D.Decimal {
  const s = (raw ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw invalid('DAY_CLOSE_INVALID', message, { field })
  return D.dec(s)
}
