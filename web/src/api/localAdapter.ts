import type {
  ApiAdapter, Batch, Customer, HeldBill, Medicine, MedicineSearchHit, PostSaleRequest,
  Qty, Quote, QuoteRequest, SaleInvoice, StoreProfile,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { computeQuote } from '@/domain/quote'
import type { QuoteContext } from '@/domain/quote'
import { db } from '@/db/schema'
import type { StockLedgerRow } from '@/db/schema'
import { SearchIndex } from './searchIndex'

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

/** '08901234567893' <-> '8901234567893' <-> '901234567893' (GTIN-14/13/12). */
function gtinForms(code: string): string[] {
  const trimmed = code.trim()
  const forms = new Set([trimmed])
  if (/^\d{12,14}$/.test(trimmed)) {
    forms.add(trimmed.replace(/^0+/, ''))
    forms.add(trimmed.padStart(14, '0'))
    forms.add(trimmed.replace(/^0+/, '').padStart(13, '0'))
  }
  return [...forms]
}

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** India runs April-March. FY 2026-27 is written "2627" in a document number. */
function financialYear(d: Date, startMonth: number): string {
  const y = d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`
}

export class LocalAdapter implements ApiAdapter {
  private index = new SearchIndex()
  private store: StoreProfile | null = null
  private ready: Promise<void> | null = null

  // A parameter property would be neater, but `erasableSyntaxOnly` forbids it.
  private readonly opts: LocalAdapterOptions

  constructor(opts: LocalAdapterOptions) {
    this.opts = opts
  }

  /** Warms the in-memory index. Every public method awaits it. */
  async init(): Promise<void> {
    this.ready ??= (async () => {
      const [store, medicines, batches, barcodes] = await Promise.all([
        db.stores.get(1),
        db.medicines.toArray(),
        db.batches.toArray(),
        db.barcodes.toArray(),
      ])
      if (!store) throw new ApiError({ code: 'NOT_SEEDED', message: 'Store not seeded' })
      this.store = store
      this.index.load(medicines, batches, new Map(barcodes.map((b) => [b.barcode, b.medicineId])))
    })()
    return this.ready
  }

  /** Called after any write that changes stock, so search reflects reality. */
  private async refresh(): Promise<void> {
    this.ready = null
    await this.init()
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
    const all = this.index.medicines()
    return ids.flatMap((id) => {
      const m = all.get(id)
      return m ? [m] : []
    })
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

    const invoice = await db.transaction(
      'rw',
      [db.batches, db.ledger, db.invoices, db.docSeries, db.idempotency],
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

        const record: SaleInvoice = {
          id: 0,
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
          operatorName: 'Counter 1',
        }

        for (const b of batches.values()) await db.batches.put(b)
        for (const row of ledgerRows) await db.ledger.add(row)
        const id = await db.invoices.add(record)
        const saved = { ...record, id }
        await db.invoices.put(saved)
        await db.idempotency.put({ key: req.idempotencyKey, invoiceId: id, at: now.toISOString() })
        return saved
      },
    )

    await this.refresh()
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
}
