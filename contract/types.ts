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
}

export interface HeldBill {
  token: number
  label: string
  savedAt: string
  itemCount: number
  netAmount: Money
  lines: QuoteLineInput[]
  customerId?: number
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
export interface AttentionCounts {
  lowStock: number
  outOfStock: number
  nearExpiry30: number
  expired: number
  heldBills: number
  shortbook: number
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

export interface DashboardData {
  date: IsoDate
  kpis: DashboardKpis
  attention: AttentionCounts
  categoryMix: CategoryShare[]
  inventoryHealth: InventoryHealth
  /** Last 12 months, one series per financial year. */
  salesTrend: TrendPoint[]
  salesTrendSeries: string[]
  /** Hourly takings for the current day. */
  todayByHour: TrendPoint[]
  expiring: ExpiringBatchRow[]
  lowStock: LowStockRow[]
  topMedicines: TopMedicineRow[]
  activity: ActivityRow[]
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
export interface ApiAdapter {
  getStore(): Promise<StoreProfile>

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

  /** Pure and read-only: moves no stock and consumes no invoice number. */
  quoteSale(req: QuoteRequest): Promise<Quote>

  postSale(req: PostSaleRequest): Promise<SaleInvoice>
  getInvoice(id: number): Promise<SaleInvoice>

  searchCustomers(term: string): Promise<Customer[]>

  holdBill(b: Omit<HeldBill, 'savedAt'>): Promise<HeldBill>
  listHeldBills(): Promise<HeldBill[]>
  recallBill(token: number): Promise<HeldBill>
  dropHeldBill(token: number): Promise<void>

  addToShortbook(medicineId: number | null, term: string, qty: Qty): Promise<void>

  /** Everything the dashboard needs, in ONE round trip. Six queries would make
   *  the screen paint six times and each would need its own error state. */
  getDashboard(date: IsoDate): Promise<DashboardData>
}
