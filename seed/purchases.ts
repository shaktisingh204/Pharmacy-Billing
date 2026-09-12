import type {
  Batch, Medicine, PurchaseInvoice, PurchaseLineInput, Supplier,
} from '../contract/types'
import * as D from '../web/src/domain/decimal'
import { pricePurchase } from '../web/src/api/purchases'

/**
 * The goods receipts the shelf implies.
 *
 * Every batch in the demo arrived on a bill from somebody, and until this
 * existed none of them had one: the register was empty on a fresh profile, the
 * suppliers carried authored balances no document explained, and a debit note —
 * which by rule has to name the bill it reduces — could not be raised at all.
 *
 * Two properties make the result honest rather than decorative:
 *
 *  1. IT IS PRICED BY `pricePurchase`, the same engine the goods-receipt screen
 *     uses. Hand-written totals would agree with themselves and with nothing
 *     else, and the first report to cross-foot them would disagree.
 *
 *  2. `amountPaid` IS DERIVED so the unpaid remainder lands on the balance the
 *     supplier master already carries. The supplier-outstanding report exists to
 *     show a balance against the documents behind it, and a demo where those two
 *     disagree teaches the reader to distrust the report.
 *
 * Deterministic throughout — no clock, no randomness — so two browser profiles
 * seeded on the same day hold the same books.
 */

export interface GeneratedPurchases {
  invoices: PurchaseInvoice[]
  /** Keyed by supplier id: what their bills actually leave unpaid. */
  outstandingBySupplier: Map<number, string>
}

/** Lines per bill. A distributor's invoice is a page, not one item. */
const LINES_PER_BILL = 9
/** Bills per supplier. Enough to age across the buckets, not enough to bloat. */
const BILLS_PER_SUPPLIER = 3

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const addDays = (d: Date, days: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)

export function generatePurchases(opts: {
  medicines: Medicine[]
  batches: Batch[]
  suppliers: Supplier[]
  storeId: number
  storeStateCode: string
  today: Date
  /** e.g. '2627'. The series is per financial year, like every other document. */
  financialYear: string
}): GeneratedPurchases {
  const { medicines, batches, suppliers, storeId, storeStateCode, today, financialYear } = opts
  if (suppliers.length === 0) return { invoices: [], outstandingBySupplier: new Map() }

  const byId = new Map(medicines.map((m) => [m.id, m]))

  /* Each batch belongs to ONE supplier, chosen by its own id so the assignment
     is stable across seeds and a medicine does not appear to have been bought
     from everybody at once. */
  const perSupplier = new Map<number, Batch[]>()
  for (const batch of batches) {
    const supplier = suppliers[batch.id % suppliers.length]
    if (!supplier) continue
    const list = perSupplier.get(supplier.id) ?? []
    list.push(batch)
    perSupplier.set(supplier.id, list)
  }

  const invoices: PurchaseInvoice[] = []
  const outstandingBySupplier = new Map<number, string>()
  let id = 0
  let serial = 0

  for (const supplier of suppliers) {
    const mine = (perSupplier.get(supplier.id) ?? []).slice(0, LINES_PER_BILL * BILLS_PER_SUPPLIER)
    if (mine.length === 0) {
      outstandingBySupplier.set(supplier.id, '0.00')
      continue
    }

    const bills: PurchaseInvoice[] = []
    for (let start = 0; start < mine.length; start += LINES_PER_BILL) {
      const slice = mine.slice(start, start + LINES_PER_BILL)
      serial += 1
      /* Spread backwards from today so the supplier report's ageing buckets have
         something in every band rather than all of it in one. */
      const invoiceDate = iso(addDays(today, -(7 + serial * 11)))

      const lines: PurchaseLineInput[] = slice.flatMap((batch, i) => {
        const medicine = byId.get(batch.medicineId)
        if (!medicine) return []
        /* Per PACK and GST-EXCLUSIVE, which is the purchase side's convention
           and the opposite of the counter's. */
        const ratePerPack = D.mul(D.dec(batch.ptrPerUnit), D.dec(String(medicine.unitsPerPack)))
        return [{
          lineId: `l${i + 1}`,
          medicineId: medicine.id,
          batchNo: batch.batchNo,
          expiry: `${batch.expiryDate.slice(5, 7)}/${batch.expiryDate.slice(2, 4)}`,
          qtyPacks: String(4 + (batch.id % 7)),
          // A 10+1 scheme on roughly every sixth line, so the landed-cost
          // denominator (paid + free) is exercised by real seeded data.
          freePacks: batch.id % 6 === 0 ? '1' : '0',
          mrpPerPack: batch.mrpPerPack,
          ratePerPack: D.toStr(ratePerPack, 2),
          discountPct: '0',
          gstRatePct: batch.purchaseGstPct,
        }]
      })
      if (lines.length === 0) continue

      const priced = pricePurchase(
        {
          idempotencyKey: `seed-purchase-${serial}`,
          supplierId: supplier.id,
          supplierInvoiceNo: `${supplier.name.slice(0, 3).toUpperCase()}/${String(serial).padStart(4, '0')}`,
          invoiceDate,
          lines,
        },
        {
          storeId,
          storeStateCode,
          roundOffEnabled: true,
          supplier,
          medicineFor: (mid) => byId.get(mid),
          // A seeded book has no earlier purchase to compare against, so nothing
          // is flagged as a rate change. Inventing one would put a warning chip
          // on a bill with no history behind it.
          lastRatePerPack: () => null,
          createdAt: new Date(`${invoiceDate}T10:30:00.000Z`).toISOString(),
        },
      )

      id += 1
      bills.push({
        ...priced.invoice,
        id,
        // The SAME shape `postPurchase` allocates — `GRN<fy>-00001`. A seeded
        // document numbered differently from a real one reads as two systems.
        purchaseNo: `GRN${financialYear}-${String(serial).padStart(5, '0')}`,
        // Filled in below, once the supplier's whole run is known.
        amountPaid: '0.00',
      })
    }

    /* Settle the OLDEST bills first and leave the newest unpaid, so what remains
       matches the balance on the master. Paying newest-first would leave the
       ageing showing money overdue that the shop had in fact already settled. */
    let toLeave = D.dec(supplier.outstanding)
    const settled: PurchaseInvoice[] = []
    for (const bill of [...bills].reverse()) {
      const net = D.dec(bill.netAmount)
      const unpaid = D.min(net, D.max(D.ZERO, toLeave))
      toLeave = D.sub(toLeave, unpaid)
      settled.push({ ...bill, amountPaid: D.toStr(D.sub(net, unpaid), 2) })
    }
    settled.reverse()
    invoices.push(...settled)

    /* What the bills can actually account for. If the authored balance exceeds
       every bill on file, the remainder is simply not claimed here — the report
       shows it as unmatched, which is the truth and is exactly the case that
       report was built to surface. */
    const covered = D.sub(D.dec(supplier.outstanding), D.max(D.ZERO, toLeave))
    outstandingBySupplier.set(supplier.id, D.toStr(covered, 2))
  }

  return { invoices, outstandingBySupplier }
}
