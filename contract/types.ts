/**
 * THE CONTRACT.
 *
 * Single source of truth for the API surface. The Phase-1 mock (`localAdapter`)
 * and the Phase-5 Rust server both implement exactly this, so swapping them is an
 * adapter change and not a rewrite.
 *
 * MONEY IS A DECIMAL STRING. Never a number. IEEE-754 rounds ties to even while
 * the statutory rule rounds 50 paise up, and a float cannot represent 0.1 at all.
 * Parse only inside `web/src/domain` (or `crates/domain`), format only at the
 * display boundary.
 */

/** A fixed-point decimal, e.g. "1284.50". Never parse with Number() outside domain/. */
export type Money = string
/** Quantity in BASE units (tablets, ml, grams), e.g. "4" or "0.5". */
export type Qty = string
/** A percentage, e.g. "5" or "12.5". */
export type Pct = string
/** ISO calendar date, "YYYY-MM-DD". */
export type IsoDate = string

export const DRUG_SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X', 'NRx'] as const
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number]

export const DOSAGE_FORMS = [
  'Tablet', 'Capsule', 'Syrup', 'Injection', 'Ointment', 'Drops',
  'Inhaler', 'Powder', 'Sachet', 'Device', 'Surgical', 'Other',
] as const
export type DosageForm = (typeof DOSAGE_FORMS)[number]

export const BASE_UOMS = ['TAB', 'CAP', 'ML', 'GM', 'BOTTLE', 'VIAL', 'TUBE', 'UNIT'] as const
export type BaseUom = (typeof BASE_UOMS)[number]

export const PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

// ---------------------------------------------------------------- masters ---

export interface Medicine {
  id: number
  storeId: number
  brandName: string
  genericName: string | null
  /** Salt / composition — what a pharmacist actually substitutes on. */
  compositionText: string
  manufacturer: string
  form: DosageForm
  strengthText: string
  /** How the pack is printed, e.g. "10x10", "1x15", "60ml". */
  packLabel: string
  /** Base units in ONE sale pack — 10 tablets in a strip. */
  unitsPerPack: number
  baseUom: BaseUom
  /** Whether a strip may be cut. Schedule H1 and injections generally may not. */
  allowLooseSale: boolean
  /** Smallest sellable increment in base units. */
  saleStep: Qty
  hsnCode: string
  drugSchedule: DrugSchedule
  requiresPrescription: boolean
  rackLocation: string | null
  /** Reorder trigger, in base units. */
  reorderLevel: number
  /** Dispense count over the last 90 days. Drives search ranking. */
  saleRank: number
  isActive: boolean
}

/**
 * A batch, not a product, is the stock-keeping unit.
 *
 * IDENTITY IS (store, medicine, batchNo, expiry, MRP) — MRP is part of the key.
 * The same printed batch number legitimately arrives at a revised MRP, and the
 * customer pays what is printed on the strip in their hand.
 */
export interface Batch {
  id: number
  storeId: number
  medicineId: number
  batchNo: string
  /** Last day of the PRINTED expiry month. "11/27" is stored as 2027-11-30. */
  expiryDate: IsoDate
  /** MRP of one pack, GST-INCLUSIVE. */
  mrpPerPack: Money
  /** MRP of one base unit at 4dp. Derived, stored, and never recomputed in a view. */
  mrpPerUnit: Money
  /** Price to retailer, per base unit, GST-exclusive. */
  ptrPerUnit: Money
  /** Cost over (paid + free) units. Divide by paid only and margin is ~9% wrong. */
  landedCostPerUnit: Money
  /** The rate FROZEN at purchase, for ITC. Not the rate this batch sells at. */
  purchaseGstPct: Pct
  qtyOnHand: Qty
  /** Blocked stock never allocates: expired, damaged, or awaiting supplier return. */
  isQuarantined: boolean
}

export interface MedicineSearchHit {
  medicine: Medicine
  /** Total sellable base units across non-expired, non-quarantined batches. */
  stockQty: Qty
  /** Cheapest-expiry sellable batch, i.e. what FEFO would pick. */
  fefoBatch: Batch | null
  /** Distinct live batches — >1 means the batch chip strip has real choices. */
  batchCount: number
  /** Why this matched, for the UI to explain the result ordering. */
  matchedOn: 'barcode' | 'brand' | 'generic' | 'composition' | 'manufacturer'
  /** True when the medicine is known but has no sellable stock. */
  outOfStock: boolean
}

/**
 * A prescriber.
 *
 * Rule 65 puts the prescriber's name and address on the bill for a prescription
 * sale, and the Schedule H1 register wants the registration number too — so the
 * doctor is a real master record, not free text retyped on every bill. Retyping
 * is also how a register ends up with four spellings of the same physician.
 */
export interface Doctor {
  id: number
  storeId: number
  name: string
  registrationNo: string | null
  qualification: string | null
  clinicName: string | null
  phone: string | null
  /** Bills carrying this prescriber. Orders the quick-pick list. */
  prescriptionCount: number
}

export interface DoctorInput {
  name: string
  registrationNo?: string
  qualification?: string
  clinicName?: string
  phone?: string
}

export interface CustomerInput {
  name: string
  phone: string
  address?: string
  gstin?: string
  allergies?: string[]
  creditLimit?: Money
}

export interface Customer {
  id: number
  storeId: number
  name: string
  phone: string
  address: string | null
  gstin: string | null
  /** Shown as a strip on the bill; a real dispensing safety control. */
  allergies: string[]
  creditLimit: Money
  outstanding: Money
}

/**
 * How money came IN against an account. Never CREDIT — a receipt is what
 * SETTLES credit, so allowing that mode would let a payment increase the debt
 * it was raised to clear.
 */
export type ReceiptMode = Exclude<PaymentMode, 'CREDIT'>

export interface CustomerReceiptInput {
  customerId: number
  amount: Money
  mode: ReceiptMode
  /** UPI reference, cheque number, card approval code. */
  reference?: string
  note?: string
}

/**
 * Money taken against a customer's account, as a DOCUMENT.
 *
 * A screen that simply decrements `Customer.outstanding` when cash is handed
 * over produces a balance nobody can reconstruct: the figure moves and the only
 * evidence is that it moved. So the receipt is the record and the balance
 * follows from it — the same rule the stock ledger follows, and the reason
 * `balanceAfter` is stored rather than recomputed on read.
 *
 * A receipt is not allocated to a particular bill. At an Indian counter the
 * customer hands over a round sum against "the account", and inventing an
 * allocation nobody made is worse than showing the money as what it is; the
 * ageing applies it oldest-bill-first for display, which is the convention, and
 * says so.
 */
export interface CustomerReceipt {
  id: number
  storeId: number
  /** Its own series. This is what the slip handed across the counter says. */
  receiptNo: string
  customerId: number
  /** Full timestamp. Two receipts on one day still have an order. */
  at: string
  date: IsoDate
  amount: Money
  mode: ReceiptMode
  reference: string | null
  note: string | null
  /** The account balance AFTER this receipt, so the ledger is self-checking. */
  balanceAfter: Money
}

// ------------------------------------------------------------------ quote ---

export interface QuoteLineInput {
  /** Client-generated, stable across re-quotes. Keys the cart row. */
  lineId: string
  medicineId: number
  qty: Qty
  freeQty?: Qty
  discountPct?: Pct
  /**
   * Manual batch selection. When absent the server allocates by FEFO.
   * When present it is honoured exactly, and a reason code is required to post.
   */
  batchOverride?: Array<{ batchId: number; qty: Qty }>
  /**
   * A dispensing instruction for THIS line — "1-0-1 after food", "for the
   * child, half tablet". It is written at the counter, printed under the item
   * on the receipt, and is the single thing a customer rings back about.
   * Free text, never parsed: a structured dosage field would be wrong in a
   * different way for every prescriber.
   */
  note?: string
}

export interface QuoteRequest {
  storeId: number
  /** The OUTPUT GST rate is resolved from this date, never from the batch. */
  invoiceDate: IsoDate
  /** Inter-state supply bills IGST instead of CGST+SGST. */
  interState: boolean
  customerId?: number
  billDiscountPct?: Pct
  lines: QuoteLineInput[]
}

/** One batch's share of a cart row. A row can fan out across several batches. */
export interface QuoteAllocation {
  batchId: number
  batchNo: string
  expiryDate: IsoDate
  qty: Qty
  freeQty: Qty
  mrpPerUnit: Money
  /** Actual selling price per unit, GST-inclusive. Never above the printed MRP. */
  ratePerUnit: Money
  grossAmount: Money
  discountAmount: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  lineTotal: Money
  gstRatePct: Pct
  /** Cost basis snapshotted for the margin report. */
  costBasis: Money
  /** Set when this batch reprices the row: two batches, two printed MRPs. */
  repricedFrom?: Money
}

export type QuoteWarningCode =
  | 'INSUFFICIENT_STOCK'
  | 'NEAR_EXPIRY'
  | 'MIXED_MRP'
  | 'PRESCRIPTION_REQUIRED'
  | 'SCHEDULE_H1'
  | 'LOOSE_SALE_NOT_ALLOWED'
  | 'ALLERGY_CONFLICT'

export interface QuoteWarning {
  code: QuoteWarningCode
  lineId?: string
  message: string
  /** Blocking warnings prevent posting; the rest are advisory. */
  blocking: boolean
}

export interface QuoteLine {
  lineId: string
  medicineId: number
  brandName: string
  packLabel: string
  hsnCode: string
  drugSchedule: DrugSchedule
  requestedQty: Qty
  allocatedQty: Qty
  /** Requested minus allocated. Drives the short-book prompt. */
  shortQty: Qty
  allocations: QuoteAllocation[]
  discountPct: Pct
  grossAmount: Money
  discountAmount: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  lineTotal: Money
  manualBatch: boolean
  /** Echoed back from the input so the receipt can print it under the item. */
  note?: string
}

