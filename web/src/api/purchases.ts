import type {
  IsoDate, Medicine, Money, Pct, PurchaseInvoice, PurchaseInvoiceInput, PurchaseLine,
  PurchaseLineInput, Qty, Supplier, SupplierInput,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { apportion, mrpPerUnit, roundOff } from '@/domain/gst'

/**
 * Goods receipt, as pure value logic — the purchase-side mirror of `domain/quote`.
 *
 * `pricePurchase` prices a distributor's bill and creates NOTHING: no batch, no
 * ledger row, no document number. `localAdapter.postPurchase` is the transaction,
 * and it re-prices through this function rather than trusting the numbers the
 * screen sent, exactly as `postSale` re-quotes. Same reason, too: the client is
 * where a stale rate or a hand-edited total comes from.
 *
 * TWO THINGS ARE BACKWARDS FROM THE SALE SIDE, and both are easy to get wrong:
 *
 *  1. THE SUPPLIER'S INVOICE IS RATE-EXCLUSIVE. A printed MRP includes GST and is
 *     split out of the amount the customer pays (`splitInclusive`). A purchase
 *     bill quotes a net rate and ADDS tax on top, so tax here is computed ON the
 *     taxable value. Reusing `splitInclusive` would understate the tax by
 *     roughly the rate and quietly overstate input credit on every receipt.
 *  2. LANDED COST DIVIDES BY (paid + free) — invariant I19. A 10+1 scheme delivers
 *     eleven strips for the price of ten, so dividing by ten overstates unit cost
 *     by ~9% on every scheme line and reports a margin the shop is not earning.
 */

const money = (d: D.Decimal): Money => D.toStr(d, 2)
/** Per-unit money is carried at 4dp, for the reason `domain/gst.mrpPerUnit` gives. */
const unitMoney = (d: D.Decimal): Money => D.toStr(d, 4)
/**
 * The shortest EXACT form of a fixed-point string: "10.000" -> "10", "0.500" ->
 * "0.5". Nothing is rounded away — the trailing zeros carry no information, and
 * a document that says a distributor sent "10.000 packs" reads like a machine.
 */
const trimZeros = (s: string): string => s.replace(/\.?0+$/, '') || '0'

/** Packs, as a count. Whole almost always, halves occasionally. */
const qtyStr = (d: D.Decimal): Qty => trimZeros(D.toStr(d, 3))
/** A percentage the way `resolveGstRate` writes one ("12", "2.5", "0"), so a
 *  breakup can group on it as a string. */
const pctStr = (d: D.Decimal): Pct => trimZeros(D.toStr(d, 2))

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ')

function invalid(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError({ code: 'PURCHASE_INVALID', message, details })
}

function decimalOr(raw: string | undefined, fallback: string, message: string, details: Record<string, unknown>): D.Decimal {
  try {
    return D.dec((raw ?? fallback).trim() || fallback)
  } catch {
    throw invalid(message, details)
  }
}

// ---------------------------------------------------------------- expiry ---

/**
 * "11/27" is a MONTH, and the pack is good until the last day of it.
 *
 * Storing the first of the month would quarantine a batch up to thirty days
 * early — refusing to dispense stock that is legally saleable — and storing the
 * typed day would let two operators key the same pack as two different batches.
 * February and leap years fall out of `Date.UTC(y, m, 0)`, which is the last day
 * of month `m`, rather than out of a table of month lengths somebody has to
 * maintain.
 */
export function normaliseExpiry(printed: string): IsoDate {
  const raw = collapse(printed)
  let year: number | undefined
  let month: number | undefined

  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(raw)
  const short = /^(\d{1,2})[-/](\d{2}|\d{4})$/.exec(raw)
  if (iso) {
    const [, y, m] = iso
    if (y && m) {
      year = Number(y)
      month = Number(m)
    }
  } else if (short) {
    const [, m, y] = short
    if (y && m) {
      // A two-digit year on a pack is always this century: no medicine on a shelf
      // expires in 1927, and a pack that reads "11/27" in 2026 means 2027.
      year = y.length === 2 ? 2000 + Number(y) : Number(y)
      month = Number(m)
    }
  }

  if (year === undefined || month === undefined || month < 1 || month > 12) {
    throw invalid(`"${printed}" is not a printed expiry — use MM/YY`, { field: 'expiry', value: printed })
  }
  // Day 0 of the FOLLOWING month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

// ------------------------------------------------------------------- gst ---

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/

/**
 * The leading pair has to be a state code that was actually issued.
 *
 * The shape check above is not enough on its own, because the first two digits
 * are the ONE part of a GSTIN this application computes with: they decide IGST
 * versus CGST+SGST on every bill the distributor ever sends. A transposed pair
 * ("72" for "27") satisfies `\d{2}` perfectly and then books inter-state credit
 * on every local purchase forever — silently, because nothing downstream can
 * tell a wrong state code from a distant supplier. 01-38 are the assigned states
 * and union territories, 97 is "other territory" and 99 is the centre; the
 * supplier form applies exactly this rule, and a client stricter than the API is
 * a validation that anything not going through that form walks straight past.
 */
function validStateCode(gstin: string): boolean {
  const code = Number(gstin.slice(0, 2))
  return (code >= 1 && code <= 38) || code === 97 || code === 99
}

/**
 * Inter-state supply is decided by the supplier's GSTIN, not by a checkbox.
 *
 * The first two digits of a GSTIN are the state code. A distributor in another
 * state charges IGST, and a checkbox somebody forgets to tick is how a purchase
 * register ends up claiming CGST+SGST credit that was never paid. An unregistered
 * supplier (no GSTIN) carries no credit either way, so it is treated as local.
 */
export function isInterStateSupply(supplierGstin: string | null, storeStateCode: string): boolean {
  if (!supplierGstin) return false
  return supplierGstin.trim().slice(0, 2) !== storeStateCode.trim()
}

/** Tax computed ON the taxable value, because a purchase bill is rate-EXCLUSIVE. */
export function taxOn(taxableValue: D.Decimal, ratePct: Pct): D.Decimal {
  return D.round(D.percentOf(taxableValue, D.dec(ratePct)), 2)
}

// ------------------------------------------------------------ landed cost ---

/**
 * Weighted-average cost when a receipt lands on a batch that already holds stock.
 *
 * Overwriting would revalue strips bought at the old price at the new one;
 * keeping the old figure would carry the new strips at a price nobody paid.
 * Neither is defensible in a margin report, and the average is what the
 * ledger-based cost of goods on the sale side assumes.
 */
export function blendLandedCost(
  existing: { qty: D.Decimal; costPerUnit: D.Decimal },
  received: { qty: D.Decimal; costPerUnit: D.Decimal },
): D.Decimal {
  const units = D.add(existing.qty, received.qty)
  if (!D.gt(units, D.ZERO)) return received.costPerUnit
  const value = D.add(
    D.mul(existing.qty, existing.costPerUnit),
    D.mul(received.qty, received.costPerUnit),
  )
  return D.round(D.div(value, units), 4)
}

// --------------------------------------------------------------- pricing ---

export interface PurchasePricingContext {
  storeId: number
  /** From `stores.gstin` / `stores.stateCode`; decides IGST vs CGST+SGST. */
  storeStateCode: string
  roundOffEnabled: boolean
  supplier: Supplier
  medicineFor: (medicineId: number) => Medicine | undefined
  /** What the same medicine last arrived at, for the rate-change flag. */
  lastRatePerPack: (medicineId: number) => Money | null
  /** Injected, so a priced receipt is reproducible in a test. */
  createdAt: string
}

export interface PricedLine {
  line: PurchaseLine
  medicine: Medicine
  /** Last day of the printed expiry month. */
  expiryDate: IsoDate
  /** paid + free, in BASE units — the landed-cost denominator (invariant I19). */
  unitsReceived: D.Decimal
  landedCostPerUnit: D.Decimal
  ptrPerUnit: D.Decimal
  mrpPerUnit: D.Decimal
}

/**
 * A priced receipt is missing exactly the two fields a DOCUMENT has.
 *
 * Leaving `id` and `purchaseNo` out of the type rather than filling them with
 * sentinels is what makes "quoting creates nothing" a compile-time fact: there
 * is no priced value that can be mistaken for a posted one, and `postPurchase`
 * cannot forget to allocate them.
 */
export type PricedInvoice = Omit<PurchaseInvoice, 'id' | 'purchaseNo'>

export interface PricedPurchase {
  invoice: PricedInvoice
  lines: PricedLine[]
  interState: boolean
}

interface Working {
  input: PurchaseLineInput
  medicine: Medicine
  expiryDate: IsoDate
  packs: D.Decimal
  free: D.Decimal
  unitsReceived: D.Decimal
  gross: D.Decimal
  discount: D.Decimal
  /** Net of discount and EXCLUSIVE of GST. The freight weight, too. */
  taxable: D.Decimal
  mrpPerPack: D.Decimal
  ratePerPack: D.Decimal
  gstRatePct: Pct
  discountPct: Pct
}

function validateLine(line: PurchaseLineInput, ctx: PurchasePricingContext): Working {
  const details = { lineId: line.lineId }
  const medicine = ctx.medicineFor(line.medicineId)
  if (!medicine) {
    throw invalid(`Medicine ${line.medicineId} is not in the catalogue`, { ...details, field: 'medicineId' })
  }

  const batchNo = collapse(line.batchNo ?? '')
  if (!batchNo) throw invalid(`${medicine.brandName}: the batch number is on the pack and on the bill`, { ...details, field: 'batchNo' })

  const packs = decimalOr(line.qtyPacks, '0', `${medicine.brandName}: quantity must be a number of packs`, { ...details, field: 'qtyPacks' })
  const free = decimalOr(line.freePacks, '0', `${medicine.brandName}: free quantity must be a number of packs`, { ...details, field: 'freePacks' })
  if (D.isNeg(packs) || D.isNeg(free)) throw invalid(`${medicine.brandName}: a receipt cannot be negative`, { ...details, field: 'qtyPacks' })
  // A pure-scheme line (0 paid, 5 free) is a real thing a distributor sends.
  // A line with nothing at all on it is a mis-key.
  if (!D.gt(D.add(packs, free), D.ZERO)) throw invalid(`${medicine.brandName}: nothing received on this line`, { ...details, field: 'qtyPacks' })

  const ratePerPack = decimalOr(line.ratePerPack, '0', `${medicine.brandName}: rate must be an amount`, { ...details, field: 'ratePerPack' })
  if (D.isNeg(ratePerPack)) throw invalid(`${medicine.brandName}: rate cannot be negative`, { ...details, field: 'ratePerPack' })

  const mrpPerPack = decimalOr(line.mrpPerPack, '0', `${medicine.brandName}: MRP must be an amount`, { ...details, field: 'mrpPerPack' })
  // MRP is part of batch identity and is the ceiling the pack may be sold at, so
  // a zero would create an unsellable batch that prices every sale at nothing.
  if (!D.gt(mrpPerPack, D.ZERO)) throw invalid(`${medicine.brandName}: the printed MRP is required`, { ...details, field: 'mrpPerPack' })

  const discountPct = decimalOr(line.discountPct, '0', `${medicine.brandName}: discount must be a percentage`, { ...details, field: 'discountPct' })
  if (D.isNeg(discountPct) || D.gt(discountPct, D.HUNDRED)) {
    throw invalid(`${medicine.brandName}: discount must be between 0 and 100`, { ...details, field: 'discountPct' })
  }

  const gstRatePct = decimalOr(line.gstRatePct, '0', `${medicine.brandName}: GST rate must be a percentage`, { ...details, field: 'gstRatePct' })
  if (D.isNeg(gstRatePct) || D.gt(gstRatePct, D.HUNDRED)) {
    throw invalid(`${medicine.brandName}: GST rate must be between 0 and 100`, { ...details, field: 'gstRatePct' })
  }

  const gross = D.round(D.mul(ratePerPack, packs), 2)
  const discount = D.round(D.percentOf(gross, discountPct), 2)
  return {
    input: line,
    medicine,
    expiryDate: normaliseExpiry(line.expiry ?? ''),
    packs,
    free,
    unitsReceived: D.mul(D.add(packs, free), D.dec(medicine.unitsPerPack)),
    gross,
    discount,
    taxable: D.sub(gross, discount),
    mrpPerPack,
    ratePerPack,
    gstRatePct: pctStr(gstRatePct),
    discountPct: pctStr(discountPct),
  }
}

/**
 * Price a goods receipt. Pure, read-only, allocates nothing.
 *
 * Freight is apportioned across the lines by VALUE with largest-remainder
 * (`domain/gst.apportion`), so the shares sum to exactly the freight charged —
 * the same mechanism the bill discount uses on the sale side, and for the same
 * reason: a cost that does not sum to itself makes every landed cost downstream
 * un-auditable. It rides into landed cost and stays OUT of the line total,
 * because the supplier charges it once at the bottom of the bill.
 */
export function pricePurchase(input: PurchaseInvoiceInput, ctx: PurchasePricingContext): PricedPurchase {
  const supplierInvoiceNo = collapse(input.supplierInvoiceNo ?? '')
  if (!supplierInvoiceNo) {
    throw invalid('The distributor’s invoice number is required', { field: 'supplierInvoiceNo' })
  }
  if (!input.lines || input.lines.length === 0) {
    throw invalid('Nothing to receive', { field: 'lines' })
  }
  const invoiceDate = (input.invoiceDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    throw invalid('The invoice date is required', { field: 'invoiceDate' })
  }

  const freight = decimalOr(input.freight, '0', 'Freight must be an amount', { field: 'freight' })
  if (D.isNeg(freight)) throw invalid('Freight cannot be negative', { field: 'freight' })

  const working = input.lines.map((line) => validateLine(line, ctx))
  const interState = isInterStateSupply(ctx.supplier.gstin, ctx.storeStateCode)

  // Apportioned on line VALUE, not on units: a carton of syrup and a carton of
  // tablets do not cost the same to bring, and value is the only weight both the
  // supplier and the auditor can see.
  //
  // A bill with no value on it at all — a pure-scheme delivery, or one discounted
  // to nothing — still costs money to bring, and `apportion` over all-zero
  // weights returns all zeros. Falling back to units received is what stops that
  // freight from landing NOWHERE: it is charged on the invoice either way, so a
  // zero share would carry the goods at no cost and report a margin the shop is
  // not earning, which is the same fault dividing by paid-only makes.
  const byValue = working.some((w) => !D.isZero(w.taxable))
  const freightShares = apportion(freight, working.map((w) => (byValue ? w.taxable : w.unitsReceived)))

  const lines: PricedLine[] = working.map((w, i) => {
    const freightShare = freightShares[i] ?? D.ZERO
    const tax = taxOn(w.taxable, w.gstRatePct)
    // Halves as a residual, so cgst + sgst is exactly the tax and the line foots.
    const cgst = interState ? D.ZERO : D.round(D.div(tax, D.dec(2)), 2)
    const sgst = interState ? D.ZERO : D.sub(tax, cgst)
    const igst = interState ? tax : D.ZERO
    const lineTotal = D.add(w.taxable, tax)

    // THE INVARIANT: paid + free in the denominator, and the GST left out of the
    // numerator because input credit makes it recoverable — it is a receivable,
    // not a cost. Freight is a cost, so it goes in.
    const landedCostPerUnit = D.gt(w.unitsReceived, D.ZERO)
      ? D.round(D.div(D.add(w.taxable, freightShare), w.unitsReceived), 4)
      : D.ZERO
    // PTR is per PAID unit — free goods have no price to the retailer — and that
    // is exactly what separates it from landed cost two lines up. A pure-scheme
    // line has no PTR at all rather than a zero one.
    const paidUnits = D.mul(w.packs, D.dec(w.medicine.unitsPerPack))
    const ptrPerUnit = D.gt(paidUnits, D.ZERO) ? D.round(D.div(w.taxable, paidUnits), 4) : D.ZERO
    const lastRate = ctx.lastRatePerPack(w.medicine.id)

    const line: PurchaseLine = {
      lineId: w.input.lineId,
      medicineId: w.medicine.id,
      batchNo: collapse(w.input.batchNo),
      // As the operator keyed it and as the strip prints it — MM/YY. The
      // document records the PAPER; the last-day-of-month date it normalises to
      // lives on the batch the receipt creates, and travels there on
      // `PricedLine.expiryDate` rather than by being re-parsed downstream.
      expiry: collapse(w.input.expiry),
      qtyPacks: qtyStr(w.packs),
      freePacks: qtyStr(w.free),
      mrpPerPack: money(w.mrpPerPack),
      ratePerPack: money(w.ratePerPack),
      discountPct: w.discountPct,
      gstRatePct: w.gstRatePct,
      brandName: w.medicine.brandName,
      packLabel: w.medicine.packLabel,
      unitsPerPack: w.medicine.unitsPerPack,
      taxableValue: money(w.taxable),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      lineTotal: money(lineTotal),
      landedCostPerUnit: unitMoney(landedCostPerUnit),
      // A distributor's rate moving between bills is the single most useful
      // thing this screen can point at: it is either a price revision to pass on
      // or a keying error to query before the stock is priced against it.
      rateChangedFrom: lastRate !== null && !D.eq(D.dec(lastRate), w.ratePerPack) ? lastRate : null,
      batchId: null,
    }

    return {
      line,
      medicine: w.medicine,
      expiryDate: w.expiryDate,
      unitsReceived: w.unitsReceived,
      landedCostPerUnit,
      ptrPerUnit,
      mrpPerUnit: mrpPerUnit(w.mrpPerPack, w.medicine.unitsPerPack),
    }
  })

  const taxableValue = D.sum(lines.map((l) => D.dec(l.line.taxableValue)))
  const cgst = D.sum(lines.map((l) => D.dec(l.line.cgst)))
  const sgst = D.sum(lines.map((l) => D.dec(l.line.sgst)))
  const igst = D.sum(lines.map((l) => D.dec(l.line.igst)))
  const beforeRounding = D.add(D.sum(lines.map((l) => D.dec(l.line.lineTotal))), freight)
  const { rounded, adjustment } = ctx.roundOffEnabled
    ? roundOff(beforeRounding)
    : { rounded: beforeRounding, adjustment: D.ZERO }

  const notes = collapse(input.notes ?? '')
  const invoice: PricedInvoice = {
    storeId: ctx.storeId,
    supplierId: ctx.supplier.id,
    supplierName: ctx.supplier.name,
    supplierInvoiceNo,
    invoiceDate,
    createdAt: ctx.createdAt,
    lines: lines.map((l) => l.line),
    taxableValue: money(taxableValue),
    cgst: money(cgst),
    sgst: money(sgst),
    igst: money(igst),
    freight: money(freight),
    roundOff: money(adjustment),
    netAmount: money(rounded),
    // A goods receipt records what is OWED. Paying it is a separate document,
    // which is why the supplier's outstanding moves and this stays at zero.
    amountPaid: '0.00',
    status: 'POSTED',
    notes: notes ? notes : null,
  }

  return { invoice, lines, interState }
}

// -------------------------------------------------------------- precheck ---

/** Trailing/leading noise and case are not what makes two bill numbers differ. */
const normaliseInvoiceNo = (raw: string): string => collapse(raw).toUpperCase()

export function findDuplicatePurchase(
  existing: readonly PurchaseInvoice[],
  supplierId: number,
  supplierInvoiceNo: string,
): PurchaseInvoice | undefined {
  const key = normaliseInvoiceNo(supplierInvoiceNo)
  if (!key) return undefined
  return existing.find(
    (p) =>
      p.supplierId === supplierId &&
      p.status !== 'CANCELLED' &&
      normaliseInvoiceNo(p.supplierInvoiceNo) === key,
  )
}

/**
 * What `postPurchase` must decide before it writes anything.
 *
 * ORDER MATTERS. A replayed idempotency key returns the original document; it is
 * not a duplicate, and treating it as one would make the offline outbox unable
 * to retry a receipt whose response was lost. Only a genuinely new request is
 * then checked against the supplier's bill numbers — keying the same distributor
 * invoice twice is the most common goods-receipt error there is, and it doubles
 * both the stock and the payable.
 *
 * Returns the original document to hand straight back, or null to go on and post.
 */
export function precheckPurchase(
  input: Pick<PurchaseInvoiceInput, 'supplierId' | 'supplierInvoiceNo'>,
  deps: { replay: PurchaseInvoice | undefined; existing: readonly PurchaseInvoice[] },
): PurchaseInvoice | null {
  if (deps.replay) return deps.replay
  const clash = findDuplicatePurchase(deps.existing, input.supplierId, input.supplierInvoiceNo ?? '')
  if (clash) {
    throw new ApiError({
      code: 'PURCHASE_EXISTS',
      message: `Invoice ${clash.supplierInvoiceNo} from ${clash.supplierName} was already received on ${clash.invoiceDate}`,
      // The original rides on the error so the screen can OPEN it rather than
      // leaving the operator to go and find the thing they were just told about.
      details: clash,
    })
  }
  return null
}

// -------------------------------------------------------------- suppliers ---

function supplierInvalid(field: string, message: string): ApiError {
  return new ApiError({ code: 'SUPPLIER_INVALID', message, details: { field } })
}

/**
 * A distributor's number is not a customer's mobile.
 *
 * It is routinely a landline with an STD code, a board number, or a number with
 * an extension, so this normalises to digits and asks only that there are enough
 * of them to be a phone. Demanding ten mobile digits here would block real
 * suppliers from being created at all.
 */
function supplierPhoneDigits(raw: string): string {
  return raw.replace(/\D/g, '')
}

/**
 * TWO keys, not one.
 *
 * The GSTIN is the strongest identity a business has, so two rows carrying the
 * same one are the same distributor however the name was typed. But the name has
 * to match on its own as well: a single key would let "Sanjivani Pharma" with a
 * GSTIN and "sanjivani  pharma" without one sit side by side forever, and half
 * the shop's payables would then be filed against a distributor that does not
 * exist. Case and spacing are deliberately not part of either key.
 */
export function findExistingSupplier(
  rows: readonly Supplier[],
  candidate: { name: string; gstin: string | null },
): Supplier | undefined {
  const gstin = candidate.gstin?.toUpperCase()
  const name = collapse(candidate.name).toLowerCase()
  return rows.find(
    (s) =>
      (gstin !== undefined && s.gstin?.toUpperCase() === gstin) ||
      collapse(s.name).toLowerCase() === name,
  )
}

type SupplierFields = Omit<Supplier, 'id' | 'storeId' | 'outstanding'>

export function validateSupplier(input: SupplierInput): SupplierFields {
  const name = collapse(input.name ?? '')
  if (!name) throw supplierInvalid('name', "The distributor's name is required")

  const phone = supplierPhoneDigits(input.phone ?? '')
  if (phone.length < 8) throw supplierInvalid('phone', 'Enter a contact number for the distributor')

  const gstinRaw = (input.gstin ?? '').trim().toUpperCase()
  // Validated rather than stored as typed, because the STATE CODE in it decides
  // IGST versus CGST+SGST on every bill this supplier ever sends. A mistyped
  // GSTIN does not fail loudly; it silently books the wrong input credit.
  if (gstinRaw && !GSTIN_RE.test(gstinRaw)) {
    throw supplierInvalid('gstin', `${gstinRaw} is not a valid GSTIN`)
  }
  if (gstinRaw && !validStateCode(gstinRaw)) {
    throw supplierInvalid('gstin', `${gstinRaw.slice(0, 2)} is not a state code — the first two digits are 01–38, 97 or 99`)
  }

  const terms = input.paymentTermsDays ?? 0
  if (!Number.isSafeInteger(terms) || terms < 0 || terms > 365) {
    throw supplierInvalid('paymentTermsDays', 'Payment terms are a whole number of days, 0 to 365')
  }

  const creditLimit = (input.creditLimit ?? '0').trim() || '0'
  if (!/^\d+(\.\d{1,2})?$/.test(creditLimit)) {
    throw supplierInvalid('creditLimit', 'Credit limit must be an amount like 50000.00')
  }

  const address = collapse(input.address ?? '')
  const dlNo = collapse(input.dlNo ?? '')

  /* Shape only, and a real calendar day. A licence recorded as 2027-02-30 would
     sort correctly, render as a date, and silently never expire — the renewal
     alarm this field exists for would simply not fire. */
  const validUpto = (input.dlValidUpto ?? '').trim()
  if (validUpto && !isCalendarDate(validUpto)) {
    throw supplierInvalid('dlValidUpto', `${validUpto} is not a date — use YYYY-MM-DD`)
  }

  return {
    name,
    phone,
    address: address ? address : null,
    gstin: gstinRaw ? gstinRaw : null,
    // Legally required on a purchase bill, but a distributor master is often
    // built before the paperwork is to hand; the receipt screen is where it is
    // chased, not the create form.
    dlNo: dlNo ? dlNo : null,
    dlValidUpto: validUpto ? validUpto : null,
    paymentTermsDays: terms,
    creditLimit: D.toStr(D.dec(creditLimit), 2),
  }
}

/** `YYYY-MM-DD` that survives a round trip — so 2027-02-30 is refused, not slid. */
function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00`)
  return !Number.isNaN(d.getTime()) && v === iso(d)
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function prepareSupplier(
  input: SupplierInput,
  existing: readonly Supplier[],
): Omit<Supplier, 'id' | 'storeId'> {
  const fields = validateSupplier(input)
  const clash = findExistingSupplier(existing, fields)
  if (clash) {
    throw new ApiError({
      code: 'SUPPLIER_EXISTS',
      message: `${clash.name} is already on the distributor list`,
      details: clash,
    })
  }
  // A new supplier is owed nothing. An opening balance is a document, never a
  // number typed into a create form.
  return { ...fields, outstanding: '0.00' }
}

/** An absent key means "unchanged", so the merge happens BEFORE validation and
 *  the whole row is re-checked — the same rule `applyMedicineUpdate` follows. */
export function applySupplierUpdate(
  current: Supplier,
  patch: Partial<SupplierInput>,
  existing: readonly Supplier[],
): Supplier {
  const merged: SupplierInput = {
    name: patch.name ?? current.name,
    phone: patch.phone ?? current.phone,
    address: patch.address ?? current.address ?? undefined,
    gstin: patch.gstin ?? current.gstin ?? undefined,
    dlNo: patch.dlNo ?? current.dlNo ?? undefined,
    dlValidUpto: patch.dlValidUpto ?? current.dlValidUpto ?? undefined,
    paymentTermsDays: patch.paymentTermsDays ?? current.paymentTermsDays,
    creditLimit: patch.creditLimit ?? current.creditLimit,
  }
  const fields = validateSupplier(merged)
  const clash = findExistingSupplier(existing.filter((s) => s.id !== current.id), fields)
  if (clash) {
    throw new ApiError({
      code: 'SUPPLIER_EXISTS',
      message: `${clash.name} is already on the distributor list`,
      details: clash,
    })
  }
  // `outstanding` is the sum of documents and is never editable through a form.
  return { ...current, ...fields }
}

/** Name, number, GSTIN or drug licence — whichever of them is on the bill in
 *  the operator's hand when they are trying to find the distributor again. */
export function matchesSupplier(s: Supplier, q: string): boolean {
  const term = q.toLowerCase()
  // Only when the term actually holds digits: `''.includes('')` is true, so a
  // name search would otherwise match every supplier through the phone clause.
  const digits = supplierPhoneDigits(term)
  return (
    s.name.toLowerCase().includes(term) ||
    (digits.length > 0 && supplierPhoneDigits(s.phone).includes(digits)) ||
    (s.gstin ?? '').toLowerCase().includes(term) ||
    (s.dlNo ?? '').toLowerCase().includes(term)
  )
}
