import type {
  ApiAdapter, Batch, BatchRow, BrandProfile, CreditNote, Customer, CustomerInput, CustomerReceipt,
  CustomerReceiptInput, DashboardData, DayClose, DayCloseInput, Doctor,
  DoctorInput, HeldBill, InventoryFilters, InventoryPurchasesApi, InventorySummary, IsoDate,
  Medicine, MedicineFilters, MedicineInput, MedicinePage, MedicineSearchHit, Money,
  PostSaleRequest, PriceRevision, PriceRevisionInput,
  PurchaseInvoice, PurchaseInvoiceInput, PurchaseLine, Qty, Quote, QuoteRequest,
  ClaimSettlementInput, FilingCheck, ImportProfile, ImportRowDto, PurchaseOrder, PurchaseOrderInput,
  AttentionAlert, DashboardRange, GoodsScanResult, StockHealth, StockTransferDoc, StockTransferInput,
  StoreProfilePatch,
  ReorderSettings, ReorderSuggestion, ReturnKind, SaleInvoice, SaleReturnInput, SalesFilters, SalesPage,
  ShortbookEntry, StockAdjustmentInput, StockMovement, StoreProfile, Supplier, SupplierReturn,
  SupplierReturnInput,
  SupplierInput, AuditChange, AuditEntry, AuditFilters, AuditPage, User, UserInput,
} from '@contract'
import { ApiError, ROLES } from '@contract'
import * as D from '@/domain/decimal'
import { fefoOrder, isSellable } from '@/domain/fefo'
import { computeQuote } from '@/domain/quote'
import type { QuoteContext } from '@/domain/quote'
import { BRAND_META_KEY, db } from '@/db/schema'
import type { StockLedgerRow } from '@/db/schema'
import {
  DEFAULT_BRAND, DEMO_CURRENT_USER_ID, DEMO_DOCTORS, DEMO_USERS, buildDemoAudit, demoSuppliers,
} from '@/db/bootstrap'
import {
  applyMedicineUpdate, buildMedicinePage, coerceBrand, gtinForms, parseBrand,
  prepareBarcodeLink, prepareMedicine,
} from './medicines'
import {
  applyAdjustment, batchIdentityKey, buildBatchPage, buildBatchRow, buildInventorySummary,
  buildShortbookEntries, prepareAdjustment, toStockMovements,
} from './inventory'
import type { InventoryCatalogue } from './inventory'
import {
  applySupplierUpdate, blendLandedCost, isInterStateSupply, matchesSupplier, precheckPurchase,
  prepareSupplier, pricePurchase,
} from './purchases'
import {
  priceSupplierReturn, returnMovements, settleClaim as settleClaimDoc,
} from './supplierReturns'
import type { PricedSupplierReturn } from './supplierReturns'
import type { PurchasePricingContext } from './purchases'
import { coerceReceipts, creditTaken, prepareReceipt } from './customers'
import {
  buildSalesPage, checkVoidable, computeDayClose, priceSaleReturn, requireReturnReason,
  voidMovements,
} from './sales'
import { buildRows } from './importer'
import type { ColumnMap } from './importer'
import {
  DEFAULT_SETTINGS, onOrderQuantities, suggestReorder as suggestReorderLines,
} from './reorder'
import { checkFiling as checkFilingPeriod } from './filing'
import { applyStorePatch } from './storeSettings'
import { describeScan, readGoodsScan } from './goodsScan'
import { attentionItems } from './attention'
import { findDestinationBatch, newDestinationBatch, priceTransfer } from './transfers'
import type { PricedTransfer } from './transfers'
import { healthSummary, reconcileStock } from './health'
import { SearchIndex } from './searchIndex'
import { branchComparison, computeDashboard } from './dashboard'
import { buildReport, normaliseRange, reportInputs } from './reports'
import type { ReportQuery, ReportResult } from '@contract'
import { ROLE_LABEL, applyUserUpdate, can, diffUsers, filterAudit, prepareUser } from './users'
import { checkEffectiveFrom, checkRules } from './pricePolicy'

/**
 * Where customer receipts live in the Phase-1 mock.
 *
 * One JSON document in `meta`, the way the brand profile is, rather than a
 * table: Dexie versions INDEXES, and a receipts store would put every existing
 * local database — including the ones holding a day of unsynced bills — through
 * a migration for a document that is only ever read whole and only ever queried
 * by customer id in memory. The shape stored is exactly `CustomerReceipt`, which
 * is the row the Phase-5 server writes into a real `receipts` table with a real
 * `doc_series` behind the number, so the cutover is a storage change and not a
 * redesign.
 */
const RECEIPTS_META_KEY = 'customerReceipts'

/**
 * The Phase-1 backend: the contract, implemented over IndexedDB.
 *
 * It deliberately enforces the same guarantees the Rust server will, because a
 * mock that is more permissive than the real thing teaches the UI habits that
 * break at cutover. Specifically it re-quotes server-side rather than trusting the
 * client's totals, refuses to oversell, allocates the invoice number LAST, writes
 * an append-only ledger, and caches responses by idempotency key.
 */