/** One row per DISTINCT rate: a real pharmacy bill mixes nil, 5% and 18%. */
export interface TaxBreakupRow {
  gstRatePct: Pct
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  total: Money
}

export interface Quote {
  lines: QuoteLine[]
  grossAmount: Money
  itemDiscount: Money
  billDiscountPct: Pct
  billDiscount: Money
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  roundOff: Money
  netAmount: Money
  taxBreakup: TaxBreakupRow[]
  warnings: QuoteWarning[]
  /** Total cost of goods, for the margin report. */
  costOfGoods: Money
}

// ------------------------------------------------------------------- sale ---

export interface PaymentInput {
  mode: PaymentMode
  amount: Money
  reference?: string
}

export interface PrescriptionInput {
  /** Links the bill to the doctor master; the name is snapshotted alongside it. */
  prescriberId?: number
  prescriberName: string
  prescriberRegNo?: string
  prescriberAddress?: string
  patientName: string
  patientAddress?: string
  prescriptionDate: IsoDate
}

export interface PostSaleRequest {
  /** Replaying the same key returns the ORIGINAL response, byte for byte. */
  idempotencyKey: string
  terminalId: number
  quote: QuoteRequest
  payments: PaymentInput[]
  prescription?: PrescriptionInput
  /** Required whenever any line used a manual batch override. */
  batchOverrideReason?: string
  customerId?: number
  /** A bill-level remark: "home delivery 6pm", "balance collected by son". */
  note?: string
}

export interface SaleInvoice {
  id: number
  /** Gapless per (store, financial year, terminal). Allocated last before commit. */
  invoiceNo: string
  storeId: number
  terminalId: number
  invoiceDate: IsoDate
  createdAt: string
  customerId: number | null
  customerName: string | null
  customerPhone: string | null
  interState: boolean
  quote: Quote
  payments: PaymentInput[]
  amountPaid: Money
  changeDue: Money
  status: 'POSTED' | 'VOIDED'
  prescription: PrescriptionInput | null
  operatorName: string
  /**
   * Why the bill was cancelled, in the operator's words, and when.
   *
   * Optional because a POSTED invoice carries neither, not because a void may
   * omit them: `voidSale` refuses without a reason. A voided document is never
   * removed — it stays in the register marked VOIDED, because a vanished
   * document is what concealment looks like to an auditor and because the
   * number it consumed still has to be accounted for in the GSTR-1 document
   * series (total, cancelled, net).
   */
  voidReason?: string
  voidedAt?: string
  /** The counter's own remark, snapshotted with the bill and printed on it. */
  note?: string
}

export interface HeldBill {
  token: number
  label: string
  savedAt: string
  itemCount: number
  netAmount: Money
  lines: QuoteLineInput[]
  customerId?: number
  /** A parked bill keeps its remark, or the note dies with the interruption. */
  note?: string
}

// --------------------------------------------------------------- settings ---

export interface StoreProfile {
  id: number
  name: string
  tagline: string | null
  addressLine: string
  city: string
  state: string
  stateCode: string
  phone: string
  email: string | null
  gstin: string
  /** Drug licence numbers. Legally required on every retail bill. */
  dlNos: string[]
  invoicePrefix: string
  financialYearStartMonth: number
  currency: string
  /** Days before expiry at which a batch stops being auto-allocated. */
  expiryGuardDays: number
  nearExpiryBuckets: number[]
  roundOffEnabled: boolean
  allowNegativeStock: boolean
  upiVpa: string | null
  footerNote: string
  /**
   * The statutory thresholds this shop files under — CONFIGURATION, not law.
   *
   * Every value here is recorded in `docs/UNVERIFIED.md` as unverified or
   * conflicting, and the honest way to ship an unverified number is as a
   * setting with its default stated on screen, never as a constant compiled
   * into a validator that then reports a shop as non-compliant on RxBill's own
   * authority. A rate change or a notification becomes an edit, not a deploy.
   */
  filing: FilingThresholds
}

/** A partial store edit. `filing` merges rather than replaces. */
export type StoreProfilePatch =
  Partial<Omit<StoreProfile, 'id' | 'filing'>> & { filing?: Partial<FilingThresholds> }

export interface FilingThresholds {
  /**
   * Value at or above which a B2C inter-state invoice becomes B2CL.
   *
   * The GST portal's own FAQ and the offline-tool manual disagree (₹1,00,000 vs
   * ₹2,50,000), so this ships at the higher figure and says which it used
   * wherever it is applied. Nothing is filed on it; it only decides which
   * bucket the pre-file check counts an invoice into.
   */
  b2clMinimum: Money
  /** Value at or above which Rule 46 wants the recipient's name and address. */
  rule46Minimum: Money
  /** HSN digits Table 12 expects at this shop's turnover. 4, 6 or 8. */
  hsnDigits: number
}

/**
 * One thing wrong with the period, found before it is filed rather than after.
 *
 * Severity is the whole point of the type. A `blocker` is something the portal
 * or the law will reject; a `warning` is something a human should look at and
 * may legitimately accept. Reporting the second as the first is how a
 * compliance screen trains people to ignore it.
 */
export interface FilingIssue {
  code: string
  severity: 'blocker' | 'warning'
  /** What is wrong, in one line, naming the document. */
  title: string
  /** Why it matters and what to do. */
  detail: string
  /** The documents affected, newest first. Capped — the count is the truth. */
  refs: string[]
  count: number
}

/** GSTR-1 wants each series reported as total, cancelled and net. */
export interface DocSeriesSummary {
  label: string
  from: string
  to: string
  total: number
  cancelled: number
  net: number
}

export interface FilingCheck {
  from: IsoDate
  to: IsoDate
  gstin: string
  generatedAt: string
  issues: FilingIssue[]
  /** Table 13: documents issued, as total / cancelled / net per series. */
  series: DocSeriesSummary[]
  /** Rate-wise outward supply, the figure the return is built on. */
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  /** Counts by bucket, so the shape of the period is visible at a glance. */
  buckets: Array<{ key: string; label: string; count: number; taxableValue: Money }>
  /** True when nothing would stop this period being filed. */
  ready: boolean
  /** Every threshold the check used, and where it came from. Printed. */
  basis: string[]
}


// -------------------------------------------------------------- medicines ---

export interface MedicineInput {
  brandName: string
  genericName?: string
  compositionText: string
  manufacturer: string
  form: DosageForm
  strengthText: string
  packLabel: string
  unitsPerPack: number
  baseUom: BaseUom
  allowLooseSale: boolean
  saleStep: Qty
  hsnCode: string
  drugSchedule: DrugSchedule
  rackLocation?: string
  reorderLevel: number
}

/**
 * A hole in the master, as a filter axis.
 *
 * Each of these is cheap to fix today and expensive later, somewhere else
 * entirely: GSTR-1 Table 12 is built from HSN and a blank one stops the return;
 * a pack with no code linked is typed by hand at the counter forever; the
 * reorder suggestion is blind to a row whose level is zero; and nobody can find
 * an item whose rack was never set. `neverSold` is not a hole but the same
 * shape of question — a row the shop has never dispensed is either dead money
 * on the shelf or a duplicate of something that does sell.
 */
export const MEDICINE_GAPS = ['hsn', 'barcode', 'reorder', 'rack', 'neverSold'] as const
export type MedicineGap = (typeof MEDICINE_GAPS)[number]

/**
 * Gap counts across the whole LIVE catalogue — never across the filtered page.
 *
 * "Twelve of the fifty rows you are looking at have no HSN" is not a number
 * anyone can act on; "612 of 1,595 items have no HSN" is a morning's work with
 * an end to it. Delisted rows are excluded for the same reason: nothing is
 * gained by fixing the HSN of something that can no longer be sold.
 */
export interface MedicineQuality {
  active: number
  inactive: number
  hsn: number
  barcode: number
  reorder: number
  rack: number
  neverSold: number
}

export interface MedicineFilters {
  term?: string
  schedule?: DrugSchedule
  manufacturer?: string
  /** 'low' is at-or-below the reorder level but not zero. */
  stock?: 'all' | 'in' | 'low' | 'out'
  expiry?: 'all' | 'expired' | 'd30' | 'd90' | 'd180'
  /** Narrow to rows carrying one data-quality gap. */
  gap?: MedicineGap
  onlyInactive?: boolean
  sort?: 'name' | 'stock' | 'saleRank' | 'value'
  limit?: number
  cursor?: number
}

/** A catalogue row already joined to its stock, so the grid does not N+1. */
export interface MedicineRow {
  medicine: Medicine
  stockQty: Qty
  batchCount: number
  /** Nearest expiry among sellable batches. */
  nearestExpiry: IsoDate | null
  /** Stock at MRP and at landed cost — the two numbers an owner asks for. */
  valueAtMrp: Money
  valueAtCost: Money
  barcodes: string[]
}

export interface MedicinePage {
  rows: MedicineRow[]
  total: number
  nextCursor: number | null
  /** Distinct manufacturers across the whole catalogue, for the filter. */
  manufacturers: string[]
  /**
   * Also across the whole catalogue, and deliberately on every page rather than
   * behind its own endpoint: the counts have to be on screen the moment the grid
   * paints, and a second round trip would let the header and the grid disagree
   * about the catalogue for a beat after every edit.
   */
  quality: MedicineQuality
}

// -------------------------------------------------------------- inventory ---

export const LEDGER_REASONS = [
  'OPENING', 'PURCHASE', 'SALE', 'SALE_RETURN',
  'PURCHASE_RETURN', 'ADJUSTMENT', 'EXPIRY_WRITEOFF', 'TRANSFER',
] as const
export type LedgerReason = (typeof LEDGER_REASONS)[number]

/**
 * One movement. Append-only: a correction is another row, never an edit.
 * `balanceAfter` makes the ledger self-checking — it must reconcile to
 * batches.qtyOnHand, and a mismatch is a real alarm, not a rounding artefact.
 */
