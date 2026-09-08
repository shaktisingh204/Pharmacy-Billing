/** Domain model for a retail pharmacy (India / GST regime). */

export type DrugSchedule = 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'NRx'
export type DosageForm =
  | 'Tablet' | 'Capsule' | 'Syrup' | 'Injection' | 'Ointment' | 'Drops'
  | 'Inhaler' | 'Powder' | 'Sachet' | 'Device' | 'Surgical' | 'Other'

/** GST slabs applicable to pharma goods in India. */
export type GstRate = 0 | 5 | 12 | 18 | 28

export interface Product {
  id?: number
  name: string
  /** Salt / active composition — what pharmacists actually substitute on. */
  composition: string
  manufacturer: string
  form: DosageForm
  schedule: DrugSchedule
  /** Units in one sale pack, e.g. 10 tablets in a strip. */
  packSize: number
  /** What a single sellable unit is called at the counter. */
  saleUnit: string
  hsn: string
  gstRate: GstRate
  /** Re-order trigger, in loose units. */
  reorderLevel: number
  rackLocation?: string
  storage?: string
  barcode?: string
  /** Prescription must be recorded before the item can be billed. */
  rxRequired: boolean
  narcotic?: boolean
  discontinued?: boolean
  createdAt: number
}

export interface Batch {
  id?: number
  productId: number
  batchNo: string
  /** Last day of the printed expiry month, stored as YYYY-MM-DD. */
  expiry: string
  /** Maximum retail price of ONE loose unit, GST inclusive. */
  mrp: number
  /** Price-to-retailer of one loose unit, GST exclusive. */
  ptr: number
  /** Loose units on hand. */
  qty: number
  supplierId?: number
  purchaseId?: number
  receivedAt: number
}

export interface Customer {
  id?: number
  name: string
  phone: string
  address?: string
  gstin?: string
  doctorName?: string
  /** Outstanding credit the shop is carrying for this customer. */
  balance: number
  creditLimit: number
  notes?: string
  createdAt: number
}

export interface Supplier {
  id?: number
  name: string
  phone: string
  address?: string
  gstin?: string
  /** Drug licence number — required on every purchase bill. */
  dlNo?: string
  balance: number
  createdAt: number
}

export interface InvoiceItem {
  productId: number
  batchId: number
  name: string
  composition: string
  hsn: string
  batchNo: string
  expiry: string
  packSize: number
  /** Billed loose units. */
  qty: number
  /** Free/scheme units — dispensed but not charged. */
  freeQty: number
  mrp: number
  /** Per-unit selling price, GST inclusive (MRP less any negotiated cut). */
  rate: number
  discPct: number
  gstRate: GstRate
  /** Derived, stored so a reprint never drifts from the original bill. */
  taxable: number
  cgst: number
  sgst: number
  igst: number
  total: number
  /** Cost basis at time of sale, for margin reporting. */
  costBasis: number
}

export type PaymentMode = 'Cash' | 'Card' | 'UPI' | 'Credit' | 'Split'

export interface Payment {
  mode: Exclude<PaymentMode, 'Split'>
  amount: number
  reference?: string
}

export interface Prescription {
  doctorName: string
  doctorRegNo?: string
  patientName?: string
  date: string
  notes?: string
}

export type InvoiceStatus = 'paid' | 'partial' | 'credit' | 'returned' | 'held'

export interface Invoice {
  id?: number
  invoiceNo: string
  date: number
  customerId?: number
  customerName: string
  customerPhone?: string
  customerGstin?: string
  /** Inter-state supply → IGST instead of CGST+SGST. */
  interState: boolean
  items: InvoiceItem[]
  prescription?: Prescription
  grossAmount: number
  itemDiscount: number
  billDiscountPct: number
  billDiscount: number
  taxableValue: number
  cgst: number
  sgst: number
  igst: number
  roundOff: number
  netAmount: number
  paid: number
  payments: Payment[]
  paymentMode: PaymentMode
  status: InvoiceStatus
  /** Total cost of goods on this bill, for the margin report. */
  cogs: number
  userId?: string
  notes?: string
}

export interface PurchaseItem {
  productId: number
  name: string
  batchNo: string
  expiry: string
  qty: number
  freeQty: number
  mrp: number
  ptr: number
  discPct: number
  gstRate: GstRate
  taxable: number
  tax: number
  total: number
}

export interface Purchase {
  id?: number
  purchaseNo: string
  supplierInvoiceNo: string
  supplierId: number
  supplierName: string
  date: number
  items: PurchaseItem[]
  taxableValue: number
  tax: number
  roundOff: number
  netAmount: number
  paid: number
  status: 'paid' | 'partial' | 'unpaid'
}

export type ReturnKind = 'sales' | 'purchase'

export interface StockReturn {
  id?: number
  kind: ReturnKind
  refNo: string
  /** Invoice / purchase number being returned against. */
  againstNo: string
  date: number
  partyName: string
  items: Array<{
    productId: number
    batchId?: number
    name: string
    batchNo: string
    expiry: string
    qty: number
    rate: number
    gstRate: GstRate
    total: number
  }>
  reason: string
  netAmount: number
}

export type LedgerReason =
  | 'purchase' | 'sale' | 'sales-return' | 'purchase-return'
  | 'adjustment' | 'expiry-writeoff' | 'opening'

export interface StockMovement {
  id?: number
  productId: number
  batchId: number
  date: number
  /** Positive = stock in, negative = stock out. */
  delta: number
  balance: number
  reason: LedgerReason
  refNo?: string
  note?: string
}

export interface Settings {
  id?: number
  shopName: string
  tagline?: string
  address: string
  city: string
  state: string
  stateCode: string
  phone: string
  email?: string
  gstin: string
  dlNo: string
  /** Prefix + running counter produce the invoice number. */
  invoicePrefix: string
  invoiceCounter: number
  purchasePrefix: string
  purchaseCounter: number
  footerNote: string
  roundOffEnabled: boolean
  /** Days before expiry at which a batch is flagged near-expiry. */
  expiryAlertDays: number
  lowStockAlerts: boolean
  currency: string
  theme: 'light' | 'dark'
}