export interface LocalAdapterOptions {
  /** Injected so tests and screenshots are deterministic. */
  now: () => Date
}

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** India runs April-March. FY 2026-27 is written "2627" in a document number. */
function financialYear(d: Date, startMonth: number): string {
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`
}

/** Who is at the till. Becomes the signed-in user once auth lands; until then
 *  it is one constant rather than four copies of the same string literal. */
const OPERATOR_NAME = 'Counter 1'

const SALE_RETURNS_META_KEY = 'saleReturns'
/** Debit notes and expiry claims. One store, both kinds — the `kind` field
 *  separates them and the document series keep their numbers apart. */
const SUPPLIER_RETURNS_META_KEY = 'supplierReturns'
/** One document per supplier: `importProfile:<supplierId>`. */
const IMPORT_PROFILE_PREFIX = 'importProfile'
/** Which branch this browser profile is billing for. */
const ACTIVE_STORE_KEY = 'rxbill.activeStore'
/** Branch-to-branch movements. Both sides of every one of them. */
const TRANSFERS_META_KEY = 'stockTransfers'
const PRICE_POLICY_META_KEY = 'pricePolicy'
/** Open purchase orders. Their whole job is to make "already on order" a real
 *  number the reorder engine can subtract. */
const PURCHASE_ORDERS_META_KEY = 'purchaseOrders'

/** One document per closed day per terminal, so closing a day rewrites nothing
 *  else and a shop with four tills does not serialise on one blob. */
const dayCloseKey = (date: string, terminalId: number): string => `dayClose:${date}:${terminalId}`

/**
 * The credit-note register, as it sits in `meta`.
 *
 * The idempotency map lives HERE rather than in `db.idempotency`, which stores
 * sale invoice ids: one shared table would mean a column holding either a sale
 * id or a credit-note id depending on who wrote it, and the first replay that
 * read the wrong one would hand back an invoice as a credit note. Exactly the
 * reason `purchaseIdempotency` is its own table.
 */
interface SaleReturnRegister {
  notes: CreditNote[]
  keys: Record<string, number>
}

const EMPTY_REGISTER: SaleReturnRegister = { notes: [], keys: {} }

/** Corrupt or absent JSON reads as an empty register rather than throwing: the
 *  sale register must still open, and a lost demo return is not worth a screen
 *  that refuses to render. */
function parseSaleReturns(raw: string | undefined): SaleReturnRegister {
  if (!raw) return EMPTY_REGISTER
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_REGISTER
    const { notes, keys } = parsed as Partial<SaleReturnRegister>
    return {
      notes: Array.isArray(notes) ? notes : [],
      keys: typeof keys === 'object' && keys !== null ? keys : {},
    }
  } catch {
    return EMPTY_REGISTER
  }
}

/* --------------------------------------------------- people, as pure rules ---
 *
 * The customer and prescriber rules live outside the class because they are
 * value logic, not storage: the Rust server has to reject exactly the same
 * inputs and merge exactly the same near-duplicates, and rules that can only be
 * exercised through IndexedDB get tested once and then trusted forever.
 */

/** '+91 98220 41100', '098220 41100' and '9822041100' are one phone number. */
export function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

/**
 * Validate a new customer against the book.
 *
 * The phone IS the identity at an Indian counter — it is how the next visit, the
 * credit balance and the allergy strip are found again — so a half-typed number
 * must never land in the master. A duplicate is not a failure to shrug at
 * either: the existing row rides on the error so the UI can offer to ATTACH
 * that customer instead of writing a second Ramesh Kulkarni nobody will merge.
 */
export function prepareCustomer(
  input: CustomerInput,
  existing: readonly Customer[],
): Omit<Customer, 'id' | 'storeId'> {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) {
    throw new ApiError({ code: 'CUSTOMER_INVALID', message: 'Customer name is required', details: { field: 'name' } })
  }

  const phone = phoneDigits(input.phone ?? '')
  if (!/^\d{10}$/.test(phone)) {
    throw new ApiError({
      code: 'CUSTOMER_INVALID',
      message: 'Enter the 10-digit mobile number',
      details: { field: 'phone' },
    })
  }

  const clash = existing.find((c) => phoneDigits(c.phone) === phone)
  if (clash) {
    throw new ApiError({
      code: 'CUSTOMER_EXISTS',
      message: `${clash.name} is already registered on ${phone}`,
      details: clash,
    })
  }

  const creditLimit = (input.creditLimit ?? '0').trim() || '0'
  if (!/^\d+(\.\d{1,2})?$/.test(creditLimit)) {
    throw new ApiError({
      code: 'CUSTOMER_INVALID',
      message: 'Credit limit must be an amount like 5000.00',
      details: { field: 'creditLimit' },
    })
  }

  const address = input.address?.trim()
  const gstin = input.gstin?.trim().toUpperCase()
  return {
    name,
    phone,
    address: address ? address : null,
    gstin: gstin ? gstin : null,
    allergies: (input.allergies ?? []).map((a) => a.trim()).filter((a) => a.length > 0),
    creditLimit: D.toStr(D.dec(creditLimit), 2),
    // A new customer owes nothing. An opening balance is a document, never a
    // number typed into a create form.
    outstanding: '0.00',
  }
}

/**
 * Order for the quick-pick list: most recently BILLED first.
 *
 * Recently *created* is only the tie-break, for someone registered a minute ago
 * who has no bill yet — they are the likeliest next attach, but they must not
 * outrank the regular who was here on Tuesday.
 */
export function orderRecentCustomers(
  customers: readonly Customer[],
  lastBilledAt: ReadonlyMap<number, string>,
  limit: number,
): Customer[] {
  if (limit <= 0) return []
  return customers
    .slice()
    .sort((a, b) => {
      const at = lastBilledAt.get(a.id)
      const bt = lastBilledAt.get(b.id)
      if (at && bt) return at < bt ? 1 : at > bt ? -1 : b.id - a.id
      if (at) return -1
      if (bt) return 1
      return b.id - a.id
    })
    .slice(0, limit)
}

/**
 * A prescriber's identity, for de-duplication.
 *
 * Case, spacing and the honorific are the three things that differ between two
 * counter typings of the same physician, and none of them makes a different
 * doctor. A register carrying "DR. A K JOSHI", "Dr A.K. Joshi" and "a k joshi"
 * as three prescribers cannot answer the one question the H1 register exists to
 * answer, which is who wrote what.
 */
export function doctorIdentity(name: string, registrationNo?: string | null): string {
  const n = name.trim().toLowerCase().replace(/^dr\.?\s+/, '').replace(/\s+/g, ' ')
  return `${n}|${(registrationNo ?? '').toLowerCase().replace(/\s+/g, '')}`
}

export function prepareDoctor(input: DoctorInput): Omit<Doctor, 'id' | 'storeId'> {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) {
    throw new ApiError({ code: 'DOCTOR_INVALID', message: "Prescriber's name is required", details: { field: 'name' } })
  }
  const registrationNo = input.registrationNo?.trim()
  const qualification = input.qualification?.trim()
  const clinicName = input.clinicName?.trim()
  const phone = input.phone?.trim()
  return {
    name,
    registrationNo: registrationNo ? registrationNo : null,
    qualification: qualification ? qualification : null,
    clinicName: clinicName ? clinicName : null,
    phone: phone ? phone : null,
    prescriptionCount: 0,
  }
}

export function findExistingDoctor(
  rows: readonly Doctor[],
  candidate: { name: string; registrationNo: string | null },
): Doctor | undefined {
  const key = doctorIdentity(candidate.name, candidate.registrationNo)
  return rows.find((d) => doctorIdentity(d.name, d.registrationNo) === key)
}

export function matchesDoctor(d: Doctor, q: string): boolean {
  return (
    d.name.toLowerCase().includes(q) ||
    (d.registrationNo ?? '').toLowerCase().includes(q) ||
    (d.clinicName ?? '').toLowerCase().includes(q)
  )
}

/** Lowercased, whitespace-collapsed salt. "Amlodipine  5mg" and "amlodipine 5mg"
 *  are one composition; two brands printing it differently are still substitutes. */
export function normaliseComposition(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface SubstituteSource {
  medicines: ReadonlyMap<number, Medicine>
  batchesFor: (medicineId: number) => readonly Batch[]
  today: IsoDate
}

/** Eight fills the panel and still fits the screen; past that the counter is
 *  reading a catalogue rather than answering a question. */
const SUBSTITUTE_LIMIT = 8

/**
 * Same salt, different brand.
 *
 * Substitution is a COMPOSITION match and never a brand-name one: Amlogard and
 * Amlopres share nothing textually and are the same medicine, while Zinetac and
 * Zincovit share four letters and are not. Ordered by what the customer actually
 * pays per unit, because "is there a cheaper one" is why the question was asked;
 * out-of-stock alternatives are dropped, since the prescribed brand being
 * unavailable is usually what started the conversation.
 */
export function substitutesFor(medicineId: number, src: SubstituteSource): MedicineSearchHit[] {
  const med = src.medicines.get(medicineId)
  if (!med) return []
  const salt = normaliseComposition(med.compositionText)
  if (!salt) return []

  const hits: MedicineSearchHit[] = []
  for (const other of src.medicines.values()) {
    if (other.id === medicineId || !other.isActive) continue
    if (normaliseComposition(other.compositionText) !== salt) continue
    const hit = compositionHit(other, src)
    if (!hit.outOfStock) hits.push(hit)
  }

  return hits
    .sort((a, b) => D.cmp(unitPrice(a), unitPrice(b)) || a.medicine.brandName.localeCompare(b.medicine.brandName))
    .slice(0, SUBSTITUTE_LIMIT)
}

/** What one base unit costs the customer: the printed MRP of the batch FEFO
 *  would hand over, not the pack price of a pack they are not buying. */
const unitPrice = (h: MedicineSearchHit): D.Decimal => D.dec(h.fefoBatch?.mrpPerUnit ?? '0')

function compositionHit(medicine: Medicine, src: SubstituteSource): MedicineSearchHit {
  const batches = src.batchesFor(medicine.id)
  const sellable = batches.filter((b) => isSellable(b, src.today))
  return {
    medicine,
    stockQty: D.toStr(D.sum(sellable.map((b) => D.dec(b.qtyOnHand))), 0),
    fefoBatch: fefoOrder(batches, src.today)[0] ?? null,
    batchCount: sellable.length,
    matchedOn: 'composition',
    outOfStock: sellable.length === 0,
  }
}

/**
 * Where the roster and the trail live in the Phase-1 mock.
 *
 * Two JSON documents in `meta`, for the same reason customer receipts are one:
 * Dexie versions INDEXES, and a `users` store would put every existing local
 * database through a migration for a document that is read whole, rewritten
 * whole, and never queried by anything but an id already in memory. A shop has
 * six accounts, not six thousand.
 *
 * The AUDIT document is the one that will not survive contact with production —
 * a real trail is append-only, indexed by actor and by day, and REVOKE'd against
 * UPDATE and DELETE (invariant I16 does exactly this for the stock ledger). What
 * is stored here is the row the Phase-5 server writes into that table, so the
 * cutover is a storage change; the guarantee is not being claimed yet.
 */
const USERS_META_KEY = 'users'
const AUDIT_META_KEY = 'audit'

/** A meta document, or null when it is absent, empty or unreadable. */
function readJsonRows<T>(raw: string | undefined): T[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as T[]) : null
  } catch {
    return null
  }
}

/**
 * What a new account was born with.
 *
 * Written as a before/after diff with nothing on the left, so a creation and a
 * later edit read the same way down the trail. "Created a user" on its own
 * answers none of the questions this log exists for.
 */
function creationChanges(user: User): AuditChange[] {
  return [
    { field: 'Role', before: null, after: ROLE_LABEL[user.role] },
    { field: 'Max discount %', before: null, after: user.limits.maxDiscountPct },
    { field: 'Max refund ₹', before: null, after: user.limits.maxRefundAmount },
    { field: 'Backdate days', before: null, after: String(user.limits.backdateDays) },
    { field: 'Sees cost', before: null, after: user.limits.canViewCost ? 'Yes' : 'No' },
  ]
}

export class LocalAdapter implements ApiAdapter, InventoryPurchasesApi {
  private index = new SearchIndex()
  private store: StoreProfile | null = null
  private ready: Promise<void> | null = null

  /**
   * The catalogue, delisted rows included.
   *
   * `SearchIndex` deliberately holds only ACTIVE medicines — a brand the shop
   * has stopped selling must not surface at the counter — so it cannot answer
   * for the master screen, which exists partly to find those rows again. Both
   * maps are the warm copy the writes below patch, so a master edit costs no
   * IndexedDB read at all.
   */
  private catalogue = new Map<number, Medicine>()
  private barcodeOwners = new Map<string, number>()

  // A parameter property would be neater, but `erasableSyntaxOnly` forbids it.
  private readonly opts: LocalAdapterOptions

  constructor(opts: LocalAdapterOptions) {
    this.opts = opts
  }

  /**
   * Which branch this session is working in.
   *
   * Persisted per browser profile, because a counter machine belongs to ONE
   * branch and re-picking it every morning is a step that will eventually be
   * got wrong — which is precisely the "billing into the wrong location" the
   * store chip exists to prevent.
   */
  private activeStoreId(): number {
    const raw = Number(localStorage.getItem(ACTIVE_STORE_KEY) ?? '1')
    return Number.isFinite(raw) && raw > 0 ? raw : 1
  }

  /** Warms the in-memory index. Every public method awaits it. */
  async init(): Promise<void> {
    this.ready ??= (async () => {
      const wanted = this.activeStoreId()
      const [store, fallback, medicines, batches, barcodes] = await Promise.all([
        db.stores.get(wanted),
        db.stores.get(1),
        db.medicines.toArray(),
        db.batches.toArray(),
        db.barcodes.toArray(),
      ])
      /* A remembered branch that no longer exists falls back to the first rather
         than failing to boot: a store deleted at HQ must not leave a till unable
         to open in the morning. */
      const active = store ?? fallback
      if (!active) throw new ApiError({ code: 'NOT_SEEDED', message: 'Store not seeded' })
      this.store = active
      /* The CATALOGUE is chain-shared and the STOCK is not.
         An item master belongs to the chain — HQ maintains it and every branch
         sells the same products — while a batch sits on one shelf in one shop.
         Loading every branch's batches into the index is how a counter allocates
         stock that is forty kilometres away, so the index is filtered here, once,
         and every `allBatches()` consumer is scoped by construction rather than
         by remembering to filter. */
      this.catalogue = new Map(medicines.map((m) => [m.id, m]))
      this.barcodeOwners = new Map(barcodes.map((b) => [b.barcode, b.medicineId]))
      this.index.load(medicines, batches.filter((b) => b.storeId === active.id), this.barcodeOwners)
      await Promise.all([this.ensureDoctorMaster(), this.ensureSupplierMaster()])
    })()
    return this.ready
  }

  /**
   * This branch's rows, and only this branch's.
   *
   * `storeId` has been on every transactional row since the first migration —
   * the plan's whole point being that retrofitting store scoping is the classic
   * rewrite trigger — but until there were two stores nothing read it, so the
   * filter was untested by construction.
   *
   * Applied at every document read rather than trusted to the caller: the
   * failure mode is silent. A register showing the other branch's bills looks
   * exactly like a busy day, and a stock figure that includes another shop's
   * shelf looks exactly like stock.
   */
  private mine<T extends { storeId: number }>(rows: readonly T[]): T[] {
    const id = this.requireStore().id
    return rows.filter((r) => r.storeId === id)
  }

  async listStores(): Promise<StoreProfile[]> {
    await this.init()
    return (await db.stores.toArray()).sort((a, b) => a.id - b.id)
  }

  /**
   * Move this session to another branch.
   *
   * Everything warm is thrown away and rebuilt: the search index holds one
   * branch's stock, and a switch that left it loaded would let the counter
   * allocate the shop next door's shelf. Callers reload their own queries —
   * which is why this returns the new store rather than mutating quietly.
   */
  async switchStore(storeId: number): Promise<StoreProfile> {
    const next = await db.stores.get(storeId)
    if (!next) throw new ApiError({ code: 'NOT_FOUND', message: `Store ${storeId} not found` })
    localStorage.setItem(ACTIVE_STORE_KEY, String(storeId))
    this.ready = null
    this.store = null
    await this.init()
    return next
  }

  /**
   * The demo prescriber master, filled in here rather than in `ensureSeeded`.
   *
   * A schema version adds the doctors TABLE, not its contents, and `ensureSeeded`
   * is a no-op on a database that already carries the current seed version — so a
   * browser that has been running this app since before the prescriber master
   * existed would otherwise upgrade to an empty quick-pick list and stay there.
   * Guarded on count, so a seeded master is never duplicated.
   */
  private async ensureDoctorMaster(): Promise<void> {
    if ((await db.doctors.count()) > 0) return
    await db.doctors.bulkAdd(DEMO_DOCTORS as unknown as Parameters<typeof db.doctors.bulkAdd>[0])
  }

  /** The distributor master, filled in for the same reason the prescriber one is:
   *  schema version 3 adds the TABLE, not its contents, and a browser that has
   *  been running this app since before purchasing existed would otherwise
   *  upgrade to a goods-receipt screen with nobody to receive from. */
  private async ensureSupplierMaster(): Promise<void> {
    if ((await db.suppliers.count()) === 0) {
      const master = demoSuppliers(this.opts.now())
      await db.suppliers.bulkAdd(master as unknown as Parameters<typeof db.suppliers.bulkAdd>[0])
    }

    /* The bills behind those balances.
       Guarded on its OWN table rather than on the suppliers one, so a profile
       that already has the distributor master picks the receipts up too. Without
       them the demo showed a payable no document explained, the Purchases
       register opened empty, and a debit note — which has to name the bill it
       reduces — could not be raised at all. */
    if ((await db.purchases.count()) > 0) return

    /* `requireStore()`, never `getStore()`.
       This runs INSIDE `init()`, and `getStore` opens with `await this.init()` —
       which returns the very promise still waiting on this function. The app
       booted to a blank page with no console error, because a deadlock is not an
       exception. `this.store` is already assigned by the time this is called. */
    const store = this.requireStore()
    const [suppliers, medicines, batches] = await Promise.all([
      db.suppliers.toArray(),
      db.medicines.toArray(),
      db.batches.toArray(),
    ])
    if (medicines.length === 0 || batches.length === 0) return

    const seedFy = financialYear(this.opts.now(), store.financialYearStartMonth)
    const { generatePurchases } = await import('../../../seed/purchases')
    const { invoices, outstandingBySupplier } = generatePurchases({
      medicines,
      batches,
      suppliers,
      storeId: store.id,
      storeStateCode: store.stateCode,
      today: this.opts.now(),
      financialYear: seedFy,
    })
    if (invoices.length === 0) return

    await db.purchases.bulkAdd(invoices as unknown as Parameters<typeof db.purchases.bulkAdd>[0])

    /* The master is rewritten to what the bills actually leave unpaid. The
       authored figure was a plausible number with nothing behind it; leaving it
       would make the supplier report disagree with its own documents on the
       first screen a reader opens. */
    for (const supplier of suppliers) {
      const covered = outstandingBySupplier.get(supplier.id)
      if (covered !== undefined && covered !== supplier.outstanding) {
        await db.suppliers.put({ ...supplier, outstanding: covered })
      }
    }

    /* The series has to clear the seeded numbers, exactly as the sales history
       advances the invoice counter — otherwise the first real goods receipt asks
       for PB2627-00001 and collides with one of these. */
    const key = `${store.id}:${seedFy}:0:PURCHASE`
    const existing = await db.docSeries.get(key)
    const next = invoices.length + 1
    if (!existing || existing.nextNumber < next) {
      await db.docSeries.put({
        key,
        storeId: store.id,
        financialYear: seedFy,
        terminalId: 0,
        docType: 'PURCHASE',
        prefix: 'GRN',
        nextNumber: next,
      })
    }
  }

  /**
   * Called after a write that changes stock.
   *
   * Patches only what moved. The previous version dropped the whole index and
   * re-read every medicine, batch and barcode from IndexedDB — on the single code
   * path where the cashier is waiting for the bill to save, and at a cost that
   * grew with the catalogue instead of with the sale.
   */
  private refresh(changed: readonly Batch[]): void {
    const known = this.index.allBatches()
    // `updateBatches` patches lists that already exist, so it cannot introduce
    // the FIRST batch for a medicine — and a goods receipt does exactly that
    // every time it stocks something the shop has never held. That case rebuilds
    // (from memory, not from IndexedDB); every other write stays incremental.
    if (changed.every((b) => known.has(b.medicineId))) {
      this.index.updateBatches(changed)
      return
    }
    const byId = new Map<number, Batch>()
    for (const b of [...known.values()].flat()) byId.set(b.id, b)
    for (const b of changed) byId.set(b.id, b)
    this.index.load([...this.catalogue.values()], [...byId.values()], this.barcodeOwners)
  }

  /**
   * Called after a write that changes the CATALOGUE rather than stock.
   *
   * Renormalising the search rows costs nothing that matters here and reads
   * nothing from storage — the medicines, the barcodes and the batches are all
   * already in memory, and the batch map is handed straight back. The expensive
   * thing `updateBatches` was introduced to kill was the IndexedDB scan, not the
   * lowercasing, and it was on the path where the cashier waits for a bill to
   * save. This path is a human editing a master record.
   *
   * `SearchIndex` exposes no per-medicine patch to use instead, and it is owned
   * elsewhere; if one appears, this becomes a one-line call to it.
   */
  private refreshCatalogue(): void {
    this.index.load(
      [...this.catalogue.values()],
      [...this.index.allBatches().values()].flat(),
      this.barcodeOwners,
    )
  }

  private requireMedicine(id: number): Medicine {
    const m = this.catalogue.get(id)
    if (!m) throw new ApiError({ code: 'NOT_FOUND', message: `Medicine ${id} not found` })
    return m
  }

  private today(): string {
    return isoDate(this.opts.now())
  }

  private requireStore(): StoreProfile {
    if (!this.store) throw new ApiError({ code: 'NOT_INITIALISED', message: 'Adapter not initialised' })
    return this.store
  }

  async getStore(): Promise<StoreProfile> {
    await this.init()
    return this.requireStore()
  }

  async updateStore(patch: StoreProfilePatch): Promise<StoreProfile> {
    await this.init()
    const current = this.requireStore()
    /* Counted inside the CURRENT financial year, which is what the numbering
       guards are about — a document from two years ago is no reason to refuse a
       prefix change today. */
    const fy = financialYear(this.opts.now(), current.financialYearStartMonth)
    const issuedThisYear = this.mine(await db.invoices.toArray())
      .filter((i) => i.invoiceNo.includes(fy)).length

    const next = applyStorePatch(current, patch, { issuedThisYear })
    await db.stores.put(next)
    this.store = next
    return next
  }

  /**
   * Open a branch.
   *
   * The two refusals are the ones that merge two shops into one set of numbers:
   * a reused id — every transactional row in the schema carries `storeId`, so a
   * duplicate inherits the other branch's stock, bills and day close — and a
   * duplicate invoice prefix, which issues the same document number in two
   * shops. `newBranchProfile` has already checked both against the list the
   * screen held; this re-checks against the table, because the screen's list is
   * a snapshot and another till may have opened a branch since.
   */
  async createStore(profile: StoreProfile): Promise<StoreProfile> {
    await this.init()
    const existing = await db.stores.toArray()
    if (existing.some((s) => s.id === profile.id)) {
      throw new ApiError({
        code: 'STORE_EXISTS',
        message: `Branch ${profile.id} already exists`,
        details: { field: 'name' },
      })
    }
    const clash = existing.find(
      (s) => s.invoicePrefix.trim().toUpperCase() === profile.invoicePrefix.trim().toUpperCase(),
    )
    if (clash) {
      throw new ApiError({
        code: 'PREFIX_TAKEN',
        message: `${clash.name} already issues the ${profile.invoicePrefix} series. Two branches on one prefix issue the same invoice number twice.`,
        details: { field: 'invoicePrefix' },
      })
    }
    await db.stores.put(profile)
    return profile
  }

  /** Edit a branch other than the active one. See the contract for why. */
  async updateBranch(storeId: number, patch: StoreProfilePatch): Promise<StoreProfile> {
    await this.init()
    if (storeId === this.requireStore().id) return this.updateStore(patch)

    const current = await db.stores.get(storeId)
    if (!current) {
      throw new ApiError({ code: 'NOT_FOUND', message: `Branch ${storeId} not found` })
    }
    /* Counted against THAT branch, not this one: a quiet new branch may still
       change its prefix long after the head office cannot. */
    const fy = financialYear(this.opts.now(), current.financialYearStartMonth)
    const issuedThisYear = (await db.invoices.toArray())
      .filter((i) => i.storeId === storeId && i.invoiceNo.includes(fy)).length

    const next = applyStorePatch(current, patch, { issuedThisYear })
    await db.stores.put(next)
    return next
  }

  async searchMedicines(q: { term: string; limit?: number; includeOutOfStock?: boolean }): Promise<MedicineSearchHit[]> {
    await this.init()
    return this.index.search(q.term, this.today(), q.limit ?? 8, q.includeOutOfStock ?? true)
  }

  async lookupBarcode(barcode: string): Promise<MedicineSearchHit | null> {
    await this.init()
    const today = this.today()
    // A GS1 symbol carries AI 01 as a 14-digit GTIN, zero-padded: an EAN-13 pack
    // code arrives as '0' + the 13 digits. The barcode table stores what is
    // printed on the pack, so both forms have to be tried or every DataMatrix
    // scan misses a barcode that is right there in the catalogue.
    for (const candidate of gtinForms(barcode)) {
      const hit = this.index.byBarcode(candidate, today)
      if (hit) return hit
    }
    return null
  }

  async getBatches(medicineId: number): Promise<Batch[]> {
    await this.init()
    return this.index.batchesFor(medicineId)
  }

  async getMedicines(ids: readonly number[]): Promise<Medicine[]> {
    await this.init()
    // The full catalogue, not the search index: a held bill or a reprinted
    // invoice can name a medicine that has since been delisted, and it still has
    // to render with its name rather than as a bare id.
    return ids.flatMap((id) => {
      const m = this.catalogue.get(id)
      return m ? [m] : []
    })
  }

  /* --------------------------------------------------- the medicine master ---
   *
   * Every rule these six methods enforce lives in `./medicines` as a function
   * over arrays. What is left here is the part that genuinely needs storage:
   * feeding those functions from the warm index, writing the row, and patching
   * the in-memory copies so the counter sees the edit on the next keystroke.
   */

  async listMedicines(filters: MedicineFilters): Promise<MedicinePage> {
    await this.init()
    const store = this.requireStore()

    // Inverted once per call rather than scanned per row: a page of fifty rows
    // against a few thousand barcodes is otherwise a needless quadratic.
    const barcodesByMedicine = new Map<number, string[]>()
    for (const [code, id] of this.barcodeOwners) {
      const list = barcodesByMedicine.get(id)
      if (list) list.push(code)
      else barcodesByMedicine.set(id, [code])
    }

    const batches = this.index.allBatches()
    return buildMedicinePage(
      {
        medicines: [...this.catalogue.values()],
        batchesFor: (id) => batches.get(id) ?? [],
        barcodesFor: (id) => barcodesByMedicine.get(id) ?? [],
        today: this.today(),
        nearExpiryBuckets: store.nearExpiryBuckets,
      },
      filters,
    )
  }

  async createMedicine(input: MedicineInput): Promise<Medicine> {
    await this.init()
    const store = this.requireStore()
    const row = prepareMedicine(input, [...this.catalogue.values()])
    // No `id` on the record: `++id` is an INBOUND auto-increment key, so a value
    // that already carries one is stored under it instead of under a generated
    // key — the same trap createCustomer documents.
    const record = { ...row, storeId: store.id } as Medicine
    const id = await db.medicines.add(record)
    const saved: Medicine = { ...record, id }
    this.catalogue.set(id, saved)
    this.refreshCatalogue()
    return saved
  }

  async updateMedicine(id: number, input: Partial<MedicineInput>): Promise<Medicine> {
    await this.init()
    const next = applyMedicineUpdate(this.requireMedicine(id), input, [...this.catalogue.values()])
    await db.medicines.put(next)
    this.catalogue.set(id, next)
    this.refreshCatalogue()
    return next
  }

  /**
   * Delist, never delete.
   *
   * The batches on the shelf, the ledger rows behind them and every bill ever
   * printed still point at this row. Removing it would leave stock nobody can
   * account for and invoices that cannot say what they dispensed — so the flag
   * only takes the medicine out of the POS search. It stays in the master, in
   * the valuation, and in history.
   */
  async setMedicineActive(id: number, isActive: boolean): Promise<Medicine> {
    await this.init()
    const current = this.requireMedicine(id)
    if (current.isActive === isActive) return current
    const next: Medicine = { ...current, isActive }
    await db.medicines.put(next)
    this.catalogue.set(id, next)
    this.refreshCatalogue()
    return next
  }

  async resolveGoodsScan(payload: string): Promise<GoodsScanResult> {
    await this.init()
    const outcome = readGoodsScan(payload, {
      // The WHOLE barcode master and the WHOLE catalogue, both already warm for
      // the counter's own search.
      barcodes: this.barcodeOwners,
      medicineOf: (id) => this.catalogue.get(id),
    })
    return {
      kind: outcome.kind,
      medicine: outcome.kind === 'matched' || outcome.kind === 'plainBarcode'
        ? outcome.medicine
        : null,
      batchNo: 'batchNo' in outcome ? outcome.batchNo ?? null : null,
      expiry: 'expiry' in outcome ? outcome.expiry ?? null : null,
      gtin: outcome.kind === 'unknownGtin' ? outcome.gtin : null,
      message: describeScan(outcome),
    }
  }

  async linkBarcode(medicineId: number, barcode: string, symbology: string): Promise<void> {
    await this.init()
    this.requireMedicine(medicineId)
    const link = prepareBarcodeLink(barcode, medicineId, this.barcodeOwners, this.catalogue)
    // Re-scanning a code the medicine already carries is what an operator does
    // to check it took. It is not a duplicate to refuse.
    if (link.alreadyLinked) return
    await db.barcodes.add({ medicineId, barcode: link.barcode, symbology: symbology.trim() || 'internal' })
    this.barcodeOwners.set(link.barcode, medicineId)
    this.refreshCatalogue()
  }

  async unlinkBarcode(barcode: string): Promise<void> {
    await this.init()
    // Every GTIN form, because that is how the code may have been stored: a pack
    // linked from a DataMatrix scan is on file zero-padded to 14 digits, and
    // unlinking the EAN-13 printed beside it has to reach the same row.
    const linked = gtinForms(barcode).filter((form) => this.barcodeOwners.has(form))
    if (linked.length === 0) return
    await db.barcodes.where('barcode').anyOf(linked).delete()
    for (const form of linked) this.barcodeOwners.delete(form)
    this.refreshCatalogue()
  }

  // ---------------------------------------------------------- price policy ---

  private async priceRevisionRows(): Promise<PriceRevision[]> {
    const row = await db.meta.get(PRICE_POLICY_META_KEY)
    if (!row) return []
    try {
      const parsed: unknown = JSON.parse(row.value)
      if (!Array.isArray(parsed)) return []
      /* Rows are filtered individually. A chain with forty revisions must not
         lose the list it is billing on because one arrived malformed. */
      return (parsed as PriceRevision[]).filter(
        (r) => r && typeof r.id === 'string' && Array.isArray(r.rules),
      )
    } catch {
      return []
    }
  }

  async listPriceRevisions(): Promise<PriceRevision[]> {
    await this.init()
    const rows = await this.priceRevisionRows()
    return [...rows].sort((a, b) => b.serial - a.serial)
  }

  /**
   * Publish a price list.
   *
   * Immutable once out, so everything that could be wrong is refused HERE:
   * a duplicate target, a negative discount, a start date in the past. The
   * serial is allocated last, from the rows inside the transaction, for the same
   * reason an invoice number is — a rejected publication must not burn one.
   */
  async publishPriceRevision(input: PriceRevisionInput): Promise<PriceRevision> {
    await this.init()
    const me = await this.currentUser()
    if (!can(me, 'settings.pricing')) {
      throw new ApiError({
        code: 'FORBIDDEN',
        message: 'Publishing the chain price list needs the pricing-policy permission.',
      })
    }

    const faults = checkRules(input.rules)
    if (faults.length > 0) {
      throw new ApiError({
        code: 'PRICE_RULES_INVALID',
        message: faults.map((f) => `Rule ${f.index + 1}: ${f.reason}`).join(' '),
      })
    }
    const dateFault = checkEffectiveFrom(input.effectiveFrom, this.today())
    if (dateFault) {
      throw new ApiError({ code: 'PRICE_DATE_INVALID', message: dateFault })
    }

    return db.transaction('rw', [db.meta], async () => {
      const rows = await this.priceRevisionRows()
      const seen = await db.meta.get(`${PRICE_POLICY_META_KEY}:key:${input.idempotencyKey}`)
      if (seen) {
        const original = rows.find((r) => r.id === seen.value)
        if (original) return original
      }

      const serial = rows.reduce((max, r) => Math.max(max, r.serial), 0) + 1
      const revision: PriceRevision = {
        id: `pr-${serial}`,
        serial,
        publishedAt: this.opts.now().toISOString(),
        publishedBy: me.name,
        effectiveFrom: input.effectiveFrom,
        note: input.note.trim(),
        rules: input.rules,
      }

      await db.meta.put({
        key: PRICE_POLICY_META_KEY,
        value: JSON.stringify([...rows, revision]),
      })
      await db.meta.put({
        key: `${PRICE_POLICY_META_KEY}:key:${input.idempotencyKey}`,
        value: revision.id,
      })
      return revision
    })
  }

  async getBrand(): Promise<BrandProfile> {
    const row = await db.meta.get(BRAND_META_KEY)
    return parseBrand(row?.value, DEFAULT_BRAND)
  }

  async saveBrand(brand: BrandProfile): Promise<BrandProfile> {
    // Coerced before it is stored, so the row on disk is always a complete
    // profile and `getBrand` never has to reason about a half-written one.
    const next = coerceBrand(brand, DEFAULT_BRAND)
    await db.meta.put({ key: BRAND_META_KEY, value: JSON.stringify(next) })
    return next
  }

  private async quoteContext(customerId?: number): Promise<QuoteContext> {
    const store = this.requireStore()
    const rates = await db.taxRates.toArray()
    const customer = customerId ? await db.customers.get(customerId) : undefined
    return {
      today: this.today(),
      expiryGuardDays: store.expiryGuardDays,
      nearExpiryWarnDays: store.nearExpiryBuckets.at(-1) ?? 30,
      roundOffEnabled: store.roundOffEnabled,
      taxRates: rates,
      medicines: this.index.medicines(),
      batchesByMedicine: this.index.allBatches(),
      ...(customer?.allergies?.length ? { customerAllergies: customer.allergies } : {}),
    }
  }

  async quoteSale(req: QuoteRequest): Promise<Quote> {
    await this.init()
    return computeQuote(req, await this.quoteContext(req.customerId))
  }

  async postSale(req: PostSaleRequest): Promise<SaleInvoice> {
    await this.init()
    const store = this.requireStore()

    // Replaying a key must return the ORIGINAL response. This is what makes the
    // offline outbox safe to retry, and it is checked before anything else.
    const seen = await db.idempotency.get(req.idempotencyKey)
    if (seen) {
      const existing = await db.invoices.get(seen.invoiceId)
      if (existing) return existing
    }

    // Never trust client totals: re-quote from current stock and current rates.
    const quote = computeQuote(req.quote, await this.quoteContext(req.customerId))

    const blocking = quote.warnings.filter((w) => w.blocking)
    const unmetH1 = blocking.filter((w) => w.code === 'SCHEDULE_H1')
    if (unmetH1.length > 0 && !req.prescription) {
      throw new ApiError({
        code: 'PRESCRIPTION_REQUIRED',
        message: 'Schedule H1 items need prescriber and patient details',
        details: unmetH1,
      })
    }
    const otherBlocking = blocking.filter((w) => w.code !== 'SCHEDULE_H1')
    if (otherBlocking.length > 0) {
      throw new ApiError({
        code: 'QUOTE_BLOCKED',
        message: otherBlocking[0]?.message ?? 'This bill cannot be saved',
        details: otherBlocking,
      })
    }
    if (quote.lines.some((l) => l.manualBatch) && !req.batchOverrideReason) {
      throw new ApiError({
        code: 'OVERRIDE_REASON_REQUIRED',
        message: 'Choosing a batch manually needs a reason',
      })
    }
    if (quote.lines.length === 0) {
      throw new ApiError({ code: 'EMPTY_CART', message: 'Nothing to bill' })
    }

    const paid = D.sum(req.payments.map((p) => D.dec(p.amount)))
    const net = D.dec(quote.netAmount)
    const hasCredit = req.payments.some((p) => p.mode === 'CREDIT')
    if (!hasCredit && D.lt(paid, net)) {
      throw new ApiError({
        code: 'UNDERPAID',
        message: `Tendered ${D.toStr(paid)} against ${quote.netAmount}`,
      })
    }

    const now = this.opts.now()
    const fy = financialYear(now, store.financialYearStartMonth)
    const seriesKey = `${store.id}:${fy}:${req.terminalId}:SALE`

    const touched = new Map<number, Batch>()
    // Every table the body TOUCHES has to be named here, reads included: Dexie
    // rejects an out-of-scope table at runtime, not at compile time, so a missing
    // name surfaces as a failed sale rather than as a type error. `customers` is
    // read for the snapshot below; `doctors` is written for the prescriber count.
    const invoice = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.invoices, db.docSeries, db.idempotency, db.customers, db.doctors],
      async () => {
        // Sorted and deduplicated before touching anything. Unsorted acquisition is
        // what deadlocks multi-line bills once this is real SQL.
        const batchIds = [...new Set(quote.lines.flatMap((l) => l.allocations.map((a) => a.batchId)))].sort(
          (a, b) => a - b,
        )
        const batches = new Map<number, Batch>()
        for (const id of batchIds) {
          const b = await db.batches.get(id)
          if (!b) throw new ApiError({ code: 'BATCH_MISSING', message: `Batch ${id} vanished` })
          batches.set(id, b)
        }

        const ledgerRows: StockLedgerRow[] = []
        for (const line of quote.lines) {
          for (const alloc of line.allocations) {
            const batch = batches.get(alloc.batchId)
            if (!batch) continue
            const take = D.add(D.dec(alloc.qty), D.dec(alloc.freeQty))
            const before = D.dec(batch.qtyOnHand)
            // The conditional decrement is the ONLY primitive that moves stock out.
            if (D.lt(before, take) && !store.allowNegativeStock) {
              throw new ApiError({
                code: 'STOCK_INSUFFICIENT',
                message: `Batch ${batch.batchNo} has ${D.toStr(before, 0)} left`,
                details: { batchId: batch.id },
              })
            }
            const after = D.sub(before, take)
            batch.qtyOnHand = D.toStr(after, 3)
            batches.set(batch.id, batch)
            ledgerRows.push({
              storeId: store.id,
              batchId: batch.id,
              medicineId: line.medicineId,
              at: now.toISOString(),
              qtyDelta: D.toStr(D.neg(take), 3),
              balanceAfter: D.toStr(after, 3),
              reason: 'SALE',
              refType: 'SALE_INVOICE',
              refId: req.idempotencyKey,
            })
          }
        }

        // The number is taken LAST, immediately before the write completes, so an
        // abort above never burns one.
        const series = (await db.docSeries.get(seriesKey)) ?? {
          key: seriesKey,
          storeId: store.id,
          financialYear: fy,
          terminalId: req.terminalId,
          docType: 'SALE' as const,
          prefix: store.invoicePrefix,
          nextNumber: 1,
        }
        const invoiceNo = `${series.prefix}${fy}-T${req.terminalId}-${String(series.nextNumber).padStart(5, '0')}`
        await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

        const customer = req.customerId ? await db.customers.get(req.customerId) : undefined
        const changeDue = hasCredit ? D.ZERO : D.max(D.sub(paid, net), D.ZERO)

        /*
         * A khata sale INCREASES what the customer owes.
         *
         * This was missing entirely: `db.customers` was written only by
         * recordCustomerReceipt, so `outstanding` could only ever go down. A shop
         * could sell on credit all week and the customer's balance would sit at
         * zero, then a single receipt would drive it negative. The receivable is
         * only trustworthy if both directions post, and both post HERE, inside the
         * same transaction as the invoice — a balance updated afterwards can be
         * lost to an abort while the bill survives.
         */
        const creditTaken = D.sum(
          req.payments.filter((p) => p.mode === 'CREDIT').map((p) => D.dec(p.amount)),
        )
        if (customer && D.gt(creditTaken, D.ZERO)) {
          await db.customers.put({
            ...customer,
            outstanding: D.toStr(D.add(D.dec(customer.outstanding), creditTaken), 2),
          })
        }

        // No `id` on the record. `++id` is an INBOUND auto-increment key: a value
        // that already carries one at the key path is stored under it instead of
        // under a generated key, so a hardcoded 0 took key 0 and the second sale
        // in the same database collided with the first.
        const record: Omit<SaleInvoice, 'id'> = {
          invoiceNo,
          storeId: store.id,
          terminalId: req.terminalId,
          invoiceDate: req.quote.invoiceDate,
          createdAt: now.toISOString(),
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? null,
          customerPhone: customer?.phone ?? null,
          interState: req.quote.interState,
          quote,
          payments: req.payments,
          amountPaid: D.toStr(paid),
          changeDue: D.toStr(changeDue),
          status: 'POSTED',
          prescription: req.prescription ?? null,
          operatorName: OPERATOR_NAME,
          ...(req.note ? { note: req.note } : {}),
        }

        for (const b of batches.values()) {
          await db.batches.put(b)
          touched.set(b.id, b)
        }
        /* The ledger rows are stamped with the DOCUMENT NUMBER, not the
           idempotency key they were staged with.
           A ledger row exists to be traced back to a document by a human, and a
           21-character nanoid is not a document anybody can look up — the
           Inventory movement history drops any id over 16 characters, so those
           rows read "sale" with no number at all. The number cannot be known
           when the rows are built (it is allocated last, so an abort never burns
           one), which is exactly why it is stamped on here instead. */
        for (const row of ledgerRows) await db.ledger.add({ ...row, refId: invoiceNo })
        const id = await db.invoices.add(record as SaleInvoice)
        const saved: SaleInvoice = { ...record, id }
        await db.invoices.put(saved)
        await db.idempotency.put({ key: req.idempotencyKey, invoiceId: id, at: now.toISOString() })

        // Counted in the SAME transaction as the invoice. A bill that exists
        // without its prescriber count, or a count without its bill, quietly
        // corrupts the ordering of the quick-pick list — and that ordering is the
        // only thing standing between the operator and retyping a name.
        const prescriberId = req.prescription?.prescriberId
        if (prescriberId !== undefined) {
          const doctor = await db.doctors.get(prescriberId)
          // A prescriber id with no row is stale client state, never a reason to
          // refuse a legal sale: the name is snapshotted on the invoice anyway.
          if (doctor) {
            await db.doctors.put({ ...doctor, prescriptionCount: doctor.prescriptionCount + 1 })
          }
        }
        return saved
      },
    )

    this.refresh(invoice.quote.lines.flatMap((l) => l.allocations).flatMap((a) => {
      const b = touched.get(a.batchId)
      return b ? [b] : []
    }))
    return invoice
  }

  async getInvoice(id: number): Promise<SaleInvoice> {
    const inv = await db.invoices.get(id)
    if (!inv) throw new ApiError({ code: 'NOT_FOUND', message: `Invoice ${id} not found` })
    return inv
  }

  async searchCustomers(term: string): Promise<Customer[]> {
    const q = term.toLowerCase().trim()
    if (!q) return []
    const all = await db.customers.toArray()
    return all
      .filter((c) => c.phone.includes(q) || c.name.toLowerCase().includes(q))
      .slice(0, 8)
  }

  async recentCustomers(limit: number): Promise<Customer[]> {
    if (limit <= 0) return []
    const [customers, posted] = await Promise.all([
      db.customers.toArray(),
      db.invoices.where('status').equals('POSTED').toArray().then((r) => this.mine(r)),
    ])
    const lastBilledAt = new Map<number, string>()
    for (const inv of posted) {
      if (inv.customerId === null) continue
      const seen = lastBilledAt.get(inv.customerId)
      if (seen === undefined || inv.createdAt > seen) lastBilledAt.set(inv.customerId, inv.createdAt)
    }
    return orderRecentCustomers(customers, lastBilledAt, limit)
  }

  async createCustomer(input: CustomerInput): Promise<Customer> {
    await this.init()
    const store = this.requireStore()
    const row = prepareCustomer(input, await db.customers.toArray())
    // The id is left off deliberately: `++id` is an inbound auto-increment key,
    // and a key that is already present in the value is USED rather than
    // generated — a hardcoded 0 would take key 0 and collide on the next insert.
    const record = { ...row, storeId: store.id } as Customer
    const id = await db.customers.add(record)
    // Nothing to invalidate: the in-memory index holds only the catalogue, and
    // both customer reads go to Dexie per call, so the row is visible at once.
    return { ...record, id }
  }

  async customerHistory(customerId: number, limit: number): Promise<SaleInvoice[]> {
    if (limit <= 0) return []
    const rows = this.mine(await db.invoices.where('customerId').equals(customerId).toArray())
    return rows
      .filter((inv) => inv.status === 'POSTED')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
      .slice(0, limit)
  }

  /* ------------------------------------------------------- the receivable ---
   *
   * Every rule the customers screen leans on — what ages into which bucket, what
   * a receipt may be, what a credit limit means when none was agreed — lives in
   * `./customers` as a function over arrays. What is left here is the part that
   * genuinely needs storage.
   */

  async listCustomers(): Promise<Customer[]> {
    await this.init()
    return (await db.customers.toArray()).sort(
      (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    )
  }

  async listCustomerBills(q: { limit: number; cursor?: number }): Promise<{ rows: SaleInvoice[]; nextCursor: number | null }> {
    await this.init()
    /* Clamped, and the caller is expected to page. `customerId` is indexed but a
       null key is not indexable in IndexedDB, so walk-ins cannot be excluded by
       the index and the filter has to happen here. */
    const limit = Math.max(1, Math.min(Math.floor(q.limit), 200))
    const all = this.mine(await db.invoices.toArray())
      .filter((inv) => inv.customerId !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
    const start = q.cursor !== undefined && q.cursor > 0 ? Math.min(Math.floor(q.cursor), all.length) : 0
    const rows = all.slice(start, start + limit)
    const next = start + rows.length
    return { rows, nextCursor: next < all.length ? next : null }
  }

  private async readReceipts(): Promise<CustomerReceipt[]> {
    const row = await db.meta.get(RECEIPTS_META_KEY)
    if (!row) return []
    try {
      return coerceReceipts(JSON.parse(row.value))
    } catch {
      // A corrupt blob must not take the screen down with it. The balances are
      // on the customer rows and stay readable; only the history is lost.
      return []
    }
  }

  async listCustomerReceipts(): Promise<CustomerReceipt[]> {
    await this.init()
    return (await this.readReceipts()).sort(
      (a, b) => b.at.localeCompare(a.at) || b.id - a.id,
    )
  }

  async recordCustomerReceipt(input: CustomerReceiptInput): Promise<CustomerReceipt> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const fy = financialYear(now, store.financialYearStartMonth)

    return db.transaction('rw', [db.customers, db.meta], async () => {
      const customer = await db.customers.get(input.customerId)
      if (!customer) {
        throw new ApiError({ code: 'NOT_FOUND', message: `Customer ${input.customerId} not found` })
      }
      const existing = await this.readReceipts()
      // Off the highest id, not off the count: a list that ever loses a row would
      // otherwise reissue a receipt number that is already on a customer's slip.
      const seq = existing.reduce((max, r) => Math.max(max, r.id), 0) + 1
      const receipt = prepareReceipt(input, customer, {
        id: seq,
        storeId: store.id,
        receiptNo: `RC${fy}-${String(seq).padStart(5, '0')}`,
        at: now.toISOString(),
        date: isoDate(now),
      })

      await db.meta.put({ key: RECEIPTS_META_KEY, value: JSON.stringify([...existing, receipt]) })
      // The balance moves in the SAME transaction as the document that explains
      // it. A balance that can disagree with the receipts behind it is worse
      // than no balance at all — the rule `postPurchase` follows on the payable.
      await db.customers.put({ ...customer, outstanding: receipt.balanceAfter })
      return receipt
    })
  }

  async searchDoctors(term: string): Promise<Doctor[]> {
    const q = term.toLowerCase().trim()
    if (!q) return []
    const all = await db.doctors.toArray()
    // Registration number and clinic are searchable because that is what the
    // operator has in front of them: a prescription pad prints the letterhead
    // far more legibly than it prints the signature.
    return all
      .filter((d) => matchesDoctor(d, q))
      .sort((a, b) => b.prescriptionCount - a.prescriptionCount || a.name.localeCompare(b.name))
      .slice(0, 8)
  }

  async recentDoctors(limit: number): Promise<Doctor[]> {
    if (limit <= 0) return []
    const all = await db.doctors.toArray()
    return all
      .sort((a, b) => b.prescriptionCount - a.prescriptionCount || a.name.localeCompare(b.name))
      .slice(0, limit)
  }

  async createDoctor(input: DoctorInput): Promise<Doctor> {
    await this.init()
    const store = this.requireStore()
    const row = prepareDoctor(input)
    // Returning the existing row rather than refusing: the operator is mid-bill
    // and wants a prescriber attached, not an error about one they already have.
    const existing = findExistingDoctor(await db.doctors.toArray(), row)
    if (existing) return existing
    const record = { ...row, storeId: store.id } as Doctor
    const id = await db.doctors.add(record)
    return { ...record, id }
  }

  async findSubstitutes(medicineId: number): Promise<MedicineSearchHit[]> {
    await this.init()
    return substitutesFor(medicineId, {
      medicines: this.index.medicines(),
      batchesFor: (id) => this.index.batchesFor(id),
      today: this.today(),
    })
  }

  async holdBill(b: Omit<HeldBill, 'savedAt'>): Promise<HeldBill> {
    const record: HeldBill = { ...b, savedAt: this.opts.now().toISOString() }
    await db.heldBills.put(record)
    return record
  }

  async listHeldBills(): Promise<HeldBill[]> {
    return (await db.heldBills.toArray()).sort((a, b) => a.token - b.token)
  }

  async recallBill(token: number): Promise<HeldBill> {
    const b = await db.heldBills.get(token)
    if (!b) throw new ApiError({ code: 'NOT_FOUND', message: `No bill held on token ${token}` })
    return b
  }

  async dropHeldBill(token: number): Promise<void> {
    await db.heldBills.delete(token)
  }

  /**
   * ONE round trip for the whole dashboard.
   *
   * Six separate queries would paint the screen six times, each with its own
   * loading and error state — and the KPI row would disagree with the panels
   * below it for a beat every time stock moved.
   */
  async getDashboard(date: IsoDate, range: DashboardRange = 'today'): Promise<DashboardData> {
    await this.init()
    const store = this.requireStore()
    // Outstanding is derived from CREDIT payments on posted invoices rather than
    // from customers.outstanding: a denormalised balance cannot answer "versus
    // yesterday", and it drifts the moment anything writes it without a document.
    const [allInvoices, shortbook, heldBills, stores, allBatches] = await Promise.all([
      db.invoices.toArray(),
      db.shortbook.toArray(),
      db.heldBills.toArray(),
      db.stores.toArray(),
      db.batches.toArray(),
    ])
    const invoices = this.mine(allInvoices)
    const base = computeDashboard({
      medicines: [...this.index.medicines().values()],
      batches: [...this.index.allBatches().values()].flat(),
      invoices,
      shortbook,
      heldBills,
      store,
      today: date,
      range,
    })

    /* The three newer queues come from the SAME engine the bell uses, not from a
       second implementation. They existed behind the bell for several waves
       while an owner opening the dashboard could not see any of them — which is
       exactly how two attention systems drift, with the stale one being the
       screen people actually look at. */
    const alerts = await this.attention()
    const of = (kind: string): number => alerts.find((a) => a.kind === kind)?.count ?? 0
    return {
      ...base,
      /* The ONE view in the app that deliberately reads across branches, and the
         only reason this method touches unscoped rows. `mine()` still guards
         everything else on the screen. */
      branches: branchComparison({
        stores,
        invoices: allInvoices,
        batches: allBatches,
        currentStoreId: store.id,
        from: base.periodStart,
        to: base.periodEnd,
        today: date,
      }),
      attention: {
        ...base.attention,
        claimsUnsettled: of('claimsUnsettled'),
        ordersOverdue: of('ordersOverdue'),
        /* A count of things to act on, and there is only ever one day to close —
           so this is 1 or 0 rather than the bill count the bell shows. */
        dayUnclosed: alerts.some((a) => a.kind === 'dayUnclosed') ? 1 : 0,
      },
    }
  }

  async addToShortbook(medicineId: number | null, term: string, qty: Qty): Promise<void> {
    const store = this.requireStore()
    await db.shortbook.add({
      storeId: store.id,
      medicineId,
      term,
      qty,
      at: this.opts.now().toISOString(),
    })
  }

  /* ------------------------------------------------------------- inventory ---
   *
   * The same split the medicine master uses: `./inventory` decides what the
   * rows MEAN and what a correction is allowed to do, and what is left here is
   * the part that genuinely needs storage.
   */

  private inventoryCatalogue(): InventoryCatalogue {
    return {
      // The whole shelf, delisted medicines included: stock does not stop
      // existing because a brand was taken out of the counter search, and this
      // screen is where the last of it gets sold through or written off.
      batches: [...this.index.allBatches().values()].flat(),
      medicineFor: (id) => this.catalogue.get(id),
      today: this.today(),
    }
  }

  async listBatches(
    filters: InventoryFilters,
  ): Promise<{ rows: BatchRow[]; total: number; nextCursor: number | null }> {
    await this.init()
    return buildBatchPage(this.inventoryCatalogue(), filters)
  }

  async inventorySummary(): Promise<InventorySummary> {
    await this.init()
    const store = this.requireStore()
    // The whole ledger, because the reconciliation count is the point of the
    // summary and it is the one number that cannot be derived from the batches
    // alone: it asks whether anything moved stock without saying so.
    const ledger = this.mine(await db.ledger.toArray())
    return buildInventorySummary({
      batches: [...this.index.allBatches().values()].flat(),
      medicines: [...this.catalogue.values()],
      ledger,
      today: this.today(),
      nearExpiryBuckets: store.nearExpiryBuckets,
    })
  }

  /**
   * Every movement this branch has ever had, oldest first.
   *
   * `listMovements` answers "what happened lately" and is capped and newest-
   * first for that reason. A running-balance register is the opposite question:
   * it has to start at the beginning, so there is no cap to apply and the order
   * is reversed. Sharing one method would mean a limit the register must not
   * have.
   */
  private async allMovements(): Promise<StockMovement[]> {
    const rows = this.mine(await db.ledger.toArray())
    const batches = new Map((await db.batches.toArray()).map((b) => [b.id, b]))
    return toStockMovements(rows, (id) => batches.get(id), (id) => this.catalogue.get(id), rows.length)
      .reverse()
  }

  async listMovements(q: { batchId?: number; medicineId?: number; limit: number }): Promise<StockMovement[]> {
    await this.init()
    const limit = Math.max(0, Math.min(Math.floor(q.limit), 500))
    const rows = q.batchId !== undefined
      ? await db.ledger.where('batchId').equals(q.batchId).toArray()
      : q.medicineId !== undefined
        ? await db.ledger.where('medicineId').equals(q.medicineId).toArray()
        // Unfiltered, the ledger is tens of thousands of rows on a seeded
        // database, and reading all of them to render a panel of twenty is the
        // kind of query that only hurts once the shop has history.
        : await db.ledger.orderBy('at').reverse().limit(limit).toArray()

    const batches = new Map<number, Batch>(
      [...this.index.allBatches().values()].flat().map((b): [number, Batch] => [b.id, b]),
    )
    return toStockMovements(rows, (id) => batches.get(id), (id) => this.catalogue.get(id), limit)
  }

  async adjustStock(input: StockAdjustmentInput): Promise<BatchRow> {
    await this.init()
    const store = this.requireStore()
    const at = this.opts.now().toISOString()

    const next = await db.transaction('rw', [db.batches, db.ledger], async () => {
      // Read INSIDE the transaction: the warm index is a copy, and a correction
      // has to be applied to the quantity that is actually on disk.
      const batch = await db.batches.get(input.batchId)
      if (!batch) throw new ApiError({ code: 'NOT_FOUND', message: `Batch ${input.batchId} not found` })
      const prepared = prepareAdjustment(batch, input)
      const updated = applyAdjustment(batch, prepared)
      await db.batches.put(updated)
      const row: StockLedgerRow = {
        storeId: store.id,
        batchId: updated.id,
        medicineId: updated.medicineId,
        at,
        qtyDelta: D.toStr(prepared.qtyDelta, 3),
        balanceAfter: D.toStr(prepared.balanceAfter, 3),
        reason: prepared.reason,
        // A manual correction has no document behind it — the ledger row IS the
        // document — so it is identified by the instant it was written.
        refType: 'STOCK_ADJUSTMENT',
        refId: at,
        note: prepared.note,
      }
      await db.ledger.add(row)
      return updated
    })

    this.refresh([next])
    return buildBatchRow(next, this.requireMedicine(next.medicineId), this.today())
  }

  /**
   * Block a batch from ever being allocated, or release it.
   *
   * Quarantine moves no stock, so this writes a ZERO-delta ledger row rather
   * than none at all: "why is this batch blocked" is asked at the shelf, days
   * later, and the ledger is the only place that can answer it. `balanceAfter`
   * is unchanged, so reconciliation is untouched by design.
   */
  async setBatchQuarantined(batchId: number, quarantined: boolean, note: string): Promise<BatchRow> {
    await this.init()
    const store = this.requireStore()
    const at = this.opts.now().toISOString()
    const reason = note.trim().replace(/\s+/g, ' ')

    const next = await db.transaction('rw', [db.batches, db.ledger], async () => {
      const batch = await db.batches.get(batchId)
      if (!batch) throw new ApiError({ code: 'NOT_FOUND', message: `Batch ${batchId} not found` })
      // Re-asserting the state a batch is already in is what a double-click
      // does. It is not a movement, and it must not write one.
      if (batch.isQuarantined === quarantined) return batch
      const updated: Batch = { ...batch, isQuarantined: quarantined }
      await db.batches.put(updated)
      await db.ledger.add({
        storeId: store.id,
        batchId: updated.id,
        medicineId: updated.medicineId,
        at,
        qtyDelta: '0.000',
        balanceAfter: D.toStr(D.dec(updated.qtyOnHand), 3),
        reason: 'ADJUSTMENT',
        refType: quarantined ? 'QUARANTINE' : 'QUARANTINE_RELEASE',
        refId: at,
        note: reason ? reason : null,
      })
      return updated
    })

    this.refresh([next])
    return buildBatchRow(next, this.requireMedicine(next.medicineId), this.today())
  }


  // ------------------------------------------------- returns to a supplier ---

  /**
   * The two ways stock goes back UP the chain.
   *
   * Split because GST splits them (CBIC Circular 72/46/2018): a purchase return
   * is a debit note reversing the credit its bill gave, while an expiry claim is
   * a fresh outward tax invoice from this shop whose settlement arrives later
   * and usually short. See `supplierReturns.ts` for the whole argument.
   */
  private async supplierReturnRows(): Promise<SupplierReturn[]> {
    const row = await db.meta.get(SUPPLIER_RETURNS_META_KEY)
    if (!row) return []
    try {
      const parsed: unknown = JSON.parse(row.value)
      return Array.isArray(parsed) ? (parsed as SupplierReturn[]) : []
    } catch {
      // A corrupt blob must not take the Purchases screen down with it. The stock
      // it moved is on the ledger, which is the record that matters.
      return []
    }
  }

  private async priceReturn(input: SupplierReturnInput): Promise<PricedSupplierReturn> {
    const store = this.requireStore()
    const supplier = await db.suppliers.get(input.supplierId)
    if (!supplier) {
      throw new ApiError({ code: 'NOT_FOUND', message: `Supplier ${input.supplierId} not found` })
    }
    const against = input.againstPurchaseId === null
      ? null
      : await db.purchases.get(input.againstPurchaseId)
    if (input.againstPurchaseId !== null && !against) {
      throw new ApiError({
        code: 'NOT_FOUND',
        message: `Purchase ${input.againstPurchaseId} not found`,
      })
    }
    /* A debit note against SOMEBODY ELSE'S bill is not a keying slip to shrug at
       — it reduces the wrong supplier's ledger, and both accounts are then wrong
       in opposite directions until somebody reconciles by hand. */
    if (against && against.supplierId !== input.supplierId) {
      throw new ApiError({
        code: 'PURCHASE_SUPPLIER_MISMATCH',
        message: `${against.purchaseNo} is ${against.supplierName}'s bill, not ${supplier.name}'s`,
        details: { supplierId: against.supplierId },
      })
    }

    const batches = new Map<number, Batch>()
    for (const line of input.lines) {
      if (batches.has(line.batchId)) continue
      const batch = await db.batches.get(line.batchId)
      if (batch) batches.set(line.batchId, batch)
    }

    return priceSupplierReturn(input, {
      storeId: store.id,
      supplierName: supplier.name,
      againstPurchaseNo: against?.purchaseNo ?? null,
      interState: isInterStateSupply(supplier.gstin, store.stateCode),
      operatorName: OPERATOR_NAME,
      batchOf: (id) => batches.get(id),
      medicineOf: (id) => this.catalogue.get(id),
      createdAt: this.opts.now().toISOString(),
    })
  }

  async quoteSupplierReturn(input: SupplierReturnInput): Promise<SupplierReturn> {
    await this.init()
    const priced = await this.priceReturn(input)
    /* A quote consumes NO number. Allocating one here would burn a gapless series
       on every keystroke the screen makes while the operator is still typing. */
    return { ...priced, id: 0, documentNo: '' }
  }

  async postSupplierReturn(input: SupplierReturnInput): Promise<SupplierReturn> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const at = now.toISOString()
    const fy = financialYear(now, store.financialYearStartMonth)
    const seriesKey = `${store.id}:${fy}:${input.terminalId}:${input.kind}`
    const touched = new Map<number, Batch>()

    const priced = await this.priceReturn(input)

    const saved = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.docSeries, db.meta, db.suppliers],
      async () => {
        const rows = await this.supplierReturnRows()
        const existing = await db.meta.get(`${SUPPLIER_RETURNS_META_KEY}:key:${input.idempotencyKey}`)
        if (existing) {
          const original = rows.find((r) => r.id === Number(existing.value))
          if (original) return original
        }

        const movements = returnMovements(priced)
        const batchIds = [...new Set(movements.map((m) => m.batchId))].sort((a, b) => a - b)
        const batches = new Map<number, Batch>()
        for (const id of batchIds) {
          const batch = await db.batches.get(id)
          if (!batch) {
            throw new ApiError({ code: 'BATCH_MISSING', message: `Batch ${id} vanished` })
          }
          batches.set(id, batch)
        }

        const ledgerRows: StockLedgerRow[] = []
        for (const move of movements) {
          const batch = batches.get(move.batchId)
          if (!batch) continue
          const before = D.dec(batch.qtyOnHand)
          const take = D.abs(D.dec(move.qtyDelta))
          /* Re-checked inside the transaction. `priceSupplierReturn` checked it
             too, but that read happened before this one and a sale in between
             would have taken the units — the conditional decrement is the only
             primitive that actually guarantees stock never goes negative. */
          if (D.lt(before, take)) {
            throw new ApiError({
              code: 'RETURN_EXCEEDS_STOCK',
              message: `Batch ${batch.batchNo} has ${D.toStr(before, 0)} left`,
              details: { batchId: batch.id },
            })
          }
          const after = D.sub(before, take)
          batch.qtyOnHand = D.toStr(after, 3)
          batches.set(batch.id, batch)
          ledgerRows.push({
            storeId: store.id,
            batchId: batch.id,
            medicineId: move.medicineId,
            at,
            qtyDelta: move.qtyDelta,
            balanceAfter: D.toStr(after, 3),
            /* The ledger's OWN vocabulary, which already had both of these.
               A debit note is a PURCHASE_RETURN; an expiry claim writes the
               stock off the shelf and is an EXPIRY_WRITEOFF — reading them both
               as "Adjustment" in the movement history would hide the one
               movement an auditor looks for by name. */
            reason: move.reason === 'PURCHASE_RETURN' ? 'PURCHASE_RETURN' : 'EXPIRY_WRITEOFF',
            refType: move.reason,
            refId: '',
            note: priced.reason,
          })
        }

        // The number LAST, so an abort above never burns one.
        const series = (await db.docSeries.get(seriesKey)) ?? {
          key: seriesKey,
          storeId: store.id,
          financialYear: fy,
          terminalId: input.terminalId,
          docType: input.kind,
          prefix: `${store.invoicePrefix}${input.kind === 'PURCHASE_RETURN' ? 'DN' : 'EC'}`,
          nextNumber: 1,
        }
        const documentNo = `${series.prefix}${fy}-${String(series.nextNumber).padStart(5, '0')}`
        await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

        const id = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
        // Stamped with the DOCUMENT number, not the idempotency key — a ledger
        // row has to be traceable to a document by a human. Same rule as sales.
        for (const row of ledgerRows) await db.ledger.add({ ...row, refId: documentNo })

        for (const b of batches.values()) {
          await db.batches.put(b)
          touched.set(b.id, b)
        }

        const doc: SupplierReturn = { ...priced, id, documentNo }

        /* A DEBIT NOTE reduces what this supplier is owed. An EXPIRY CLAIM does
           NOT — and that difference is the entire reason these are two document
           types rather than one.
           A claim is a fresh outward supply to the manufacturer whose credit
           arrives separately, weeks later and usually short. Booking it here as
           a reduction of the supplier's bill would understate the payable by the
           claim value from the day it is raised until that credit turns up, and
           would leave the shortfall — the money actually lost to a breakage
           allowance — with nowhere to be recorded at all. It is tracked on the
           claim itself instead, by `settleClaim`. */
        if (doc.kind === 'PURCHASE_RETURN') {
          const supplier = await db.suppliers.get(doc.supplierId)
          if (supplier) {
            await db.suppliers.put({
              ...supplier,
              /* Clamped at zero, like the customer side: a debit note against a
                 bill already paid off would otherwise turn the payable into a
                 negative balance the shop does not actually hold. */
              outstanding: D.toStr(
                D.max(D.ZERO, D.sub(D.dec(supplier.outstanding), D.dec(doc.netAmount))),
                2,
              ),
            })
          }
        }

        await db.meta.put({
          key: SUPPLIER_RETURNS_META_KEY,
          value: JSON.stringify([...rows, doc]),
        })
        await db.meta.put({
          key: `${SUPPLIER_RETURNS_META_KEY}:key:${input.idempotencyKey}`,
          value: String(id),
        })
        return doc
      },
    )

    this.refresh([...touched.values()])
    return saved
  }

  async listSupplierReturns(
    q: { kind?: ReturnKind; supplierId?: number },
  ): Promise<SupplierReturn[]> {
    await this.init()
    /* Scoped here rather than in `supplierReturnRows`, which the WRITE path
       also uses — allocating the next id from one branch's rows only would
       collide with the other's the moment both raised a document. */
    return this.mine(await this.supplierReturnRows())
      .filter((r) => (q.kind === undefined || r.kind === q.kind))
      .filter((r) => (q.supplierId === undefined || r.supplierId === q.supplierId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  }

  async settleClaim(input: ClaimSettlementInput): Promise<SupplierReturn> {
    await this.init()
    return db.transaction('rw', [db.meta], async () => {
      const rows = await this.supplierReturnRows()
      const doc = rows.find((r) => r.id === input.returnId)
      if (!doc) {
        throw new ApiError({ code: 'NOT_FOUND', message: `Return ${input.returnId} not found` })
      }
      const settled = settleClaimDoc(doc, input)
      await db.meta.put({
        key: SUPPLIER_RETURNS_META_KEY,
        value: JSON.stringify(rows.map((r) => (r.id === settled.id ? settled : r))),
      })
      return settled
    })
  }


  // ------------------------------------------------------------- importing ---

  /**
   * What the importer has learned about one supplier.
   *
   * Empty on the first import and never empty again. Stored per supplier rather
   * than globally because two distributors legitimately use the same product
   * name for different packs, and a global alias table would teach one bill's
   * decision to another supplier's bill.
   */
  async getImportProfile(supplierId: number): Promise<ImportProfile> {
    await this.init()
    const row = await db.meta.get(`${IMPORT_PROFILE_PREFIX}:${supplierId}`)
    const blank: ImportProfile = {
      supplierId,
      columns: {},
      aliases: {},
      updatedAt: this.opts.now().toISOString(),
    }
    if (!row) return blank
    try {
      const parsed = JSON.parse(row.value) as Partial<ImportProfile>
      return {
        supplierId,
        columns: parsed.columns ?? {},
        aliases: parsed.aliases ?? {},
        updatedAt: parsed.updatedAt ?? blank.updatedAt,
      }
    } catch {
      // A corrupt profile costs one import's worth of re-mapping, never the
      // import itself. Failing here would make a bad blob unrecoverable.
      return blank
    }
  }

  /** `medicineId -> the pack MRPs on its batches`. Built from the warm index,
   *  so it costs a walk of stock already in memory rather than a read. */
  private packMrpIndex(): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>()
    for (const [medicineId, batches] of this.index.allBatches()) {
      const seen = out.get(medicineId) ?? new Set<string>()
      for (const b of batches) seen.add(D.toStr(D.dec(b.mrpPerPack), 2))
      out.set(medicineId, seen)
    }
    return out
  }

  async matchImportRows(input: {
    supplierId: number
    headers: string[]
    rows: string[][]
    columns: Record<string, number>
  }): Promise<ImportRowDto[]> {
    await this.init()
    const profile = await this.getImportProfile(input.supplierId)
    const built = buildRows(
      { delimiter: ',', headers: input.headers, rows: input.rows, ragged: 0 },
      input.columns as ColumnMap,
      {
        // The WHOLE catalogue and the WHOLE barcode map, both already in memory
        // for the counter's own search.
        medicines: [...this.catalogue.values()],
        barcodes: this.barcodeOwners,
        aliases: new Map(Object.entries(profile.aliases)),
        /* Which pack MRPs each medicine has actually been received at. This is
           what separates "Dolo 650" in four pack sizes when the bill names only
           the brand — without it the operator hand-picks a pack on nearly every
           line, which is most of the work this feature exists to remove. */
        packMrps: this.packMrpIndex(),
      },
    )
    return built.map((r) => ({
      index: r.index,
      name: r.name,
      barcode: r.barcode,
      matchKind: r.match.kind,
      medicineId: r.medicineId,
      candidates: r.match.candidates.map((c) => ({
        id: c.id, brandName: c.brandName, packLabel: c.packLabel,
      })),
      problems: r.problems,
      line: r.line,
    }))
  }

  async saveImportProfile(input: {
    supplierId: number
    columns: Record<string, number>
    aliases: Record<string, number>
  }): Promise<ImportProfile> {
    await this.init()
    const existing = await this.getImportProfile(input.supplierId)
    const next: ImportProfile = {
      supplierId: input.supplierId,
      /* The mapping is REPLACED — a supplier who changes their export layout
         has one layout, and merging would leave the old columns pointing at
         positions that no longer exist. */
      columns: input.columns,
      /* The aliases are MERGED. Every one of them was a human decision, and an
         import that only touched four products must not forget the other three
         hundred already taught. */
      aliases: { ...existing.aliases, ...input.aliases },
      updatedAt: this.opts.now().toISOString(),
    }
    await db.meta.put({
      key: `${IMPORT_PROFILE_PREFIX}:${input.supplierId}`,
      value: JSON.stringify(next),
    })
    return next
  }


  // -------------------------------------------------------------- ordering ---

  private async purchaseOrderRows(): Promise<PurchaseOrder[]> {
    const row = await db.meta.get(PURCHASE_ORDERS_META_KEY)
    if (!row) return []
    try {
      const parsed: unknown = JSON.parse(row.value)
      return Array.isArray(parsed) ? (parsed as PurchaseOrder[]) : []
    } catch {
      // A corrupt blob costs the "on order" subtraction, which over-orders — bad,
      // but recoverable. Throwing would take the Purchases screen down instead.
      return []
    }
  }

  /**
   * What to order, with the working.
   *
   * Reads only. The sales window is counted from the invoices rather than from a
   * cached rank, because `sale_rank` is refreshed nightly and a line that started
   * moving this week is exactly the one an order needs to catch.
   */
  async suggestReorder(q?: Partial<ReorderSettings>): Promise<ReorderSuggestion[]> {
    await this.init()
    const settings = { ...DEFAULT_SETTINGS, ...q }
    const today = this.today()
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - settings.historyDays * 86_400_000)
      .toISOString()
      .slice(0, 10)

    const [invoices, orders, shortbook, purchases] = await Promise.all([
      db.invoices.where('invoiceDate').aboveOrEqual(from).toArray().then((r) => this.mine(r)),
      this.purchaseOrderRows().then((r) => this.mine(r)),
      this.listShortbook(),
      db.purchases.toArray().then((r) => this.mine(r)),
    ])

    const soldInWindow = new Map<number, D.Decimal>()
    for (const invoice of invoices) {
      // A VOIDED bill sold nothing. Counting it orders stock to replace units
      // that went back on the shelf the same day.
      if (invoice.status !== 'POSTED') continue
      for (const line of invoice.quote.lines) {
        for (const alloc of line.allocations) {
          const moved = D.add(D.dec(alloc.qty), D.dec(alloc.freeQty))
          soldInWindow.set(
            line.medicineId,
            D.add(soldInWindow.get(line.medicineId) ?? D.ZERO, moved),
          )
        }
      }
    }

    /* Who last supplied each medicine, newest bill first, so an order can be
       split by distributor without asking. */
    const lastSupplierOf = new Map<number, { id: number; name: string }>()
    for (const purchase of [...purchases].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate))) {
      if (purchase.status !== 'POSTED') continue
      for (const line of purchase.lines) {
        lastSupplierOf.set(line.medicineId, { id: purchase.supplierId, name: purchase.supplierName })
      }
    }

    const batches = this.index.allBatches()
    return suggestReorderLines({
      medicines: [...this.catalogue.values()],
      batchesOf: (id) => batches.get(id) ?? [],
      soldInWindow,
      onOrder: onOrderQuantities(orders),
      shortbook,
      lastSupplier: (id) => lastSupplierOf.get(id) ?? null,
      today,
    }, settings)
  }

  async createPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const fy = financialYear(now, store.financialYearStartMonth)
    const seriesKey = `${store.id}:${fy}:0:PURCHASE_ORDER`

    const supplier = await db.suppliers.get(input.supplierId)
    if (!supplier) {
      throw new ApiError({ code: 'NOT_FOUND', message: `Supplier ${input.supplierId} not found` })
    }
    const lines = input.lines.filter((l) => D.gt(D.dec(l.qty), D.ZERO))
    if (lines.length === 0) {
      throw new ApiError({ code: 'ORDER_EMPTY', message: 'There is nothing on this order' })
    }

    return db.transaction('rw', [db.meta, db.docSeries], async () => {
      const rows = await this.purchaseOrderRows()
      const seen = await db.meta.get(`${PURCHASE_ORDERS_META_KEY}:key:${input.idempotencyKey}`)
      if (seen) {
        const original = rows.find((r) => r.id === Number(seen.value))
        if (original) return original
      }

      // The number LAST, so an abort above never burns one.
      const series = (await db.docSeries.get(seriesKey)) ?? {
        key: seriesKey,
        storeId: store.id,
        financialYear: fy,
        terminalId: 0,
        docType: 'PURCHASE_ORDER' as const,
        prefix: 'PO',
        nextNumber: 1,
      }
      const orderNo = `${series.prefix}${fy}-${String(series.nextNumber).padStart(5, '0')}`
      await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

      const order: PurchaseOrder = {
        id: rows.reduce((max, r) => Math.max(max, r.id), 0) + 1,
        orderNo,
        storeId: store.id,
        supplierId: supplier.id,
        supplierName: supplier.name,
        placedOn: isoDate(now),
        expectedOn: input.expectedOn,
        createdAt: now.toISOString(),
        operatorName: OPERATOR_NAME,
        note: input.note?.trim() || null,
        status: 'OPEN',
        lines: lines.map((l) => {
          const medicine = this.catalogue.get(l.medicineId)
          return {
            lineId: l.lineId,
            medicineId: l.medicineId,
            brandName: medicine?.brandName ?? `#${l.medicineId}`,
            packLabel: medicine?.packLabel ?? '',
            qty: l.qty,
            receivedQty: '0',
            /* The engine's reasoning, FROZEN on the line. Six weeks later "why
               did we order forty of these" has an answer on the document rather
               than requiring the rate to be recomputed from history that has
               since moved. */
            basis: l.basis,
          }
        }),
      }
      await db.meta.put({
        key: PURCHASE_ORDERS_META_KEY,
        value: JSON.stringify([...rows, order]),
      })
      await db.meta.put({
        key: `${PURCHASE_ORDERS_META_KEY}:key:${input.idempotencyKey}`,
        value: String(order.id),
      })
      return order
    })
  }

  async listPurchaseOrders(q: { status?: PurchaseOrder['status'] }): Promise<PurchaseOrder[]> {
    await this.init()
    return this.mine(await this.purchaseOrderRows())
      .filter((o) => q.status === undefined || o.status === q.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  }

  async cancelPurchaseOrder(id: number, reason: string): Promise<PurchaseOrder> {
    await this.init()
    const trimmed = (reason ?? '').trim().replace(/\s+/g, ' ')
    if (trimmed.length < 6) {
      throw new ApiError({
        code: 'CANCEL_REASON_REQUIRED',
        message: 'Say why the order is being cancelled — the distributor may still deliver it',
        details: { field: 'reason' },
      })
    }
    return db.transaction('rw', [db.meta], async () => {
      const rows = await this.purchaseOrderRows()
      const order = rows.find((r) => r.id === id)
      if (!order) throw new ApiError({ code: 'NOT_FOUND', message: `Order ${id} not found` })
      if (order.status === 'CANCELLED') {
        throw new ApiError({ code: 'ORDER_ALREADY_CANCELLED', message: `${order.orderNo} is already cancelled` })
      }
      /* Kept, never deleted, and the reason kept with it: a distributor who has
         already loaded the van will still deliver, and somebody has to be able
         to say what happened. */
      const next: PurchaseOrder = {
        ...order,
        status: 'CANCELLED',
        note: order.note ? `${order.note} · Cancelled: ${trimmed}` : `Cancelled: ${trimmed}`,
      }
      await db.meta.put({
        key: PURCHASE_ORDERS_META_KEY,
        value: JSON.stringify(rows.map((r) => (r.id === next.id ? next : r))),
      })
      return next
    })
  }

  /**
   * Is this period fit to file?
   *
   * Reads only, and asserts no law: every threshold comes off the store profile
   * and is printed in the result's `basis` beside the figure it used.
   */
  async checkFiling(q: { from: IsoDate; to: IsoDate }): Promise<FilingCheck> {
    await this.init()
    const store = this.requireStore()
    const [invoices, register, customers] = await Promise.all([
      db.invoices.where('invoiceDate').between(q.from, q.to, true, true).toArray()
        .then((r) => this.mine(r)),
      this.saleReturnRegister(),
      db.customers.toArray(),
    ])
    return checkFilingPeriod(q.from, q.to, {
      invoices,
      creditNotes: register.notes,
      customers,
      store,
      generatedAt: this.opts.now().toISOString(),
    })
  }

  /**
   * Invariant I17, checked on demand.
   *
   * Reads the whole ledger, which is the point — a sampled reconciliation finds
   * nothing, because the batches that drift are exactly the ones nothing has
   * looked at.
   */
  async checkStockHealth(): Promise<StockHealth> {
    await this.init()
    const [batches, ledger] = await Promise.all([
      db.batches.toArray(),
      db.ledger.toArray().then((r) => this.mine(r)),
    ])
    const report = reconcileStock({
      batches,
      ledger,
      medicineFor: (id) => this.catalogue.get(id),
      generatedAt: this.opts.now().toISOString(),
    })
    return { ...report, summary: healthSummary(report) }
  }

  async attention(): Promise<AttentionAlert[]> {
    await this.init()
    const now = this.opts.now()
    const today = this.today()
    const [customers, returns, orders, close, invoicesToday] = await Promise.all([
      db.customers.toArray(),
      this.supplierReturnRows().then((r) => this.mine(r)),
      this.purchaseOrderRows().then((r) => this.mine(r)),
      /* Terminal 1: this build runs one till, and the sales screen uses the
         same constant. When terminals become real this reads the session's. */
      this.getDayClose(today, 1),
      db.invoices.where('invoiceDate').equals(today).toArray()
        .then((r) => this.mine(r).length),
    ])
    return attentionItems({
      batches: [...this.index.allBatches().values()].flat(),
      medicineFor: (id) => this.catalogue.get(id),
      customers,
      supplierReturns: returns,
      purchaseOrders: orders,
      todayClose: close,
      invoicesToday,
      /* The LOCAL hour. `getUTCHours` would decide the shop should have closed
         at half past one in the afternoon in India. */
      hour: now.getHours(),
      today,
    })
  }

  // ------------------------------------------------------------- transfers ---

  private async transferRows(): Promise<StockTransferDoc[]> {
    const row = await db.meta.get(TRANSFERS_META_KEY)
    if (!row) return []
    try {
      const parsed: unknown = JSON.parse(row.value)
      return Array.isArray(parsed) ? (parsed as StockTransferDoc[]) : []
    } catch {
      // The stock it moved is on the ledger, which is the record that matters.
      return []
    }
  }

  private async priceTransferInput(input: StockTransferInput): Promise<PricedTransfer> {
    const [from, to] = await Promise.all([
      db.stores.get(input.fromStoreId),
      db.stores.get(input.toStoreId),
    ])
    if (!from) throw new ApiError({ code: 'NOT_FOUND', message: 'Sending branch not found' })
    if (!to) throw new ApiError({ code: 'NOT_FOUND', message: 'Receiving branch not found' })

    const batches = new Map<number, Batch>()
    for (const line of input.lines) {
      if (batches.has(line.batchId)) continue
      const batch = await db.batches.get(line.batchId)
      if (batch) batches.set(line.batchId, batch)
    }

    return priceTransfer(input, {
      from,
      to,
      batchOf: (id) => batches.get(id),
      medicineOf: (id) => this.catalogue.get(id),
      operatorName: OPERATOR_NAME,
      createdAt: this.opts.now().toISOString(),
    })
  }

  async quoteTransfer(input: StockTransferInput): Promise<StockTransferDoc> {
    await this.init()
    const priced = await this.priceTransferInput(input)
    // A quote consumes NO number: allocating one per keystroke would burn a
    // gapless series while the operator is still choosing what to send.
    return { ...priced, id: 0, documentNo: '' }
  }

  async postTransfer(input: StockTransferInput): Promise<StockTransferDoc> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const at = now.toISOString()
    const fy = financialYear(now, store.financialYearStartMonth)
    const seriesKey = `${input.fromStoreId}:${fy}:0:TRANSFER`
    const touched = new Map<number, Batch>()

    const priced = await this.priceTransferInput(input)

    const saved = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.docSeries, db.meta],
      async () => {
        const rows = await this.transferRows()
        const seen = await db.meta.get(`${TRANSFERS_META_KEY}:key:${input.idempotencyKey}`)
        if (seen) {
          const original = rows.find((r) => r.id === Number(seen.value))
          if (original) return original
        }

        const destination = await db.batches
          .filter((b) => b.storeId === input.toStoreId)
          .toArray()

        const ledgerRows: StockLedgerRow[] = []

        for (const line of priced.lines) {
          const source = await db.batches.get(line.batchId)
          if (!source) {
            throw new ApiError({ code: 'BATCH_MISSING', message: `Batch ${line.batchId} vanished` })
          }
          const qty = D.dec(line.qty)
          const before = D.dec(source.qtyOnHand)
          /* Re-checked INSIDE the transaction. The pricing read happened before
             this one, and a sale in between would have taken the units — the
             conditional decrement is the only thing that actually guarantees
             stock never goes negative. */
          if (D.lt(before, qty)) {
            throw new ApiError({
              code: 'TRANSFER_EXCEEDS_STOCK',
              message: `Batch ${source.batchNo} has ${D.toStr(before, 0)} left`,
              details: { batchId: source.id },
            })
          }

          const after = D.sub(before, qty)
          const out = { ...source, qtyOnHand: D.toStr(after, 3) }
          await db.batches.put(out)
          touched.set(out.id, out)
          ledgerRows.push({
            storeId: input.fromStoreId,
            batchId: source.id,
            medicineId: line.medicineId,
            at,
            qtyDelta: D.toStr(D.neg(qty), 3),
            balanceAfter: D.toStr(after, 3),
            reason: 'TRANSFER',
            refType: 'STOCK_TRANSFER',
            refId: '',
            note: priced.reason,
          })

          /* The SAME batch arriving: medicine, number, expiry and printed MRP.
             Creating a fresh one would break FEFO at the destination and let the
             receiving shop sell newer stock first. */
          const existing = findDestinationBatch(line, destination)
          if (existing) {
            const grown = D.add(D.dec(existing.qtyOnHand), qty)
            const into = { ...existing, qtyOnHand: D.toStr(grown, 3) }
            await db.batches.put(into)
            touched.set(into.id, into)
            const idx = destination.findIndex((b) => b.id === into.id)
            if (idx >= 0) destination[idx] = into
            ledgerRows.push({
              storeId: input.toStoreId,
              batchId: into.id,
              medicineId: line.medicineId,
              at,
              qtyDelta: D.toStr(qty, 3),
              balanceAfter: D.toStr(grown, 3),
              reason: 'TRANSFER',
              refType: 'STOCK_TRANSFER',
              refId: '',
              note: priced.reason,
            })
          } else {
            const made = newDestinationBatch(line, source, input.toStoreId)
            const id = await db.batches.add(made as Batch)
            const created = { ...made, id } as Batch
            destination.push(created)
            touched.set(id, created)
            ledgerRows.push({
              storeId: input.toStoreId,
              batchId: id,
              medicineId: line.medicineId,
              at,
              qtyDelta: D.toStr(qty, 3),
              balanceAfter: D.toStr(qty, 3),
              reason: 'TRANSFER',
              refType: 'STOCK_TRANSFER',
              refId: '',
              note: priced.reason,
            })
          }
        }

        // The number LAST, so an abort above never burns one.
        const series = (await db.docSeries.get(seriesKey)) ?? {
          key: seriesKey,
          storeId: input.fromStoreId,
          financialYear: fy,
          terminalId: 0,
          docType: 'TRANSFER' as const,
          prefix: 'TRF',
          nextNumber: 1,
        }
        const documentNo = `${series.prefix}${fy}-${String(series.nextNumber).padStart(5, '0')}`
        await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

        // Stamped with the DOCUMENT number: a ledger row has to be traceable to
        // a piece of paper by a human, on both sides of the move.
        for (const row of ledgerRows) await db.ledger.add({ ...row, refId: documentNo })

        const id = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
        const doc: StockTransferDoc = { ...priced, id, documentNo }
        await db.meta.put({ key: TRANSFERS_META_KEY, value: JSON.stringify([...rows, doc]) })
        await db.meta.put({
          key: `${TRANSFERS_META_KEY}:key:${input.idempotencyKey}`,
          value: String(id),
        })
        return doc
      },
    )

    /* Only THIS branch's touched batches reach the warm index — the destination
       rows belong to a shelf this session cannot see, and pushing them in would
       be the cross-branch leak the whole scoping exists to prevent. */
    this.refresh([...touched.values()].filter((b) => b.storeId === store.id))
    return saved
  }

  async listTransfers(): Promise<StockTransferDoc[]> {
    await this.init()
    const id = this.requireStore().id
    /* BOTH directions. A movement this branch received is as much its business
       as one it sent, and a list showing only what left would leave a receiving
       branch unable to explain where its stock came from. */
    return (await this.transferRows())
      .filter((t) => t.fromStoreId === id || t.toStoreId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  }

  async listShortbook(): Promise<ShortbookEntry[]> {
    await this.init()
    const rows = await db.shortbook.toArray()
    return buildShortbookEntries({
      rows,
      medicineFor: (id) => this.catalogue.get(id),
      batchesFor: (id) => this.index.batchesFor(id),
      today: this.today(),
    })
  }

  async clearShortbook(id: number): Promise<void> {
    await db.shortbook.delete(id)
  }

  /* ------------------------------------------------------------- purchases ---
   *
   * `quotePurchase` prices and creates nothing; `postPurchase` is the
   * transaction. The same split as quoteSale/postSale, for the same reason: the
   * screen re-prices on every keystroke, and a receipt that consumed a document
   * number or created a batch per keystroke would be unusable.
   */

  private async requireSupplier(id: number): Promise<Supplier> {
    const supplier = await db.suppliers.get(id)
    if (!supplier) throw new ApiError({ code: 'NOT_FOUND', message: `Supplier ${id} not found` })
    return supplier
  }

  async listSuppliers(term?: string): Promise<Supplier[]> {
    await this.init()
    const q = (term ?? '').trim().toLowerCase()
    const all = await db.suppliers.toArray()
    // An empty term lists everyone. This is the distributor MASTER as well as a
    // picker, and a master that shows nothing until you type cannot be browsed.
    return all
      .filter((s) => !q || matchesSupplier(s, q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async createSupplier(input: SupplierInput): Promise<Supplier> {
    await this.init()
    const store = this.requireStore()
    const row = prepareSupplier(input, await db.suppliers.toArray())
    // No `id` on the record: `++id` is an INBOUND auto-increment key, and a
    // value that already carries one is stored under it rather than under a
    // generated key — the trap createCustomer documents.
    const record = { ...row, storeId: store.id } as Supplier
    const id = await db.suppliers.add(record)
    return { ...record, id }
  }

  async updateSupplier(id: number, input: Partial<SupplierInput>): Promise<Supplier> {
    await this.init()
    const all = await db.suppliers.toArray()
    const current = all.find((s) => s.id === id)
    if (!current) throw new ApiError({ code: 'NOT_FOUND', message: `Supplier ${id} not found` })
    const next = applySupplierUpdate(current, input, all)
    await db.suppliers.put(next)
    return next
  }

  /** What each medicine last arrived at, so a changed rate can be flagged on the
   *  receipt rather than discovered in a margin report a month later. */
  private lastPurchaseRates(purchases: readonly PurchaseInvoice[]): Map<number, Money> {
    const latest = new Map<number, { at: string; rate: Money }>()
    for (const p of purchases) {
      if (p.status === 'CANCELLED') continue
      for (const line of p.lines) {
        const seen = latest.get(line.medicineId)
        if (!seen || p.createdAt > seen.at) latest.set(line.medicineId, { at: p.createdAt, rate: line.ratePerPack })
      }
    }
    const out = new Map<number, Money>()
    for (const [medicineId, v] of latest) out.set(medicineId, v.rate)
    return out
  }

  private purchaseContext(supplier: Supplier, purchases: readonly PurchaseInvoice[]): PurchasePricingContext {
    const store = this.requireStore()
    const lastRates = this.lastPurchaseRates(purchases)
    return {
      storeId: store.id,
      storeStateCode: store.stateCode,
      roundOffEnabled: store.roundOffEnabled,
      supplier,
      // The whole catalogue, not the search index: receiving stock for a
      // medicine that has been delisted is exactly how it comes back.
      medicineFor: (id) => this.catalogue.get(id),
      lastRatePerPack: (id) => lastRates.get(id) ?? null,
      createdAt: this.opts.now().toISOString(),
    }
  }

  private async replayedPurchase(key: string): Promise<PurchaseInvoice | undefined> {
    const seen = await db.purchaseIdempotency.get(key)
    return seen ? await db.purchases.get(seen.purchaseId) : undefined
  }

  async quotePurchase(input: PurchaseInvoiceInput): Promise<PurchaseInvoice> {
    await this.init()
    const [supplier, purchases] = await Promise.all([
      this.requireSupplier(input.supplierId),
      db.purchases.toArray().then((r) => this.mine(r)),
    ])
    const priced = pricePurchase(input, this.purchaseContext(supplier, purchases))
    // The two fields a posted document has and a priced one does not. They are
    // filled in here only because the contract returns one shape for both.
    return { ...priced.invoice, id: 0, purchaseNo: '' }
  }

  async postPurchase(input: PurchaseInvoiceInput): Promise<PurchaseInvoice> {
    await this.init()
    const store = this.requireStore()

    const key = (input.idempotencyKey ?? '').trim()
    if (!key) {
      throw new ApiError({
        code: 'PURCHASE_INVALID',
        message: 'A goods receipt needs an idempotency key',
        details: { field: 'idempotencyKey' },
      })
    }

    const [supplier, purchases] = await Promise.all([
      this.requireSupplier(input.supplierId),
      db.purchases.toArray().then((r) => this.mine(r)),
    ])

    // Advisory: a replay returns the ORIGINAL document, and the same distributor
    // bill is never received twice. Both are asked again inside the transaction,
    // which is the copy that decides.
    const early = precheckPurchase(input, {
      replay: await this.replayedPurchase(key),
      existing: purchases,
    })
    if (early) return early

    // Never trust the screen's numbers: the receipt is re-priced from the
    // catalogue here, exactly as postSale re-quotes from current stock.
    const priced = pricePurchase(input, this.purchaseContext(supplier, purchases))

    const now = this.opts.now()
    const at = now.toISOString()
    const fy = financialYear(now, store.financialYearStartMonth)
    // A goods receipt is a STORE document: the stock arrives at the shop, not at
    // a till, so unlike a sales invoice this series is not per terminal.
    const seriesKey = `${store.id}:${fy}:0:PURCHASE`

    const touched = new Map<number, Batch>()
    const invoice = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.purchases, db.docSeries, db.purchaseIdempotency, db.suppliers],
      async () => {
        const settled = precheckPurchase(input, {
          replay: await this.replayedPurchase(key),
          existing: this.mine(await db.purchases.toArray()),
        })
        if (settled) return settled

        // Every existing batch of every medicine on the bill, read once and
        // keyed by identity. Ids ascending, for the reason postSale sorts them.
        const medicineIds = [...new Set(priced.lines.map((l) => l.medicine.id))].sort((a, b) => a - b)
        const byIdentity = new Map<string, Batch>()
        for (const medicineId of medicineIds) {
          for (const b of await db.batches.where('medicineId').equals(medicineId).toArray()) {
            byIdentity.set(batchIdentityKey(b), b)
          }
        }

        const ledgerRows: StockLedgerRow[] = []
        const lines: PurchaseLine[] = []

        for (const priceLine of priced.lines) {
          // MRP is in the key: the same printed batch number at a revised MRP is
          // a DIFFERENT batch, because the customer pays what is printed on the
          // strip in their hand (invariant I7).
          const identity = batchIdentityKey({
            storeId: store.id,
            medicineId: priceLine.medicine.id,
            batchNo: priceLine.line.batchNo,
            expiryDate: priceLine.expiryDate,
            mrpPerPack: priceLine.line.mrpPerPack,
          })

          let batch = byIdentity.get(identity)
          if (!batch) {
            // Created empty and then filled by the same path an existing batch
            // takes, so the ledger row is written the same way either way. No
            // `id` on the record: `++id` is an INBOUND auto-increment key.
            const record = {
              storeId: store.id,
              medicineId: priceLine.medicine.id,
              batchNo: priceLine.line.batchNo,
              expiryDate: priceLine.expiryDate,
              mrpPerPack: priceLine.line.mrpPerPack,
              mrpPerUnit: D.toStr(priceLine.mrpPerUnit, 4),
              ptrPerUnit: D.toStr(priceLine.ptrPerUnit, 4),
              landedCostPerUnit: D.toStr(priceLine.landedCostPerUnit, 4),
              // FROZEN at purchase, for input credit. It is NOT the rate this
              // batch will sell at — that resolves by invoice date.
              purchaseGstPct: priceLine.line.gstRatePct,
              qtyOnHand: '0.000',
              isQuarantined: false,
            }
            const id = await db.batches.add(record as Batch)
            batch = { ...record, id }
          }

          const before = D.dec(batch.qtyOnHand)
          const after = D.add(before, priceLine.unitsReceived)
          batch = {
            ...batch,
            qtyOnHand: D.toStr(after, 3),
            landedCostPerUnit: D.toStr(
              blendLandedCost(
                { qty: before, costPerUnit: D.dec(batch.landedCostPerUnit) },
                { qty: priceLine.unitsReceived, costPerUnit: priceLine.landedCostPerUnit },
              ),
              4,
            ),
            // A pure-scheme line charges nothing and so carries no price to
            // retailer; writing its zero would erase what was actually paid.
            ptrPerUnit: D.gt(priceLine.ptrPerUnit, D.ZERO)
              ? D.toStr(priceLine.ptrPerUnit, 4)
              : batch.ptrPerUnit,
            purchaseGstPct: priceLine.line.gstRatePct,
          }
          // Two lines can land on ONE batch — the same lot billed at two rates
          // happens — so the running balance comes off the map, not off disk.
          byIdentity.set(identity, batch)
          touched.set(batch.id, batch)

          ledgerRows.push({
            storeId: store.id,
            batchId: batch.id,
            medicineId: batch.medicineId,
            at,
            qtyDelta: D.toStr(priceLine.unitsReceived, 3),
            balanceAfter: D.toStr(after, 3),
            reason: 'PURCHASE',
            refType: 'PURCHASE_INVOICE',
            refId: key,
            note: null,
          })
          lines.push({ ...priceLine.line, batchId: batch.id })
        }

        for (const b of touched.values()) await db.batches.put(b)
        for (const row of ledgerRows) await db.ledger.add(row)

        // Taken LAST, immediately before the write completes, so an abort above
        // never burns a number (invariant I18).
        const series = (await db.docSeries.get(seriesKey)) ?? {
          key: seriesKey,
          storeId: store.id,
          financialYear: fy,
          terminalId: 0,
          docType: 'PURCHASE' as const,
          prefix: 'GRN',
          nextNumber: 1,
        }
        const purchaseNo = `${series.prefix}${fy}-${String(series.nextNumber).padStart(5, '0')}`
        await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

        const body = { ...priced.invoice, purchaseNo, createdAt: at, lines }
        const id = await db.purchases.add(body as PurchaseInvoice)
        const saved: PurchaseInvoice = { ...body, id }
        await db.purchases.put(saved)
        await db.purchaseIdempotency.put({ key, purchaseId: id, at })

        // The bill is money owed from the moment the goods are on the shelf, and
        // it moves in the SAME transaction as the receipt: an outstanding
        // balance that can disagree with the documents behind it is worse than
        // no balance at all.
        const current = await db.suppliers.get(supplier.id)
        if (current) {
          await db.suppliers.put({
            ...current,
            outstanding: D.toStr(D.add(D.dec(current.outstanding), D.dec(saved.netAmount)), 2),
          })
        }
        return saved
      },
    )

    this.refresh([...touched.values()])
    return invoice
  }

  async listPurchases(q: { limit: number; cursor?: number }): Promise<{ rows: PurchaseInvoice[]; nextCursor: number | null }> {
    await this.init()
    const limit = Math.max(1, Math.min(Math.floor(q.limit), 200))
    const all = this.mine(await db.purchases.toArray()).sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id),
    )
    const start = q.cursor !== undefined && q.cursor > 0 ? Math.min(Math.floor(q.cursor), all.length) : 0
    const rows = all.slice(start, start + limit)
    const next = start + rows.length
    return { rows, nextCursor: next < all.length ? next : null }
  }

  /* --------------------------------------------------------- sale register ---
   *
   * The credit-note register is ONE JSON document in `meta`, the way the brand
   * profile is: it is read whole, rewritten whole, and nothing queries inside
   * it. A pharmacy issues a handful of credit notes a week, so the document
   * stays small, and the alternative — a `creditNotes` table — is a Dexie
   * version block, which is a change to the schema this one does not make.
   * Phase 4 gives credit notes a real table with a real `doc_series` row and
   * nothing above the adapter moves, which is the point of the contract.
   *
   * The DOCUMENT NUMBER is not in that blob. It comes from `docSeries`, the same
   * counter row a sale takes its number from, keyed on
   * (store, financial year, terminal, SALE_RETURN) — so credit notes are gapless
   * per series (invariant I18) even while the register itself is a mock.
   */

  private async saleReturnRegister(): Promise<SaleReturnRegister> {
    const row = await db.meta.get(SALE_RETURNS_META_KEY)
    return parseSaleReturns(row?.value)
  }

  async listCreditNotes(q: { invoiceId?: number; from?: IsoDate; to?: IsoDate }): Promise<CreditNote[]> {
    await this.init()
    const { notes } = await this.saleReturnRegister()
    /* This branch's notes. A credit note reduces the liability of the shop that
       issued it, so one branch's appearing in another's GST working would
       understate a return that has to be filed. */
    return this.mine(notes)
      .filter(
        (n) =>
          (q.invoiceId === undefined || n.invoiceId === q.invoiceId) &&
          (q.from === undefined || n.issuedOn >= q.from) &&
          (q.to === undefined || n.issuedOn <= q.to),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  }

  /**
   * The register, for one date range.
   *
   * Indexed on `invoiceDate`, so six months of history costs one range scan
   * rather than a full table read — the seed is ~8,500 bills and the default
   * view is a single day of them.
   */
  async listSales(filters: SalesFilters): Promise<SalesPage> {
    await this.init()
    const [invoices, register] = await Promise.all([
      db.invoices.where('invoiceDate').between(filters.from, filters.to, true, true).toArray()
        .then((r) => this.mine(r)),
      this.saleReturnRegister(),
    ])
    return buildSalesPage({ invoices, creditNotes: register.notes }, filters)
  }

  /**
   * A return, as a document.
   *
   * The order inside the transaction is the same one `postSale` uses and for the
   * same reasons: replay first (an outbox retry must get the original note back,
   * not a second one), then price against what is actually on disk, then move
   * stock, and take the document number LAST so an abort never burns one.
   */
  async postSaleReturn(input: SaleReturnInput): Promise<CreditNote> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const at = now.toISOString()
    const fy = financialYear(now, store.financialYearStartMonth)
    const seriesKey = `${store.id}:${fy}:${input.terminalId}:SALE_RETURN`
    const touched = new Map<number, Batch>()

    const note = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.invoices, db.docSeries, db.meta],
      async () => {
        const register = await this.saleReturnRegister()
        const replayId = register.keys[input.idempotencyKey]
        if (replayId !== undefined) {
          const original = register.notes.find((n) => n.id === replayId)
          if (original) return original
        }

        const invoice = await db.invoices.get(input.invoiceId)
        if (!invoice) {
          throw new ApiError({ code: 'NOT_FOUND', message: `Invoice ${input.invoiceId} not found` })
        }
        // The paperwork check before the arithmetic: a credit note without a
        // reason is indistinguishable from a till lift six months later.
        const reason = requireReturnReason(input.reason ?? '')

        /* A CASH refund out of a counted drawer is refused, for the same reason
           a void into a closed day is: the recorded variance was computed
           against a cash position this would change, and it would go on being
           displayed as if it still reconciled.
           Only cash. A card or UPI reversal never touches the drawer, and a
           credit adjustment moves the customer's balance rather than the till —
           blocking those would stop a shop taking goods back for no gain. The
           note is issued TODAY, so it is today's close that matters, not the
           original bill's. */
        const issuedOn = isoDate(now)
        if (input.refundMode === 'CASH') {
          const closed = await db.meta.get(dayCloseKey(issuedOn, input.terminalId))
          if (closed !== undefined) {
            throw new ApiError({
              code: 'DAY_ALREADY_CLOSED',
              message: `The drawer has been counted for ${issuedOn}. Refund this by card, UPI or to the customer's account, or issue the cash credit note tomorrow`,
              details: { date: issuedOn },
            })
          }
        }
        const against = register.notes.filter((n) => n.invoiceId === invoice.id)
        const priced = priceSaleReturn(invoice, against, { ...input, reason }, {
          storeId: store.id,
          operatorName: OPERATOR_NAME,
          issuedOn,
          createdAt: at,
        })

        // Sorted and deduplicated before the first read, exactly as `postSale`
        // acquires them: unsorted acquisition is what deadlocks a multi-line
        // document once this is real SQL.
        const batchIds = [...new Set(priced.movements.map((m) => m.batchId))].sort((a, b) => a - b)
        const batches = new Map<number, Batch>()
        for (const id of batchIds) {
          const b = await db.batches.get(id)
          if (!b) throw new ApiError({ code: 'BATCH_MISSING', message: `Batch ${id} vanished` })
          batches.set(id, b)
        }

        // IN ORDER. A DESTROY line is a receipt followed by a write-off, and the
        // running balance only reads correctly if they land in that sequence.
        /* Staged rather than written, for the same reason as `postSale`: the
           credit-note number is allocated further down (last, so an abort never
           burns one) and a ledger row carrying an idempotency key instead of a
           document number cannot be traced back to anything by a human. */
        const returnLedger: StockLedgerRow[] = []
        for (const move of priced.movements) {
          const batch = batches.get(move.batchId)
          if (!batch) continue
          const after = D.add(D.dec(batch.qtyOnHand), D.dec(move.qtyDelta))
          batch.qtyOnHand = D.toStr(after, 3)
          batches.set(batch.id, batch)
          returnLedger.push({
            storeId: store.id,
            batchId: batch.id,
            medicineId: move.medicineId,
            at,
            qtyDelta: D.toStr(D.dec(move.qtyDelta), 3),
            balanceAfter: D.toStr(after, 3),
            reason: move.reason,
            refType: 'CREDIT_NOTE',
            refId: '',
            note: move.note,
          })
        }

        for (const id of priced.quarantineBatchIds) {
          const batch = batches.get(id)
          // Re-asserting a quarantine that is already in force is not a change;
          // `setBatchQuarantined` writes a zero-delta ledger row for the same
          // reason, and doing it twice would say the batch was blocked twice.
          if (batch && !batch.isQuarantined) batches.set(id, { ...batch, isQuarantined: true })
        }

        const series = (await db.docSeries.get(seriesKey)) ?? {
          key: seriesKey,
          storeId: store.id,
          financialYear: fy,
          terminalId: input.terminalId,
          docType: 'SALE_RETURN' as const,
          prefix: `${store.invoicePrefix}CN`,
          nextNumber: 1,
        }
        const creditNoteNo = `${series.prefix}${fy}-T${input.terminalId}-${String(series.nextNumber).padStart(5, '0')}`
        await db.docSeries.put({ ...series, nextNumber: series.nextNumber + 1 })

        const id = register.notes.reduce((max, n) => Math.max(max, n.id), 0) + 1
        for (const row of returnLedger) await db.ledger.add({ ...row, refId: creditNoteNo })

        const saved: CreditNote = { ...priced.note, id, creditNoteNo }

        for (const b of batches.values()) {
          await db.batches.put(b)
          touched.set(b.id, b)
        }
        await db.meta.put({
          key: SALE_RETURNS_META_KEY,
          value: JSON.stringify({
            notes: [...register.notes, saved],
            keys: { ...register.keys, [input.idempotencyKey]: id },
          } satisfies SaleReturnRegister),
        })
        return saved
      },
    )

    this.refresh([...touched.values()])
    return note
  }

  /**
   * Cancel a bill IN PLACE.
   *
   * The document is never deleted and never renumbered — it stays in the
   * register carrying its reason, because the series has to account for the
   * number it consumed (GSTR-1 reports each series as total, cancelled, net)
   * and because a bill that simply disappears is what concealment looks like.
   * `checkVoidable` decides whether it may happen at all.
   */
  async voidSale(id: number, reason: string): Promise<SaleInvoice> {
    await this.init()
    const store = this.requireStore()
    const now = this.opts.now()
    const at = now.toISOString()
    const touched = new Map<number, Batch>()

    const voided = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.invoices, db.meta, db.customers],
      async () => {
      const invoice = await db.invoices.get(id)
      if (!invoice) throw new ApiError({ code: 'NOT_FOUND', message: `Invoice ${id} not found` })
      const { notes } = await this.saleReturnRegister()
      /* Read before the transaction's writes, so a bill whose day has been
         counted is refused rather than half-reversed. */
      const closed = await db.meta.get(dayCloseKey(invoice.invoiceDate, invoice.terminalId))
      const trimmed = checkVoidable(
        invoice,
        notes.filter((n) => n.invoiceId === id),
        isoDate(now),
        reason,
        closed !== undefined,
      )

      const movements = voidMovements(invoice)
      const batchIds = [...new Set(movements.map((m) => m.batchId))].sort((a, b) => a - b)
      const batches = new Map<number, Batch>()
      for (const batchId of batchIds) {
        const b = await db.batches.get(batchId)
        if (!b) throw new ApiError({ code: 'BATCH_MISSING', message: `Batch ${batchId} vanished` })
        batches.set(batchId, b)
      }
      for (const move of movements) {
        const batch = batches.get(move.batchId)
        if (!batch) continue
        const after = D.add(D.dec(batch.qtyOnHand), D.dec(move.qtyDelta))
        batch.qtyOnHand = D.toStr(after, 3)
        batches.set(batch.id, batch)
        await db.ledger.add({
          storeId: store.id,
          batchId: batch.id,
          medicineId: move.medicineId,
          at,
          qtyDelta: D.toStr(D.dec(move.qtyDelta), 3),
          balanceAfter: D.toStr(after, 3),
          reason: move.reason,
          refType: 'SALE_VOID',
          refId: invoice.invoiceNo,
          note: trimmed,
        })
      }

      /* Give the khata money back.
         Stock returning to the shelf is only half of a cancelled credit sale:
         the other half is the customer's balance, which `postSale` raised when
         the bill was taken. Leaving it raised bills them for a document that no
         longer exists — and because `receivableOf` skips a VOIDED bill, the
         balance would not even age; it would surface as `carried`, the note
         that means "brought in from your previous software". So the operator
         would be told to chase money for a bill they themselves cancelled, with
         nothing on the screen to trace it back to. Reversed HERE, inside the
         same transaction as the status flip, for the reason the forward posting
         gives: a balance corrected afterwards can be lost to an abort while the
         void survives. */
      const credit = creditTaken(invoice)
      if (invoice.customerId !== null && D.gt(credit, D.ZERO)) {
        const customer = await db.customers.get(invoice.customerId)
        if (customer) {
          await db.customers.put({
            ...customer,
            /* Clamped at zero. A receipt settling the bill before it was voided
               has already taken this money off the balance, and subtracting it
               a second time would turn a paid-and-cancelled bill into an advance
               the shop does not owe. */
            outstanding: D.toStr(
              D.max(D.ZERO, D.sub(D.dec(customer.outstanding), credit)),
              2,
            ),
          })
        }
      }

      const next: SaleInvoice = { ...invoice, status: 'VOIDED', voidReason: trimmed, voidedAt: at }
      for (const b of batches.values()) {
        await db.batches.put(b)
        touched.set(b.id, b)
      }
      await db.invoices.put(next)
      return next
      },
    )

    this.refresh([...touched.values()])
    return voided
  }

  /**
   * The blind cash count.
   *
   * This is the ONLY method that returns the expected cash, and it returns it
   * only in exchange for a count. There is deliberately no `expectedCash(date)`
   * to call first: an operator who can read the figure before counting will
   * find exactly that figure in the drawer every evening, and the evening a
   * till is genuinely short is the one nobody hears about.
   *
   * A closed day is not re-closable. Allowing a second close would let a
   * variance be replaced once it was known, which is the whole control gone.
   */
  async closeDay(input: DayCloseInput): Promise<DayClose> {
    await this.init()
    const existing = await this.getDayClose(input.date, input.terminalId)
    if (existing) {
      throw new ApiError({
        code: 'DAY_ALREADY_CLOSED',
        message: `${input.date} was closed at ${existing.closedAt.slice(11, 16)} by ${existing.operatorName}`,
        details: existing,
      })
    }

    const [invoices, register] = await Promise.all([
      db.invoices.where('invoiceDate').equals(input.date).toArray().then((r) => this.mine(r)),
      this.saleReturnRegister(),
    ])
    const close = computeDayClose(input, {
      invoices: invoices.filter((i) => i.terminalId === input.terminalId),
      creditNotes: register.notes.filter(
        (n) => n.issuedOn === input.date && n.terminalId === input.terminalId,
      ),
      operatorName: OPERATOR_NAME,
      closedAt: this.opts.now().toISOString(),
    })
    await db.meta.put({ key: dayCloseKey(input.date, input.terminalId), value: JSON.stringify(close) })
    return close
  }

  async getDayClose(date: IsoDate, terminalId: number): Promise<DayClose | null> {
    const row = await db.meta.get(dayCloseKey(date, terminalId))
    if (!row) return null
    try {
      const parsed: unknown = JSON.parse(row.value)
      return typeof parsed === 'object' && parsed !== null ? (parsed as DayClose) : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------- users and the trail ---

  /** The roster, seeded on first read the way the prescriber master is. */
  private async loadUsers(): Promise<User[]> {
    const stored = readJsonRows<User>((await db.meta.get(USERS_META_KEY))?.value)
    if (stored) return stored
    const seeded = DEMO_USERS.map((u) => ({ ...u, limits: { ...u.limits } }))
    await db.meta.put({ key: USERS_META_KEY, value: JSON.stringify(seeded) })
    return seeded
  }

  private async saveUsers(users: readonly User[]): Promise<void> {
    await db.meta.put({ key: USERS_META_KEY, value: JSON.stringify(users) })
  }

  /**
   * The audit trail, seeded on first read and APPENDED to for ever after.
   *
   * `buildDemoAudit` builds its timestamps relative to now, and its own comment
   * explains why: the date filter needs something to bite on whenever the demo
   * is opened. Persisting the result on first read froze that at whatever day
   * the browser profile happened to be created, so a week later "Today" was
   * empty and the newest entry was seven days old — the exact failure the
   * relative timestamps exist to prevent.
   *
   * So the demo rows are rebuilt while they are STILL ONLY DEMO ROWS. The test
   * is exact rather than a guess: `writeAudit` only ever grows the array, so a
   * stored length equal to a freshly built demo is proof that nothing real has
   * been appended. The moment the operator does anything at all, the log is
   * theirs, it is append-only, and it is never rewritten again — which is the
   * property the trail exists to have.
   */
  private async loadAudit(): Promise<AuditEntry[]> {
    const now = this.opts.now()
    const stored = readJsonRows<AuditEntry>((await db.meta.get(AUDIT_META_KEY))?.value)
    const fresh = buildDemoAudit(now)

    if (stored) {
      const untouched = stored.length === fresh.length
      const newest = stored.reduce((max, r) => (r.at > max ? r.at : max), '')
      if (!untouched || newest.slice(0, 10) === now.toISOString().slice(0, 10)) return stored
    }

    await db.meta.put({ key: AUDIT_META_KEY, value: JSON.stringify(fresh) })
    return fresh
  }

  /** Who is doing it, snapshotted — a later rename must not rewrite history. */
  private async actor(): Promise<Pick<AuditEntry, 'actorId' | 'actorName' | 'actorRole'>> {
    const me = await this.currentUser()
    return { actorId: me.id, actorName: me.name, actorRole: me.role }
  }

  /** Appended, never edited. The id is monotonic so the sort has a tie-break. */
  private async writeAudit(entry: Omit<AuditEntry, 'id' | 'storeId' | 'at'>): Promise<void> {
    const rows = await this.loadAudit()
    const id = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
    const store = await this.getStore()
    rows.push({ id, storeId: store.id, at: this.opts.now().toISOString(), ...entry })
    await db.meta.put({ key: AUDIT_META_KEY, value: JSON.stringify(rows) })
  }

  /**
   * Who is signed in.
   *
   * Phase 1 has no session, so this is the seeded owner. It is a real call
   * rather than a constant in the UI because every override check needs a
   * REQUESTER, and the rule that an approver is never the requester (invariant
   * I22) is only testable against an identity the screen did not choose for
   * itself. Falls through to any live admin, then to anyone at all: a shop
   * locked out of its own roster by a bad edit needs a way back in.
   */
  async currentUser(): Promise<User> {
    await this.init()
    const users = await this.loadUsers()
    const me = users.find((u) => u.id === DEMO_CURRENT_USER_ID && u.isActive)
      ?? users.find((u) => u.role === 'admin' && u.isActive)
      ?? users.find((u) => u.isActive)
    if (!me) {
      throw new ApiError({
        code: 'NO_ACTIVE_USER',
        message: 'Every account on this store is disabled.',
      })
    }
    return me
  }

  /**
   * The roster in a STABLE order: authority first, then name.
   *
   * Deliberately not active-first. Disabling somebody would then teleport their
   * row to the bottom of the list at the moment the operator is still looking
   * at it, and the next click would land on whoever moved up.
   */
  async listUsers(): Promise<User[]> {
    await this.init()
    const users = await this.loadUsers()
    return [...users].sort(
      (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)
        || a.name.localeCompare(b.name)
        || a.id - b.id,
    )
  }

  async createUser(input: UserInput): Promise<User> {
    await this.init()
    const users = await this.loadUsers()
    const fields = prepareUser(input, users)
    const store = await this.getStore()
    const id = users.reduce((max, u) => Math.max(max, u.id), 0) + 1
    const user: User = { id, storeId: store.id, lastActiveAt: null, ...fields }

    await this.saveUsers([...users, user])
    await this.writeAudit({
      ...(await this.actor()),
      action: 'USER_CREATED',
      entity: 'User',
      entityRef: user.username,
      summary: `${user.name} added as ${ROLE_LABEL[user.role].toLowerCase()}`,
      changes: creationChanges(user),
      terminalId: null,
      amount: null,
      override: null,
    })
    return user
  }

  async updateUser(id: number, input: Partial<UserInput>): Promise<User> {
    await this.init()
    const users = await this.loadUsers()
    const before = users.find((u) => u.id === id)
    if (!before) throw new ApiError({ code: 'NOT_FOUND', message: `User ${id} not found` })

    // Every OTHER user: the uniqueness and last-admin checks then read the same
    // on an edit as on a create, with no "unless it is me" special case.
    const after = applyUserUpdate(before, input, users.filter((u) => u.id !== id))
    await this.saveUsers(users.map((u) => (u.id === id ? after : u)))

    const changes = diffUsers(before, after)
    // Nothing moved, nothing recorded. A trail padded with "saved, no change"
    // is a trail people stop scrolling, and then stop reading.
    if (changes.length > 0) {
      const disabled = before.isActive && !after.isActive
      await this.writeAudit({
        ...(await this.actor()),
        action: disabled ? 'USER_DEACTIVATED' : 'USER_UPDATED',
        entity: 'User',
        entityRef: after.username,
        summary: disabled
          ? `${after.name}’s account disabled`
          : `${after.name}: ${changes.map((c) => c.field.toLowerCase()).join(', ')}`,
        changes,
        terminalId: null,
        amount: null,
        override: null,
      })
    }
    return after
  }

  async setUserActive(id: number, isActive: boolean): Promise<User> {
    return this.updateUser(id, { isActive })
  }

  async listAudit(filters: AuditFilters): Promise<AuditPage> {
    await this.init()
    return filterAudit(await this.loadAudit(), filters)
  }

  /* ----------------------------------------------------------- reporting ---
   *
   * ONE method for every report, deliberately.
   *
   * What differs between them is which tables have to be READ, and that is a
   * storage decision rather than a value one — so `reportInputs` declares it and
   * `api/reports` decides what the rows mean. A day book that pulled four months
   * of invoices to render one day would be the query that only hurts once the
   * shop has history; ageing cannot be answered from a window at all, so those
   * two ask for everything up to the as-on date and nothing else does.
   */
  async runReport(query: ReportQuery): Promise<ReportResult> {
    await this.init()
    const store = this.requireStore()
    const range = normaliseRange(query, this.today())
    const needs = reportInputs(query.reportId)

    const [invoices, purchases, creditNotes, customers, suppliers] = await Promise.all([
      needs.sales === 'none'
        ? Promise.resolve([])
        : needs.sales === 'range'
          ? db.invoices.where('invoiceDate').between(range.from, range.to, true, true).toArray()
            .then((r) => this.mine(r))
          // Ageing walks a balance back over the documents behind it, so it
          // needs history up to the as-on date — not the reporting window.
          : db.invoices.where('invoiceDate').belowOrEqual(range.to).toArray()
            .then((r) => this.mine(r)),
      needs.purchases === 'none'
        ? Promise.resolve([])
        : needs.purchases === 'range'
          ? db.purchases.where('invoiceDate').between(range.from, range.to, true, true).toArray()
            .then((r) => this.mine(r))
          : db.purchases.where('invoiceDate').belowOrEqual(range.to).toArray()
            .then((r) => this.mine(r)),
      needs.creditNotes ? this.listCreditNotes({ from: range.from, to: range.to }) : Promise.resolve([]),
      // Both masters are read whole and are hundreds of rows at most; the
      // outstanding reports have to list a party with a balance and no document.
      db.customers.toArray(),
      db.suppliers.toArray(),
    ])

    return buildReport({
      query: { ...query, from: range.from, to: range.to },
      invoices,
      creditNotes,
      purchases,
      batches: needs.stock ? [...this.index.allBatches().values()].flat() : [],
      /* Read whole or not at all. A running balance folds its opening figure
         from everything before the window, so a windowed ledger read would give
         a register that starts from nowhere — and the report that asks for this
         is the only one that does. */
      movements: needs.movements === 'history' ? await this.allMovements() : [],
      medicineFor: (id) => this.catalogue.get(id),
      customers,
      suppliers,
      store,
      /* The RESELLER's product name, not ours. Every caveat a report prints
         about what the software cannot do goes onto a screen and into a CSV that
         a reseller's customer hands to their accountant. */
      productName: (await this.getBrand()).productName,
      today: this.today(),
      generatedAt: this.opts.now().toISOString(),
    })
  }
}