export interface StockMovement {
  id: number
  at: string
  batchId: number
  batchNo: string
  medicineId: number
  brandName: string
  qtyDelta: Qty
  balanceAfter: Qty
  reason: LedgerReason
  refType: string
  refId: string
  note: string | null
}

export interface BatchRow {
  batch: Batch
  medicine: Medicine
  daysToExpiry: number
  bucket: 'expired' | 'd30' | 'd60' | 'd90' | 'd180' | 'ok'
  valueAtMrp: Money
  valueAtCost: Money
}

export interface InventoryFilters {
  term?: string
  bucket?: 'all' | 'expired' | 'd30' | 'd60' | 'd90' | 'd180'
  stock?: 'all' | 'low' | 'out' | 'quarantined'
  manufacturer?: string
  sort?: 'expiry' | 'value' | 'name' | 'qty'
  limit?: number
  cursor?: number
}

export interface InventorySummary {
  totalBatches: number
  totalSkus: number
  stockValueAtCost: Money
  stockValueAtMrp: Money
  /** Value sitting on batches inside each near-expiry bucket. */
  atRisk: Array<{ bucket: string; days: number; batches: number; valueAtCost: Money }>
  lowStockSkus: number
  outOfStockSkus: number
  quarantinedBatches: number
  /** Ledger-vs-batch reconciliation. Non-zero is an alarm, not a rounding artefact. */
  reconciliationDiscrepancies: number
}

export interface StockAdjustmentInput {
  batchId: number
  /** Signed. Negative writes stock off; positive corrects an undercount. */
  qtyDelta: Qty
  reason: 'ADJUSTMENT' | 'EXPIRY_WRITEOFF'
  /** Mandatory. An unexplained adjustment is indistinguishable from shrinkage. */
  note: string
}

// -------------------------------------------------------------- purchases ---

export interface SupplierInput {
  name: string
  phone: string
  address?: string
  gstin?: string
  /** Drug licence number — legally required on every purchase bill. */
  dlNo?: string
  /**
   * The day that licence stops being valid. `''` clears it.
   *
   * A wholesale licence (Form 20B/21B) runs five years and is renewable; buying
   * from a distributor whose licence lapsed makes the RECEIVING pharmacy's own
   * stock unaccounted for at inspection, so the date is worth as much as the
   * number and is the half every supplier master leaves out.
   */
  dlValidUpto?: string
  paymentTermsDays?: number
  creditLimit?: Money
}

export interface Supplier {
  id: number
  storeId: number
  name: string
  phone: string
  address: string | null
  gstin: string | null
  dlNo: string | null
  /**
   * When the drug licence lapses. Null when nobody has recorded it.
   *
   * Optional on the interface rather than required, because a row written
   * before this field existed genuinely does not carry one and a stand-in date
   * would read as a licence that is good until then.
   */
  dlValidUpto?: IsoDate | null
  paymentTermsDays: number
  creditLimit: Money
  outstanding: Money
}

export interface PurchaseLineInput {
  lineId: string
  medicineId: number
  batchNo: string
  /** As printed on the pack: "11/27". Normalised to the last day of that month. */
  expiry: string
  /** Packs charged for. */
  qtyPacks: Qty
  /** Scheme goods — dispensed but not charged. Landed cost divides by paid + free. */
  freePacks: Qty
  mrpPerPack: Money
  ratePerPack: Money
  discountPct: Pct
  gstRatePct: Pct
}

export interface PurchaseInvoiceInput {
  idempotencyKey: string
  supplierId: number
  supplierInvoiceNo: string
  invoiceDate: IsoDate
  lines: PurchaseLineInput[]
  /** Apportioned across lines by value, so landed cost carries it. */
  freight?: Money
  notes?: string
}

export interface PurchaseLine extends PurchaseLineInput {
  brandName: string
  packLabel: string
  unitsPerPack: number
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  lineTotal: Money
  /** Over (paid + free) units, freight included. */
  landedCostPerUnit: Money
  /** Set when this rate differs from the last purchase of the same medicine. */
  rateChangedFrom: Money | null
  batchId: number | null
}

export interface PurchaseInvoice {
  id: number
  purchaseNo: string
  storeId: number
  supplierId: number
  supplierName: string
  supplierInvoiceNo: string
  invoiceDate: IsoDate
  createdAt: string
  lines: PurchaseLine[]
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  freight: Money
  roundOff: Money
  netAmount: Money
  amountPaid: Money
  status: 'POSTED' | 'CANCELLED'
  notes: string | null
}

/**
 * Goods leaving the shop back up the supply chain — and there are TWO of these,
 * not one, because GST says so.
 *
 * CBIC Circular 72/46/2018-GST (26 October 2018, still operative) gives exactly
 * two routes for stock going back, and they produce different documents,
 * different tax treatment and different money to chase:
 *
 *  - `PURCHASE_RETURN` — the commercial return. Wrong item, damaged in transit,
 *    short-dated inside the supplier's own return window. Settled by a DEBIT
 *    NOTE adjusted against the purchase bill it came in on, reversing the input
 *    tax credit that bill gave us. The money is a reduction of what we owe.
 *
 *  - `EXPIRY_CLAIM` — time-expired or broken stock issued for a claim. This is
 *    the circular's Route A, and the thing most software gets wrong: it is NOT a
 *    credit note against the old bill. It is a FRESH OUTWARD TAX INVOICE from
 *    this shop, valued at the original supply-invoice value, on which we charge
 *    tax. The manufacturer's settlement then arrives weeks later and usually
 *    NET of a breakage allowance — which is why claim value, credit received and
 *    shortfall are three separate numbers rather than one balance.
 *
 * Marg makes the same split (Purchase Return vs Brk/Exp Issue as separate
 * transactions, with a per-line BE / PR type in its Quick Issue window), which
 * is a good sign the distinction survives contact with a real counter.
 *
 * Modelling both as "a purchase return" is the defect this type exists to
 * prevent: it books an expiry claim as a reduction of the supplier's bill,
 * so the payable is understated by the claim value from the day it is raised
 * until the credit note actually turns up — and the shortfall, which is the
 * whole reason to track claims at all, has nowhere to live.
 */
export const RETURN_KINDS = ['PURCHASE_RETURN', 'EXPIRY_CLAIM'] as const
export type ReturnKind = (typeof RETURN_KINDS)[number]

export interface SupplierReturnLineInput {
  lineId: string
  /** The batch going back. Identity is the batch, never the medicine. */
  batchId: number
  /** Base units, not packs — the shelf holds loose strips too. */
  qty: Qty
}

export interface SupplierReturnInput {
  /** Replaying the same key returns the ORIGINAL document, byte for byte. */
  idempotencyKey: string
  kind: ReturnKind
  supplierId: number
  /**
   * The purchase this is set against.
   *
   * Required for a PURCHASE_RETURN — a debit note that is not adjusted against a
   * bill is a number nobody can reconcile, and Marg makes you pick the bill from
   * a "Pending Invoice" list for exactly this reason. Null is legitimate for an
   * EXPIRY_CLAIM: a strip expiring today was bought two years ago, the bill may
   * pre-date the software, and the claim stands on its own invoice regardless.
   */
  againstPurchaseId: number | null
  issuedOn: IsoDate
  terminalId: number
  /** Mandatory. Unexplained stock leaving the building is what shrinkage is. */
  reason: string
  lines: SupplierReturnLineInput[]
}

export interface SupplierReturnLine {
  lineId: string
  batchId: number
  medicineId: number
  brandName: string
  packLabel: string
  batchNo: string
  expiryDate: IsoDate
  hsnCode: string
  qty: Qty
  /**
   * Per base unit, GST-EXCLUSIVE.
   *
   * Purchase-side money is exclusive of tax, unlike the MRP the counter sells
   * at — getting this backwards is the single easiest mistake on this side of
   * the app, so it is said on the field rather than left to be inferred.
   */
  ratePerUnit: Money
  /** The rate FROZEN on the batch at receipt. Never today's rate. */
  gstRatePct: Pct
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  lineTotal: Money
}

/**
 * A posted debit note or expiry-claim invoice.
 *
 * One shape for both kinds, because the arithmetic is identical and only the
 * document it becomes differs — two shapes would drift and the totals would stop
 * agreeing, which is the failure this whole file is written to avoid.
 */
export interface SupplierReturn {
  id: number
  /** `DN…` for a purchase return, `EC…` for an expiry claim. Own series each. */
  documentNo: string
  kind: ReturnKind
  storeId: number
  terminalId: number
  supplierId: number
  supplierName: string
  againstPurchaseId: number | null
  againstPurchaseNo: string | null
  issuedOn: IsoDate
  createdAt: string
  reason: string
  operatorName: string
  lines: SupplierReturnLine[]
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  roundOff: Money
  /** Taxable + tax + round-off. For a claim this is the CLAIM VALUE. */
  netAmount: Money
  /**
   * Settlement, and only ever on an EXPIRY_CLAIM.
   *
   * A purchase return settles the moment the debit note is adjusted against its
   * bill — there is nothing to chase. A claim does not: the credit arrives weeks
   * later, net of whatever breakage allowance the manufacturer applies, and the
   * difference is real money the shop either recovers or writes off. Null until
   * something is actually received, so "nothing back yet" is distinguishable
   * from "settled in full at zero".
   */
  creditReceived: Money | null
  /** Their credit note, when it lands. The only way to trace the settlement. */
  creditNoteRef: string | null
  status: 'POSTED' | 'CANCELLED'
}

export interface ClaimSettlementInput {
  returnId: number
  creditReceived: Money
  creditNoteRef: string
  note?: string
}

/**
 * What an importer learns and keeps.
 *
 * Two facts, both per supplier, both worthless on their own and jointly the
 * reason the second import of the month takes thirty seconds instead of ten
 * minutes:
 *
 *  - `columns` — which column of THEIR export is which of our fields. A
 *    distributor's layout does not change between bills, so it is asked once.
 *  - `aliases` — their product name against our medicine. The incumbent makes
 *    you resolve these by hand on every single import because it does not keep
 *    them; keeping them is the whole feature.
 */
