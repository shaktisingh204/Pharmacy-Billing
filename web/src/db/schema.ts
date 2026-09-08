import Dexie, { type Table } from 'dexie'
import type {
  Batch, Customer, HeldBill, Medicine, SaleInvoice, StoreProfile,
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

export type LedgerReason =
  | 'OPENING' | 'PURCHASE' | 'SALE' | 'SALE_RETURN'
  | 'PURCHASE_RETURN' | 'ADJUSTMENT' | 'EXPIRY_WRITEOFF'

/**
 * Append-only. Never updated, never deleted — a correction is another row.
 * `balanceAfter` makes the ledger self-checking: it must reconcile to
 * batches.qtyOnHand, and Phase 8 surfaces that reconciliation in the UI.
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
  docType: 'SALE' | 'SALE_RETURN' | 'PURCHASE'
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

export class RxDatabase extends Dexie {
  stores!: Table<StoreProfile, number>
  medicines!: Table<Medicine, number>
  barcodes!: Table<BarcodeRow, number>
  batches!: Table<Batch, number>
  customers!: Table<Customer, number>
  invoices!: Table<SaleInvoice, number>
  ledger!: Table<StockLedgerRow, number>
  docSeries!: Table<DocSeriesRow, string>
  heldBills!: Table<HeldBill, number>
  shortbook!: Table<ShortbookRow, number>
  taxRates!: Table<TaxRateRow, number>
  idempotency!: Table<IdempotencyRow, string>
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
  }
}

export const db = new RxDatabase()
