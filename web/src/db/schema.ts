import Dexie, { type Table } from 'dexie'
import type {
  Batch, Customer, Doctor, HeldBill, LedgerReason, Medicine, PurchaseInvoice, SaleInvoice,
  StoreProfile, Supplier,
} from '@contract'

/**
 * Local persistence.
 *
 * Phase 1-3 this IS the backend: `localAdapter` implements the contract on top of
 * it so every screen can be built and demoed against realistic data. Phase 7 it
 * becomes the offline mirror and outbox behind the real server, which is why it
 * models documents the way the server will rather than the way a mock would.
 */

export interface BarcodeRow {
  id?: number
  medicineId: number
  barcode: string
  symbology: string
}

/*
 * The contract's list, re-exported rather than restated.
 *
 * This was a second hand-written union and it had already drifted: TRANSFER was
 * missing, so a reason the contract allows could not be stored. One definition
 * means the gap cannot reopen.
 */
export type { LedgerReason }

/**
 * Append-only. Never updated, never deleted — a correction is another row.
 * `balanceAfter` makes the ledger self-checking: it must reconcile to
 * batches.qtyOnHand, and `inventorySummary` counts every batch where it does not
 * (invariant I17).
 */
export interface StockLedgerRow {
  id?: number
  storeId: number
  batchId: number
  medicineId: number
  at: string
  qtyDelta: string
  balanceAfter: string
  reason: LedgerReason
  refType: string
  refId: string
  /**
   * Why, in the operator's words. Mandatory on a manual adjustment, null on a
   * document-driven movement where the document itself is the explanation — an
   * unexplained correction is indistinguishable from shrinkage.
   */
  note?: string | null
}

/**
 * The invoice counter is a ROW, not a sequence.
 *
 * A sequence is deliberately non-transactional, so a rolled-back sale burns a
 * number permanently and the series develops a gap that only surfaces in an audit.
 * Keyed per (store, financial year, terminal) because each terminal must be able to
 * number offline without colliding.
 */
export interface DocSeriesRow {
  key: string
  storeId: number
  financialYear: string
  terminalId: number
  /* Each document type owns its own gapless series. A debit note and an expiry
     claim are separate types precisely because they are separate documents to a
     tax officer, so sharing a series would produce a numbering nobody could
     explain. */
  docType: 'SALE' | 'SALE_RETURN' | 'PURCHASE' | 'PURCHASE_RETURN' | 'EXPIRY_CLAIM' | 'PURCHASE_ORDER' | 'TRANSFER'
  prefix: string
  nextNumber: number
}

export interface ShortbookRow {
  id?: number
  storeId: number
  medicineId: number | null
  term: string
  qty: string
  at: string
}

export interface TaxRateRow {
  id?: number
  hsnCode: string
  effectiveFrom: string
  effectiveTo: string | null
  ratePct: string
  notificationRef: string
}

/** Caches a posted sale's response so replaying a key returns it byte-identically. */
export interface IdempotencyRow {
  key: string
  invoiceId: number
  at: string
}

/**
 * The same guarantee for a goods receipt, in its OWN table.
 *
 * Sharing `idempotency` would mean one column holding either a sale id or a
 * purchase id depending on who wrote it, and the first replay that read the
 * wrong one would hand back a sales invoice as a purchase. Two tables cost
 * nothing and cannot be confused.
 */
export interface PurchaseIdempotencyRow {
  key: string
  purchaseId: number
  at: string
}

/**
 * Where the white-label profile lives.
 *
 * Branding is DATA, so it is one JSON document in `meta` rather than a table:
 * there is exactly one of it per installation, it is read whole at boot and
 * rewritten whole, and nothing ever queries inside it. A `brand` table would buy
 * indexes on fields nobody filters by, and a schema version block that adds
 * neither a store nor an index only forces every existing local database through
 * a no-op upgrade — which is why no version block below mentions it.
 */
export const BRAND_META_KEY = 'brand'

export class RxDatabase extends Dexie {
  stores!: Table<StoreProfile, number>
  medicines!: Table<Medicine, number>
  barcodes!: Table<BarcodeRow, number>
  batches!: Table<Batch, number>
  customers!: Table<Customer, number>
  doctors!: Table<Doctor, number>
  invoices!: Table<SaleInvoice, number>
  ledger!: Table<StockLedgerRow, number>
  docSeries!: Table<DocSeriesRow, string>
  heldBills!: Table<HeldBill, number>
  shortbook!: Table<ShortbookRow, number>
  taxRates!: Table<TaxRateRow, number>
  idempotency!: Table<IdempotencyRow, string>
  suppliers!: Table<Supplier, number>
  purchases!: Table<PurchaseInvoice, number>
  purchaseIdempotency!: Table<PurchaseIdempotencyRow, string>
  meta!: Table<{ key: string; value: string }, string>

  constructor() {
    super('rxbill')
    this.version(1).stores({
      stores: 'id',
      medicines: '++id, storeId, brandName, saleRank, isActive, drugSchedule, [storeId+isActive]',
      barcodes: '++id, &barcode, medicineId',
      batches: '++id, medicineId, storeId, expiryDate, isQuarantined, [medicineId+expiryDate]',
      customers: '++id, storeId, phone, name',
      invoices: '++id, &invoiceNo, invoiceDate, customerId, status, terminalId',
      ledger: '++id, batchId, medicineId, at, reason',
      docSeries: 'key',
      heldBills: 'token, savedAt',
      shortbook: '++id, medicineId, at',
      taxRates: '++id, hsnCode',
      idempotency: 'key',
      meta: 'key',
    })

    /*
     * A NEW version block, never an edit to version 1.
     *
     * Dexie replays upgrades from whatever version the browser already holds, so
     * rewriting v1 leaves every existing local database refusing to open —
     * including the ones with a day's unsynced bills in them. Tables the block
     * does not mention are carried forward untouched.
     *
     * `prescriptionCount` is indexed because it is the ORDER of the quick-pick
     * list, not a statistic: the prescriber a shop writes against forty times a
     * week must be the first name the operator sees.
     */
    this.version(2).stores({
      doctors: '++id, storeId, name, prescriptionCount',
    })

    /*
     * Purchasing. A new block again, never an edit to 1 or 2.
     *
     * There is deliberately NO index for the (supplier, supplier invoice number)
     * duplicate check. That check treats " inv-001 " and "INV-001" as the same
     * bill — which is the whole point of it, since a distributor's number is
     * retyped by a human — and no index can answer a case-insensitive question.
     * `findDuplicatePurchase` therefore compares normalised values over the
     * documents, and the Phase-5 UNIQUE constraint will have to be declared on a
     * normalised column for the same reason.
     *
     * `note` on the ledger needs no block of its own: Dexie versions INDEXES,
     * and a new unindexed field on a stored object is readable immediately.
     */
    this.version(3).stores({
      suppliers: '++id, storeId, name, phone, gstin',
      purchases: '++id, &purchaseNo, supplierId, invoiceDate, createdAt',
      purchaseIdempotency: 'key',
    })
  }
}

export const db = new RxDatabase()