export interface ImportProfile {
  supplierId: number
  /** Field name → column index in that supplier's export. */
  columns: Record<string, number>
  /** Normalised supplier product name → our medicine id. */
  aliases: Record<string, number>
  updatedAt: string
}

/**
 * One imported line, after matching. Mirrors the importer's own row type, minus
 * the candidate medicines' full records — the screen needs their names, not
 * their whole master row, and shipping the latter across a 900-line bill is
 * megabytes for nothing.
 */
export interface ImportRowDto {
  index: number
  name: string
  barcode: string
  matchKind: 'barcode' | 'alias' | 'exact' | 'mrp' | 'fuzzy' | 'new' | 'ambiguous'
  medicineId: number | null
  candidates: Array<{ id: number; brandName: string; packLabel: string }>
  problems: string[]
  line: {
    batchNo: string
    expiry: string
    qtyPacks: Qty
    freePacks: Qty
    mrpPerPack: Money
    ratePerPack: Money
    discountPct: Pct
    gstRatePct: Pct
  }
}

/**
 * A purchase order: what has been asked for and not yet arrived.
 *
 * The document exists mainly so that "already on order" is a number the reorder
 * engine can subtract. Without it the second order of the week re-orders
 * everything the first one did — the most expensive mistake in this whole area,
 * because it is invisible until the stock arrives twice and the money is gone.
 */
export interface PurchaseOrderLine {
  lineId: string
  medicineId: number
  brandName: string
  packLabel: string
  /** Base units, so it compares directly against stock and against sales. */
  qty: Qty
  /** Received so far against this line. A PO is closed by receipt, not by hand. */
  receivedQty: Qty
  /** Why this quantity, in the engine's own words. Printed and kept. */
  basis: string
}

export interface PurchaseOrderInput {
  idempotencyKey: string
  supplierId: number
  /** Absent means "no date agreed", which is different from today. */
  expectedOn: IsoDate | null
  note?: string
  lines: Array<{ lineId: string; medicineId: number; qty: Qty; basis: string }>
}

export interface PurchaseOrder {
  id: number
  orderNo: string
  storeId: number
  supplierId: number
  supplierName: string
  placedOn: IsoDate
  expectedOn: IsoDate | null
  createdAt: string
  operatorName: string
  note: string | null
  lines: PurchaseOrderLine[]
  /**
   * OPEN until every line is fully received; PART once some has arrived.
   * CANCELLED is explicit and keeps the document — an order that vanishes is
   * one nobody can explain to the distributor who is still going to deliver it.
   */
  status: 'OPEN' | 'PART' | 'RECEIVED' | 'CANCELLED'
}

/**
 * One line of a reorder suggestion, WITH its reasoning.
 *
 * Marg offers twelve reorder "bases" — Marg formula, sales, shortage, last year,
 * today's sale, and so on — and then arbitrates by taking whichever produces the
 * largest quantity. Twelve methods is not twelve features: an operator picks one
 * at random on the day they are shown it and never revisits the choice, and no
 * screen anywhere tells them what the number they are about to order was
 * actually derived from.
 *
 * So there is ONE suggestion here and its working is on the row. Every field
 * below is shown, because a suggested quantity nobody can interrogate is a
 * quantity nobody trusts — and an untrusted suggestion gets overtyped, which
 * makes the whole engine ornamental.
 */
export interface ReorderSuggestion {
  medicineId: number
  brandName: string
  packLabel: string
  /** Sellable stock now. */
  onHand: Qty
  /**
   * On hand MINUS what expires before it could reasonably be sold.
   *
   * Stock that goes out of date inside the cover window is not cover. Counting
   * it is how a shop reorders nothing and then writes the shelf off.
   */
  usableOnHand: Qty
  /** Open purchase-order quantity. Subtracted, or the next order doubles up. */
  onOrder: Qty
  /** Base units a day, over the trailing window. */
  dailySale: Qty
  /** Days the usable stock lasts at that rate. Null when nothing sells. */
  daysOfCover: number | null
  /** Units a customer has actually asked for and not got. Outranks statistics. */
  shortbookQty: Qty
  /** What to order. Never negative, never above the ceiling. */
  suggestedQty: Qty
  /** Rounded up to whole packs, because a distributor ships packs. */
  suggestedPacks: number
  /** The sentence shown on the row and stored on the order line. */
  basis: string
  /** Ranked: a customer waiting outranks a statistical gap. */
  urgency: 'waiting' | 'out' | 'low' | 'watch'
  supplierId: number | null
  supplierName: string | null
}

export interface ReorderSettings {
  /** Days of stock to hold after the order lands. */
  coverDays: number
  /** Days between placing an order and it arriving. Per store, not per SKU. */
  leadTimeDays: number
  /** Trailing window the daily rate is averaged over. */
  historyDays: number
}

/** One batch where the ledger and the shelf disagree, and how. */
export interface StockDiscrepancy {
  batchId: number
  batchNo: string
  brandName: string
  /** `chain` — the history itself is wrong. `drift` — a write skipped the ledger. */
  kind: 'chain' | 'drift'
  ledger: Qty
  shelf: Qty
  difference: Qty
  at: string | null
  refId: string | null
}

export interface StockHealth {
  batchesChecked: number
  movementsChecked: number
  /** Capped for readability; the counters below carry the full truth. */
  discrepancies: StockDiscrepancy[]
  orphanedLedgers: number
  batchesWithoutHistory: number
  balanced: boolean
  /** At landed cost — the money actually at risk where the two disagree. */
  valueAtRisk: Money
  generatedAt: string
  /** The one line a health chip shows. */
  summary: string
}

/**
 * What a scan at goods receipt found.
 *
 * `qty` is deliberately absent even though GS1 AI 30 exists and distributors do
 * use it: it means "units in this carton", which is not the number of packs
 * being billed on the line. A quantity arriving from somewhere the operator did
 * not type, on the field that decides what is paid for, stays manual.
 */
export interface GoodsScanResult {
  kind: 'matched' | 'unknownGtin' | 'plainBarcode' | 'unknown'
  medicine: Medicine | null
  /** Present only when the CARTON carried one. Never invented, never blanked. */
  batchNo: string | null
  /** `MM/YY`, as printed on the pack. */
  expiry: string | null
  /** The GTIN to link, when it is real and simply unknown to this shop. */
  gtin: string | null
  /** One line, naming what it filled. */
  message: string
}

/** One thing worth acting on, and the screen that fixes it. */
export interface AttentionAlert {
  kind: string
  /** `now` is a legal or money problem today; `soon` is this week's work. */
  severity: 'now' | 'soon'
  title: string
  detail: string
  count: number
  amount: Money | null
  href: string
}

export interface StockTransferLineInput {
  lineId: string
  batchId: number
  qty: Qty
}

export interface StockTransferInput {
  idempotencyKey: string
  fromStoreId: number
  toStoreId: number
  issuedOn: IsoDate
  /** Mandatory. Stock leaving a building unexplained is what shrinkage is. */
  reason: string
  lines: StockTransferLineInput[]
}

export interface StockTransferLine {
  lineId: string
  batchId: number
  medicineId: number
  brandName: string
  packLabel: string
  batchNo: string
  expiryDate: IsoDate
  hsnCode: string
  qty: Qty
  /** Landed cost, carried across so margin at the receiving branch is real. */
  costPerUnit: Money
  mrpPerPack: Money
  lineValue: Money
}

/**
 * A posted movement between branches.
 *
 * `document` is decided by GST, not by preference: two branches on ONE GSTIN are
 * one legal person and this is not a supply — it travels on a delivery challan
 * with no tax. Two GSTINs are two persons, even on the same PAN, and that
 * movement is a supply needing a tax invoice.
 */
export interface StockTransferDoc {
  id: number
  documentNo: string
  document: 'CHALLAN' | 'TAX_INVOICE'
  fromStoreId: number
  fromStoreName: string
  toStoreId: number
  toStoreName: string
  issuedOn: IsoDate
  createdAt: string
  reason: string
  operatorName: string
  lines: StockTransferLine[]
  /** At landed cost. On a challan this is a declared value, not a price. */
  totalValue: Money
  /** Why this document and not the other, in words. Printed. */
  basis: string
  status: 'POSTED'
}

export interface ShortbookEntry {
  id: number
  medicineId: number | null
  term: string
  qty: Qty
  at: string
  brandName: string | null
  /** Sellable stock now — a short-book row that has since been restocked is noise. */
  stockQty: Qty | null
}

// ---------------------------------------------------------- price policy ---

/**
 * The chain's selling price, published centrally and applied at every branch.
 *
 * A DISCOUNT off MRP and never a price: MRP is printed on the strip, forms part
 * of the batch's identity, and is what the customer pays. HQ can decide how much
 * of it the chain gives back; it cannot decide what is printed on a strip that
 * left the factory months ago.
 *
 * The precedence, the conflict rules and the diff live in `web/src/api/
 * pricePolicy.ts` as pure functions, so a branch offline and the server online
 * resolve a price the same way.
 */
export type PriceScope = 'MEDICINE' | 'COMPANY' | 'ALL'

export interface PriceRule {
  scope: PriceScope
  /** A medicine id as a string, a company name, or '' for the catch-all rule. */
  target: string
  /** Carried on the rule so a branch can read the list without the master row. */
  label: string
  /** Off MRP, as a percentage. Never negative — that would exceed printed MRP. */
  discountPct: Pct
}

export interface PriceRevision {
  id: string
  /** Monotonic across the chain. A branch compares this, never a clock. */
  serial: number
  publishedAt: string
  publishedBy: string
  effectiveFrom: IsoDate
  note: string
  rules: PriceRule[]
}

export interface PriceRevisionInput {
  effectiveFrom: IsoDate
  note: string
  rules: PriceRule[]
  /** Replaying a push over a flaky link must not publish it twice. */
  idempotencyKey: string
}

// ------------------------------------------------------------- whitelabel ---

/**
 * Branding, as DATA.
 *
 * A white-label deployment changes the name, the mark, the accent and the
 * documents — never the code. Anything a reseller has to fork the app to change
 * is a thing that will drift and stop being maintained.
 */
export interface BrandProfile {
  /** Product name in the shell and on documents. */
  productName: string
  /** Short mark, 1-3 characters, drawn as a rounded square. */
  markText: string
  /** Optional data-URI or asset URL; when set it replaces the drawn mark. */
  logoUrl: string | null
  /** Accent ramp overrides. Absent keys fall back to the built-in teal. */
  accent: {
    base: string
    hover: string
    text: string
    tint: string
    ring: string
  } | null
  /** Shown under the product name in the sidebar. */
  tagline: string | null
  /** Printed in the receipt footer, e.g. "Powered by <x>". */
  documentFooter: string | null
  /** Hides the "powered by" line entirely for a full white-label reseller. */
  hidePoweredBy: boolean
}

// -------------------------------------------------------------- dashboard ---

/** A headline number plus its movement. Rendered as a stat tile, never a chart. */
export interface Kpi {
  value: Money
  /** Signed percentage against the named comparison period. */
  deltaPct: Pct | null
  /** True when a RISE is good. Falling profit and falling overdue read oppositely. */
  riseIsGood: boolean
}

export interface DashboardKpis {
  sales: Kpi
  orders: Kpi
  profit: Kpi
  customers: Kpi
  grossMarginPct: Kpi
  overdue: Kpi
}

/** Counts behind the "attention required" row. Each is a real, actionable queue. */
/**
 * The dashboard's work queues.
 *
 * The first six are stock and counter queues the dashboard has always computed.
 * The last three come from the SAME rules the notification bell applies —
 * `api/attention` — rather than a second implementation, because two attention
 * systems drift and the one nobody is looking at is the one that goes stale.
 * The bell had claims, orders and the day close for several waves while an owner
 * opening the dashboard could not see any of them.
 */
export interface AttentionCounts {
  lowStock: number
  outOfStock: number
  nearExpiry30: number
  expired: number
  heldBills: number
  shortbook: number
  /** Expiry claims the supplier has sent nothing back against. */
  claimsUnsettled: number
  /** Purchase orders past the date they promised. */
  ordersOverdue: number
  /** 1 when money was taken today and the drawer was never counted. */
  dayUnclosed: number
}

export interface CategoryShare {
  key: string
  label: string
  value: Money
  sharePct: Pct
}

/** Status buckets, not categories — these render with the status palette. */
export interface InventoryHealth {
  healthy: number
  lowStock: number
  nearExpiry: number
  expired: number
  totalBatches: number
  /** Stock value sitting on batches that expire inside the near-expiry window. */
  valueAtRisk: Money
}

export interface TrendPoint {
  label: string
  /** Keyed by series name so a grouped bar can render N series without reshaping. */
  values: Record<string, Money>
}

export interface ExpiringBatchRow {
  batchId: number
  medicineId: number
  brandName: string
  batchNo: string
  expiryDate: IsoDate
  daysLeft: number
  qtyOnHand: Qty
  valueAtMrp: Money
  valueAtCost: Money
}

export interface LowStockRow {
  medicineId: number
  brandName: string
  packLabel: string
  qtyOnHand: Qty
  reorderLevel: number
  /** How far below the trigger, as a share of it. Drives the urgency badge. */
  shortfallPct: Pct
  rackLocation: string | null
}

export interface TopMedicineRow {
  medicineId: number
  brandName: string
  packLabel: string
  unitsSold: Qty
  revenue: Money
  qtyOnHand: Qty
}

export interface ActivityRow {
  id: string
  kind: 'SALE' | 'PURCHASE' | 'LOW_STOCK' | 'EXPIRY' | 'SHORTBOOK'
  title: string
  detail: string
  at: string
  amount: Money | null
}

/**
 * The window the dashboard reads.
 *
 * Four presets rather than a date picker. The dashboard answers "how is the shop
 * doing", and the four windows a shopkeeper actually asks that over are today,
 * the last week, the last month and the month being filed. A free range belongs
 * on Reports, which prints the basis it was computed on.
 */
export const DASHBOARD_RANGES = ['today', '7d', '30d', 'month'] as const
export type DashboardRange = (typeof DASHBOARD_RANGES)[number]

/**
 * One medicine's movement between the selected period and the one before it.
 *
 * Both the rupee change and the percentage, because neither alone is a decision:
 * +400% on a line that moved from 50 to 250 rupees is noise, and +8% on the line
 * that carries the shop is the week's news.
 */
export interface MoverRow {
  medicineId: number
  brandName: string
  packLabel: string
  /** Revenue inside the selected period. */
  current: Money
  /** Revenue inside the period immediately before it. */
  previous: Money
  /** Signed: current - previous. */
  deltaAmount: Money
  /** Null when the previous period is zero — a rise from nothing is not a rate. */
  deltaPct: Pct | null
  unitsSold: Qty
}

/**
 * One branch, for the side-by-side comparison.
 *
 * Trading AND shelf. A branch that took no bills today has not stopped existing,
 * and its stock, its reorder queue and its expiry risk are exactly what the owner
 * opening this screen needs to see about it.
 */
export interface BranchSummaryRow {
  storeId: number
  name: string
  city: string
  /** The branch this session is billing for. */
  isCurrent: boolean
  /** Takings inside the selected period, this branch only. */
  sales: Money
  orders: number
  /** Sellable stock on this branch's shelf, at landed cost. */
  stockAtCost: Money
  batches: number
  /** Batches inside the shop's near-expiry window, holding stock. */
  nearExpiry: number
}

export interface DashboardData {
  date: IsoDate
  /** The window every KPI, the takings chart and the movers were read over. */
  range: DashboardRange
  periodStart: IsoDate
  periodEnd: IsoDate
  /** What the deltas compare against, in words: "yesterday", "previous 7 days". */
  comparedTo: string
  kpis: DashboardKpis
  attention: AttentionCounts
  categoryMix: CategoryShare[]
  inventoryHealth: InventoryHealth
  /** Last 12 months, one series per financial year. */
  salesTrend: TrendPoint[]
  salesTrendSeries: string[]
  /** Hourly takings for the current day. */
  todayByHour: TrendPoint[]
  /**
   * The selected period's own shape: by hour when the window is a single day,
   * by day otherwise. One series, keyed `sales`.
   */
  periodTrend: TrendPoint[]
  /** Biggest risers and fallers against the previous period, by revenue. */
  topMovers: { risers: MoverRow[]; fallers: MoverRow[] }
  /** Every branch in the chain. One row when the shop is a single shop. */
  branches: BranchSummaryRow[]
  expiring: ExpiringBatchRow[]
  lowStock: LowStockRow[]
  topMedicines: TopMedicineRow[]
  activity: ActivityRow[]
}

// ------------------------------------------------------ people and access ---

/**
 * The four roles a retail pharmacy actually staffs.
 *
 * A role is a STARTING POINT, never the whole answer. Every real loss at a
 * counter is a number rather than a capability — a discount three points too
 * deep, a refund nobody watched, a bill dated into last month to move it into a
 * filed return — so the role grants the capability and `UserLimits` bounds it
 * per person. A shop with two cashiers gives the six-year one a wider discount
 * than the six-week one, and no boolean can express that.
 */
export const ROLES = ['admin', 'manager', 'pharmacist', 'cashier'] as const
export type Role = (typeof ROLES)[number]

/** The bands the permission grid is grouped by, in reading order. */
export const PERMISSION_AREAS = [
  'Billing', 'Inventory', 'Purchases', 'Customers', 'Reports', 'Settings',
] as const
export type PermissionArea = (typeof PERMISSION_AREAS)[number]

/**
 * Every gated action, as a stable string.
 *
 * The id is the contract — Phase 5 gates each route with `Require<const P>` so
 * an ungated route fails to compile (invariant I23), and these are the values
 * that extractor is parameterised on. Labels may be reworded; these may not.
 */
export const PERMISSIONS = [
  'billing.sell',
  'billing.discount',
  'billing.rate_edit',
  'billing.void',
  'billing.return',
  'billing.backdate',
  'billing.credit',

  'inventory.view',
  'inventory.adjust',
  'inventory.quarantine',
  'inventory.cost_view',

  'purchases.view',
  'purchases.record',
  'purchases.rate_view',
  'purchases.pay',

  'customers.view',
  'customers.edit',
  'customers.credit_limit',
  'customers.erase',

  'reports.sales',
  'reports.margin',
  'reports.gst',
  'reports.audit',

  'settings.store',
  'settings.users',
  'settings.pricing',
  'settings.backup',
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * The four numbers that actually prevent loss.
 *
 * Per user, not per role: they are the ceiling this PERSON may reach without a
 * second signature. Zero is a real, common answer for all three numeric ones —
 * a new cashier gives no discount, refunds nothing and backdates nothing — so
 * none of them may be left blank to mean "unset".
 */
export interface UserLimits {
  /** Deepest discount this person may apply unaided, as a percentage. */
  maxDiscountPct: Pct
  /** Largest refund or credit note they may issue unaided, in rupees. */
  maxRefundAmount: Money
  /** How many days back they may date a document. 0 means today only. */
  backdateDays: number
  /** Whether landed cost, purchase rate and margin are visible to them at all. */
  canViewCost: boolean
}

export interface User {
  id: number
  storeId: number
  name: string
  /** Lowercase, stable, and what the audit trail is keyed on. */
  username: string
  role: Role
  /**
   * State pharmacy council registration.
   *
   * Not decoration: a prescription sale is dispensed under a registered
   * pharmacist and their number goes on the bill, so it belongs on the person
   * and not typed fresh at the counter.
   */
  pharmacistRegNo: string | null
  limits: UserLimits
  isActive: boolean
  /** Last seen on a till. Null for an account that has never been used. */
  lastActiveAt: string | null
}

export interface UserInput {
  name: string
  username: string
  role: Role
  pharmacistRegNo?: string | null
  /** Sent whole. A partial update replaces all four together, never one. */
  limits?: UserLimits
  isActive?: boolean
}

/** Why a second signature was needed. Stable codes; the label is UI. */
export const OVERRIDE_REASONS = [
  'DISCOUNT_LIMIT', 'REFUND_LIMIT', 'RATE_EDIT', 'BILL_VOID', 'BACKDATE',
  'COST_VIEW', 'CREDIT_LIMIT',
] as const
export type OverrideReason = (typeof OVERRIDE_REASONS)[number]

/**
 * A manager standing over the counter, recorded.
 *
 * Both identities are stored, always. An override that records only "approved"
 * answers nothing at the month end, and one that records only the approver
 * cannot show who asked. `approverId` may never equal `requesterId` — that is
 * invariant I22 and Phase 5 enforces it as a CHECK constraint, because an
 * approval a cashier can grant themselves is not a control.
 */
export interface Override {
  requesterId: number
  requesterName: string
  approverId: number
  approverName: string
  reasonCode: OverrideReason
  /** What was asked for: '22' percent, '4800.00', '2026-08-31'. */
  requested: string
  /** The ceiling it exceeded, in the same units. */
  limit: string
  note: string | null
}

/**
 * What the trail records.
 *
 * Deliberately narrower than "everything": a log nobody can read is a log
 * nobody reads. Each of these is an action an owner has asked about out loud.
 */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'SALE_POSTED',
  'SALE_VOIDED',
  'RATE_EDITED',
  'DISCOUNT_APPLIED',
  'REFUND_ISSUED',
  'DOCUMENT_BACKDATED',
  'STOCK_ADJUSTED',
  'BATCH_QUARANTINED',
  'PURCHASE_POSTED',
  'MEDICINE_EDITED',
  'CUSTOMER_EDITED',
  'CREDIT_LIMIT_CHANGED',
  'CASH_COUNTED',
  'EXPORT_RUN',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DEACTIVATED',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** One changed field, as it read before and after. Both sides are display text. */
export interface AuditChange {
  field: string
  before: string | null
  after: string | null
}

export interface AuditEntry {
  id: number
  storeId: number
  at: string
  actorId: number
  /** Snapshotted: renaming a user must not rewrite what the trail says happened. */
  actorName: string
  actorRole: Role
  action: AuditAction
  /** What was acted on — 'Bill', 'Batch', 'Medicine', 'User'. */
  entity: string
  /** Its human reference — an invoice number, a batch number, a username. */
  entityRef: string
  summary: string
  changes: AuditChange[]
  /** Which till, when the action happened at one. */
  terminalId: number | null
  /** The money at stake, when there is any. */
  amount: Money | null
  override: Override | null
}

export interface AuditFilters {
  actorId?: number
  action?: AuditAction
  /** Inclusive calendar bounds, resolved against the local day. */
  from?: IsoDate
  to?: IsoDate
  term?: string
  /** Only entries that needed a second signature. */
  onlyOverrides?: boolean
  limit?: number
  cursor?: number
}

export interface AuditPage {
  rows: AuditEntry[]
  /** Matching the filter, not on the page — the count is the answer. */
  total: number
  nextCursor: number | null
}

/** Users, roles and the trail. Split out to keep `ApiAdapter` readable. */
export interface UsersRolesApi {
  /** Who is signed in. Every override check needs a requester. */
  currentUser(): Promise<User>
  listUsers(): Promise<User[]>
  createUser(input: UserInput): Promise<User>
  updateUser(id: number, input: Partial<UserInput>): Promise<User>
  setUserActive(id: number, isActive: boolean): Promise<User>
  listAudit(filters: AuditFilters): Promise<AuditPage>
}

// --------------------------------------------------------- the sale register ---

/**
 * What happens to units that come back over the counter.
 *
 * RESTOCK returns them to the batch they were dispensed from — never to a new
 * one, because MRP is part of batch identity and the strip in the customer's
 * hand carries the price it was sold at. QUARANTINE puts them back but blocks
 * the batch from allocating. DESTROY records that they came back and were then
 * written off, which is two ledger movements and not zero: "nothing happened"
 * and "it came back and we binned it" have to be distinguishable afterwards.
 */
export const RETURN_DISPOSITIONS = ['RESTOCK', 'QUARANTINE', 'DESTROY'] as const
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number]

/**
 * The register row's status, DERIVED — `SaleInvoice.status` stays POSTED/VOIDED.
 *
 * A returned bill is still a posted bill; the credit note is a second document,
 * not a mutation of the first. Folding "returned" into the invoice's own status
 * would be exactly the edit-in-place that invariant I20 forbids.
 */
export type SaleRowStatus = 'POSTED' | 'PART_RETURNED' | 'RETURNED' | 'VOIDED'

export interface SalesFilters {
  /** Inclusive, on the shop's local calendar. */
  from: IsoDate
  to: IsoDate
  /** Invoice number, customer name or customer phone. */
  term?: string
  mode?: PaymentMode
  status?: 'all' | 'posted' | 'returned' | 'voided'
  sort?: 'time' | 'amount' | 'invoiceNo'
  limit?: number
  cursor?: number
}

export interface PaymentModeTotal {
  mode: PaymentMode
  /** Tender taken in this mode. CASH is NET of change handed back. */
  amount: Money
  bills: number
}

/**
 * One hour of the shop's own trading day.
 *
 * The hour is read off the SHOP'S local clock, not UTC: "when is the counter
 * busy" is a staffing question, and an 11 a.m. rush filed under 05:30 answers
 * nobody. All twenty-four are always present so the profile keeps a stable
 * x-axis between a quiet Tuesday and a festival Saturday.
 */
export interface HourlyTotal {
  /** 0-23. */
  hour: number
  bills: number
  amount: Money
}

/**
 * What one operator rang up in the range.
 *
 * Posted bills only, attributed by the name SNAPSHOTTED on the invoice rather
 * than by a user id — the bill carries who raised it, and a staff member who
 * leaves must not take their history off last month's figures with them.
 */
export interface OperatorTotal {
  operatorName: string
  bills: number
  amount: Money
  averageBill: Money
  itemsSold: Qty
}

export interface SalesSummary {
  from: IsoDate
  to: IsoDate
  bills: number
  /** Posted bills only. A voided bill is not a sale. */
  netSales: Money
  averageBill: Money
  /** Credited back by credit notes ISSUED in the range, at their own value. */
  returns: Money
  returnCount: number
  voidedBills: number
  voidedAmount: Money
  byMode: PaymentModeTotal[]
  itemsSold: Qty
  /** All 24 hours, in clock order. Posted bills, by the shop's local clock. */
  byHour: HourlyTotal[]
  /** Biggest takings first. Only operators who raised a posted bill appear. */
  byOperator: OperatorTotal[]
}

/** One line of the register: everything the grid draws, and nothing more. */
export interface SaleRegisterRow {
  id: number
  invoiceNo: string
  invoiceDate: IsoDate
  createdAt: string
  customerName: string | null
  customerPhone: string | null
  lineCount: number
  itemQty: Qty
  netAmount: Money
  /** Distinct tenders, in PAYMENT_MODES order. Split bills carry several. */
  modes: PaymentMode[]
  status: SaleRowStatus
  /** Value already credited back against this bill; '0.00' when none. */
  returnedAmount: Money
  terminalId: number
  operatorName: string
}

export interface SalesPage {
  rows: SaleRegisterRow[]
  total: number
  nextCursor: number | null
  /** Over the whole DATE RANGE — not the page, and not the text search. The
   *  tiles are the day's numbers; hunting for one bill must not zero them. */
  summary: SalesSummary
}

export interface SaleReturnLineInput {
  /** The ORIGINAL invoice line this reverses. */
  lineId: string
  /** Which batch the units came off. One line can fan across several. */
  batchId: number
  qty: Qty
  disposition: ReturnDisposition
}

export interface SaleReturnInput {
  /** Replaying the same key returns the ORIGINAL credit note, byte for byte. */
  idempotencyKey: string
  invoiceId: number
  terminalId: number
  /** Mandatory. An unexplained credit note is indistinguishable from a till lift. */
  reason: string
  /** How the money goes back. CASH leaves the drawer and moves the day close. */
  refundMode: PaymentMode
  lines: SaleReturnLineInput[]
}

export interface CreditNoteLine {
  lineId: string
  medicineId: number
  brandName: string
  packLabel: string
  hsnCode: string
  batchId: number
  batchNo: string
  expiryDate: IsoDate
  qty: Qty
  /** The rate the units were SOLD at, carried over from the original line. */
  ratePerUnit: Money
  /** The rate in force on the ORIGINAL invoice date. Never resolved afresh. */
  gstRatePct: Pct
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  lineTotal: Money
  disposition: ReturnDisposition
}

/**
 * A credit note — the only instrument that reverses part of a posted sale.
 *
 * It carries the ORIGINAL invoice's date as well as its own issue date because
 * the tax it reverses is the tax that was charged, and a slab can move between
 * the two (invariant I21). GSTR-1 reports it under `cdnr`/`cdnur` against the
 * original document, which is why `invoiceNo` is snapshotted rather than joined.
 */
export interface CreditNote {
  id: number
  creditNoteNo: string
  storeId: number
  terminalId: number
  invoiceId: number
  invoiceNo: string
  /** The date the tax on this reversal was originally charged on. */
  originalInvoiceDate: IsoDate
  issuedOn: IsoDate
  createdAt: string
  customerId: number | null
  customerName: string | null
  interState: boolean
  lines: CreditNoteLine[]
  taxableValue: Money
  cgst: Money
  sgst: Money
  igst: Money
  /** Non-zero ONLY on a full reversal, where it mirrors the invoice's own
   *  round-off so the refund equals what was actually collected. */
  roundOff: Money
  netAmount: Money
  refundMode: PaymentMode
  reason: string
  operatorName: string
}

export interface DayCloseInput {
  date: IsoDate
  terminalId: number
  /** The float the drawer started with. Known at open, so not a tell. */
  openingFloat: Money
  /** Counted BEFORE the expected figure exists on the client. That order IS
   *  the control: a variance that can be seen first can be typed away. */
  countedCash: Money
  note?: string
}

export interface DayClose {
  date: IsoDate
  terminalId: number
  closedAt: string
  openingFloat: Money
  countedCash: Money
  /** Opening float + cash taken − change given − cash refunded. */
  expectedCash: Money
  /** Counted − expected. Negative is short. */
  variance: Money
  bills: number
  netSales: Money
  returns: Money
  byMode: PaymentModeTotal[]
  note: string | null
  operatorName: string
}

/** The invoice register, returns and day close. */
export interface SalesRegisterApi {
  listSales(filters: SalesFilters): Promise<SalesPage>
  /** Credit notes against one bill, or across a date range for the summary. */
  listCreditNotes(q: { invoiceId?: number; from?: IsoDate; to?: IsoDate }): Promise<CreditNote[]>
  /** Moves stock, writes the ledger, allocates the CN number last. */
  postSaleReturn(input: SaleReturnInput): Promise<CreditNote>
  /** Cancels a bill IN PLACE and returns its stock. Never deletes it. */
  voidSale(id: number, reason: string): Promise<SaleInvoice>
  /**
   * Takes the count and only THEN returns the expected figure and the variance.
   * There is deliberately no method that hands the expected cash over first.
   */
  closeDay(input: DayCloseInput): Promise<DayClose>
  /** An already-closed day, so a reopened screen shows the recorded variance. */
  getDayClose(date: IsoDate, terminalId: number): Promise<DayClose | null>
}

// -------------------------------------------------------------- transport ---

export interface ApiErrorBody {
  /** Stable, switchable. Message text may change; this may not. */
  code: string
  message: string
  details?: unknown
}

export class ApiError extends Error {
  readonly code: string
  readonly details: unknown
  constructor(body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.code = body.code
    this.details = body.details
  }
}

/**
 * Every backend implements this. `localAdapter` (Dexie) does today; the Rust
 * server does from Phase 5. Nothing in the UI may import a concrete adapter.
 */
/** Inventory and purchases. Split out only to keep ApiAdapter readable. */
export interface InventoryPurchasesApi {
  listBatches(filters: InventoryFilters): Promise<{ rows: BatchRow[]; total: number; nextCursor: number | null }>
  inventorySummary(): Promise<InventorySummary>
  listMovements(q: { batchId?: number; medicineId?: number; limit: number }): Promise<StockMovement[]>
  adjustStock(input: StockAdjustmentInput): Promise<BatchRow>
  setBatchQuarantined(batchId: number, quarantined: boolean, note: string): Promise<BatchRow>

  listSuppliers(term?: string): Promise<Supplier[]>
  createSupplier(input: SupplierInput): Promise<Supplier>
  updateSupplier(id: number, input: Partial<SupplierInput>): Promise<Supplier>

  /** Pure and read-only: prices the goods receipt without creating any batch. */
  quotePurchase(input: PurchaseInvoiceInput): Promise<PurchaseInvoice>
  /** Creates batches, writes the ledger, allocates the document number last. */
  postPurchase(input: PurchaseInvoiceInput): Promise<PurchaseInvoice>
  listPurchases(q: { limit: number; cursor?: number }): Promise<{ rows: PurchaseInvoice[]; nextCursor: number | null }>

  /** Pure and read-only: prices the return without moving a single unit. */
  quoteSupplierReturn(input: SupplierReturnInput): Promise<SupplierReturn>
  /** Removes stock, writes the ledger, allocates the document number last. */
  postSupplierReturn(input: SupplierReturnInput): Promise<SupplierReturn>
  listSupplierReturns(q: { kind?: ReturnKind; supplierId?: number }): Promise<SupplierReturn[]>
  /** Records what the manufacturer actually credited against a claim. */
  settleClaim(input: ClaimSettlementInput): Promise<SupplierReturn>

  /** The saved column mapping and learned aliases for one supplier. */
  getImportProfile(supplierId: number): Promise<ImportProfile>
  /**
   * Match a parsed sheet against the WHOLE catalogue.
   *
   * On the adapter rather than in the screen because matching needs every
   * medicine and every barcode, and a page of two hundred is not a catalogue —
   * a wizard holding one silently reports every product past the letter C as
   * unknown. The adapter already keeps both in memory for the counter's search.
   */
  matchImportRows(input: {
    supplierId: number
    headers: string[]
    rows: string[][]
    columns: Record<string, number>
  }): Promise<ImportRowDto[]>
  /** Merged, never replaced: an import teaches, it does not forget. */
  saveImportProfile(input: {
    supplierId: number
    columns: Record<string, number>
    aliases: Record<string, number>
  }): Promise<ImportProfile>

  /** What to order, with the working. Pure read — creates nothing. */
  suggestReorder(q?: Partial<ReorderSettings>): Promise<ReorderSuggestion[]>
  createPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder>
  listPurchaseOrders(q: { status?: PurchaseOrder['status'] }): Promise<PurchaseOrder[]>
  cancelPurchaseOrder(id: number, reason: string): Promise<PurchaseOrder>

  /** Everything wrong with a filing period, found before it is filed. */
  checkFiling(q: { from: IsoDate; to: IsoDate }): Promise<FilingCheck>
  /**
   * Invariant I17: does the append-only ledger still agree with the shelf?
   *
   * Surfaced to a human rather than logged, because a reconciliation nobody
   * sees is a reconciliation nobody acts on.
   */
  checkStockHealth(): Promise<StockHealth>
  /**
   * What needs somebody's attention right now.
   *
   * Six facts that already exist on six different screens, gathered into one
   * list. Usually short by design — a bell that is permanently lit is one
   * nobody reads.
   */
  attention(): Promise<AttentionAlert[]>

  listShortbook(): Promise<ShortbookEntry[]>
  clearShortbook(id: number): Promise<void>

}

export interface ApiAdapter extends InventoryPurchasesApi, UsersRolesApi, SalesRegisterApi, ReportsApi {
  getStore(): Promise<StoreProfile>
  /** Every branch in the chain. */
  listStores(): Promise<StoreProfile[]>
  /** Pure and read-only: prices the movement without moving a single unit. */
  quoteTransfer(input: StockTransferInput): Promise<StockTransferDoc>
  /**
   * Move stock between branches.
   *
   * Both sides in ONE transaction. A decrement that commits without its matching
   * increment is stock that has left one shop and arrived nowhere, and nothing
   * in the app would ever notice.
   */
  postTransfer(input: StockTransferInput): Promise<StockTransferDoc>
  listTransfers(): Promise<StockTransferDoc[]>
  /**
   * Move this session to another branch.
   *
   * Throws away every warm cache and rebuilds: the search index holds ONE
   * branch's stock, and a switch that left it loaded would let the counter
   * allocate the shop next door's shelf.
   */
  switchStore(storeId: number): Promise<StoreProfile>
  /**
   * Edit the store profile.
   *
   * Validated, not merely written: the invoice prefix and the financial-year
   * start decide document numbers, and changing either part-way through a year
   * puts two series inside one year or re-issues a number already given out.
   */
  updateStore(patch: StoreProfilePatch): Promise<StoreProfile>
  /**
   * Open a branch.
   *
   * Takes a WHOLE profile rather than a patch: a branch inherits chain policy
   * (the filing thresholds, the expiry guard, the round-off rule) and owns its
   * own identity (name, address, drug licence, invoice prefix), and which is
   * which is a decision the caller has already made. The adapter's job is to
   * refuse an id or an invoice prefix that already belongs to another branch —
   * both of which silently merge two shops' documents.
   */
  createStore(profile: StoreProfile): Promise<StoreProfile>
  /**
   * Edit a branch that is not the one this session is billing for.
   *
   * Separate from `updateStore` because the numbering guards are counted
   * against the branch being edited, not against the active one: a quiet new
   * branch may change its prefix long after the head office cannot.
   */
  updateBranch(storeId: number, patch: StoreProfilePatch): Promise<StoreProfile>

  searchMedicines(q: {
    term: string
    limit?: number
    /** Include known medicines with no sellable stock, below a divider. */
    includeOutOfStock?: boolean
  }): Promise<MedicineSearchHit[]>

  lookupBarcode(barcode: string): Promise<MedicineSearchHit | null>
  getBatches(medicineId: number): Promise<Batch[]>
  /** Bulk hydrate by id. Recalling a held bill needs names the held rows do not carry. */
  getMedicines(ids: readonly number[]): Promise<Medicine[]>

  listMedicines(filters: MedicineFilters): Promise<MedicinePage>
  createMedicine(input: MedicineInput): Promise<Medicine>
  updateMedicine(id: number, input: Partial<MedicineInput>): Promise<Medicine>
  setMedicineActive(id: number, isActive: boolean): Promise<Medicine>
  /**
   * Read a scanned carton at goods receipt.
   *
   * On the adapter because it needs the WHOLE barcode master, which the counter
   * already keeps warm — and because a screen holding a page of it would report
   * every code past the first few hundred as unknown.
   */
  resolveGoodsScan(payload: string): Promise<GoodsScanResult>
  linkBarcode(medicineId: number, barcode: string, symbology: string): Promise<void>
  unlinkBarcode(barcode: string): Promise<void>

  /**
   * The chain's price list.
   *
   * Read is unconditional — a branch must know what it is selling at even when
   * nobody there may change it. Publishing is gated on `settings.pricing`, and a
   * published revision is immutable: correcting a price means publishing again.
   */
  listPriceRevisions(): Promise<PriceRevision[]>
  publishPriceRevision(input: PriceRevisionInput): Promise<PriceRevision>

  getBrand(): Promise<BrandProfile>
  saveBrand(brand: BrandProfile): Promise<BrandProfile>

  /** Pure and read-only: moves no stock and consumes no invoice number. */
  quoteSale(req: QuoteRequest): Promise<Quote>

  postSale(req: PostSaleRequest): Promise<SaleInvoice>
  getInvoice(id: number): Promise<SaleInvoice>

  searchCustomers(term: string): Promise<Customer[]>
  /** Most recently billed first — the counter sees the same faces every week. */
  recentCustomers(limit: number): Promise<Customer[]>
  createCustomer(input: CustomerInput): Promise<Customer>
  /** Past bills for the attached customer, newest first. */
  customerHistory(customerId: number, limit: number): Promise<SaleInvoice[]>

  /**
   * The WHOLE customer book, unfiltered.
   *
   * No term and no cursor, deliberately. An independent pharmacy's master runs
   * to low thousands of rows of a couple of hundred bytes — it fits — and
   * holding all of it is what lets the receivables screen filter EXACTLY: "who
   * is over their limit" answered over a page is "who is over their limit, on
   * this page", which is a different and useless question. A chain that outgrows
   * this needs a server-side ageing endpoint, not a cursor bolted on here.
   */
  listCustomers(): Promise<Customer[]>

  /**
   * Bills that carry a customer, newest first — POSTED and VOIDED alike.
   *
   * Voided ones are deliberately included, not overlooked. A customer's own
   * history is where a cancelled bill has to stay visible, for the same reason
   * the sales register keeps it: a document that vanishes is what concealment
   * looks like, and the operator who cancelled it needs to see that they did.
   * The ageing is unaffected — `receivableOf` skips anything not POSTED — so a
   * void costs a row of the window and nothing else.
   *
   * Walk-in bills are excluded at the source: they have no account to sit on,
   * they are the large majority of a counter's traffic, and shipping them here
   * would spend most of the window on rows the receivable cannot use. Paged the
   * same way `listPurchases` is, because an adapter is free to serve fewer rows
   * than asked for and the caller has to be able to keep asking.
   */
  listCustomerBills(q: { limit: number; cursor?: number }): Promise<{ rows: SaleInvoice[]; nextCursor: number | null }>

  /** Every receipt on file, newest first. Small: one row per payment taken. */
  listCustomerReceipts(): Promise<CustomerReceipt[]>

  /**
   * Take money against an account. Refuses zero, negative, and anything above
   * the balance — an over-payment is an advance, which is a different document.
   */
  recordCustomerReceipt(input: CustomerReceiptInput): Promise<CustomerReceipt>

  searchDoctors(term: string): Promise<Doctor[]>
  recentDoctors(limit: number): Promise<Doctor[]>
  createDoctor(input: DoctorInput): Promise<Doctor>

  /**
   * In-stock alternatives sharing this medicine's composition.
   *
   * Substitution is the single most common counter conversation — the prescribed
   * brand is out, or the customer wants the cheaper one — and it is a SALT match,
   * never a brand-name match.
   */
  findSubstitutes(medicineId: number): Promise<MedicineSearchHit[]>

  holdBill(b: Omit<HeldBill, 'savedAt'>): Promise<HeldBill>
  listHeldBills(): Promise<HeldBill[]>
  recallBill(token: number): Promise<HeldBill>
  dropHeldBill(token: number): Promise<void>

  addToShortbook(medicineId: number | null, term: string, qty: Qty): Promise<void>

  /** Everything the dashboard needs, in ONE round trip. Six queries would make
   *  the screen paint six times and each would need its own error state.
   *  `range` widens the window the KPIs, the takings chart and the movers read
   *  over; it defaults to the single day, which is what the counter wants. */
  getDashboard(date: IsoDate, range?: DashboardRange): Promise<DashboardData>
}

// ---------------------------------------------------------------- reports ---

/**
 * The report set, deliberately small.
 *
 * Marg ships ~120 report entries and its own knowledge base is full of "why does
 * X not match Y" articles, because two reports over the same data at different
 * grains with different implied bases will always disagree eventually. So this is
 * a closed list of the reports a pharmacist or their accountant actually opens,
 * each answering ONE question, each printing the basis it was computed on.
 */
export const REPORT_IDS = [
  'DAY_BOOK',
  'SALES_BY_DAY',
  'ITEM_SALES',
  'BATCH_MARGIN',
  'GST_RATE_SUMMARY',
  'HSN_SUMMARY',
  'PURCHASE_REGISTER',
  'H1_REGISTER',
  'CONTROLLED_BALANCE',
  'CUSTOMER_OUTSTANDING',
  'SUPPLIER_OUTSTANDING',
  'STOCK_VALUATION',
  'NEAR_EXPIRY',
  'NON_MOVING',
] as const
export type ReportId = (typeof REPORT_IDS)[number]

export interface ReportQuery {
  reportId: ReportId
  /** Inclusive, on the document date. Stock reports value what is on the shelf
   *  NOW and say so; there is one valuation engine and it does not rewind. */
  from: IsoDate
  to: IsoDate
  /** Free text, matched against the row's own text and code cells. */
  term?: string
  /** The one report-specific axis: payment mode, GST rate, expiry window. */
  facet?: string
  /**
   * Collapse the report on one of its OWN columns — Marg calls this "Index On".
   *
   * Late-bound on purpose: it re-aggregates rows the report already produced
   * rather than running a different query, so a grouped report and its flat
   * form are the same numbers seen at two grains and the footer is identical
   * either way. That identity is the whole value. Marg's own knowledge base
   * carries an article explaining why its closing stock disagrees with its
   * stock-and-sale analysis; two reports over one dataset at different grains
   * is exactly how that happens, and grouping in place is how it cannot.
   *
   * A column key, and only ever one of `ReportResult.groupable` — except that a
   * choice the current filter has made unavailable is still honoured rather
   * than silently dropped.
   */
  groupBy?: string
}

/** How a cell aligns, formats and exports. Money is still a decimal STRING. */
export type ReportCellKind =
  | 'text' | 'code' | 'date' | 'expiry' | 'money' | 'qty' | 'pct' | 'count' | 'status'

export interface ReportColumn {
  key: string
  label: string
  kind: ReportCellKind
  /** What the number is, and what it is NOT. Rendered as the header's title. */
  hint?: string
  /** Footed over the whole filtered set, never over the loaded page. */
  total?: boolean
}

export interface ReportRow {
  key: string
  /** Keyed by column. A missing key renders as an em dash, never as zero. */
  cells: Record<string, string | null>
  tone?: 'danger' | 'warning' | 'muted'
}

/** The answer, before the table. Every report opens with one. */
export interface ReportHeadline {
  label: string
  value: string
  kind: ReportCellKind
  hint?: string
}

/**
 * Two aggregation paths over the same data, and the exact difference between
 * them.
 *
 * `difference` is to the paisa. A non-zero value is a fault in the data, never a
 * rounding artefact: `domain/gst` takes every tax split as a residual precisely
 * so these can never drift by construction.
 */
export interface ReportCheck {
  label: string
  leftLabel: string
  left: Money
  rightLabel: string
  right: Money
  difference: Money
  balanced: boolean
  /** Why the two have to agree, in one sentence. */
  explain: string
}

export interface ReportResult {
  reportId: ReportId
  /**
   * The BRANDED product name, carried on the result rather than hard-coded.
   *
   * A report's basis lines and caveats name the software that produced them —
   * "… has no stock-as-on-date engine, and reading a date it does not honour
   * would be worse than saying so" — and those lines are printed on screen and
   * written into the CSV a reseller's customer hands to their accountant. With
   * the vendor's own name baked in, every one of them is a white-label leak on
   * a document the reseller believes is theirs. So the name travels with the
   * report and the sentences are built around it.
   */
  productName: string
  title: string
  /** The question this report answers. Shown above the table and exported. */
  question: string
  from: IsoDate
  to: IsoDate
  /** As-on date, cost basis, what is in and what is out. Printed AND exported —
   *  a stock value whose basis is not on the page is a number nobody can defend. */
  basis: string[]
  /** Caveats. Anything not verified against a primary source says so here. */
  notes: string[]
  generatedAt: string
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Keyed by column, over the whole filtered set — not the rendered page. */
  totals: Record<string, Money | null>
  headline: ReportHeadline[]
  facetLabel: string | null
  facets: Array<{ value: string; label: string; count: number }>
  checks: ReportCheck[]
  /**
   * Columns this report can be collapsed on, in column order.
   *
   * Offered only where grouping would actually merge rows — a dimension with
   * one value per row produces a header above every row and reads as damage.
   */
  groupable: Array<{ key: string; label: string }>
  /** The column currently grouped on, echoed back. Null when flat. */
  groupBy: string | null
  /** Null when flat. Ordered; `rows` stays the full flat set underneath. */
  groups: ReportGroup[] | null
}

/**
 * One collapsed band of a grouped report.
 *
 * `totals` is keyed and computed exactly like `ReportResult.totals` — the same
 * "only columns declared `total`" rule — so a percentage is never averaged into
 * a subtotal and a subtotal never means something the footer does not.
 */
export interface ReportGroup {
  /** The cell value rows were partitioned by. '' when the cell was empty. */
  key: string
  /** What to print. Empty keys get a spelled-out stand-in, never a blank band. */
  label: string
  count: number
  rowKeys: string[]
  totals: Record<string, Money | null>
}

/**
 * Reporting.
 *
 * Deliberately ONE method. Every report is a set of columns and rows over the
 * same documents, so a per-report endpoint would multiply the surface without
 * adding an answer — and the filtering, the footer totals and the CSV would then
 * have ten implementations that drift apart.
 */
export interface ReportsApi {
  runReport(query: ReportQuery): Promise<ReportResult>
}
