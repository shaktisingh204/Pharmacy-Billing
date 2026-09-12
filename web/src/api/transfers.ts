import type { Batch, IsoDate, Medicine, Money, Qty, StoreProfile } from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'

/**
 * Moving stock between branches, as pure value logic.
 *
 * The moment there are two shops this is the commonest thing a chain does, and
 * without it a branch that runs out orders from a distributor while the head
 * shop has two hundred on the shelf.
 *
 * THE GST RULE DECIDES THE DOCUMENT, and getting it backwards is the expensive
 * mistake here:
 *
 *  - TWO BRANCHES ON ONE GSTIN ARE ONE LEGAL PERSON. Moving stock between them
 *    is NOT a supply. It moves on a DELIVERY CHALLAN under Rule 55, with no tax
 *    charged and nothing to file. Raising a tax invoice instead would declare an
 *    outward supply that never happened and pay tax on the shop's own stock.
 *
 *  - TWO GSTINs ARE TWO PERSONS, even on the same PAN — a branch in another
 *    state is a distinct person under GST. That movement IS a supply and needs a
 *    real tax invoice with tax on it.
 *
 * Three more rules, each a way stock goes missing:
 *
 *  1. BATCH IDENTITY TRAVELS. The batch arriving is the same batch: medicine,
 *     batch number, expiry AND printed MRP. Creating a fresh batch at the
 *     destination breaks FEFO — the receiving shop would sell newer stock first
 *     — and a customer pays what is printed on the strip in their hand.
 *
 *  2. LANDED COST TRAVELS TOO. The receiving branch's margin has to be computed
 *     on what the CHAIN paid. A destination batch costed at anything else makes
 *     every margin report at that branch fiction.
 *
 *  3. BOTH SIDES OR NEITHER. One transaction. A decrement that commits without
 *     its matching increment is stock that has left one shop and arrived
 *     nowhere, and nothing in the app would ever notice.
 */

export type TransferDocument = 'CHALLAN' | 'TAX_INVOICE'

export interface TransferLineInput {
  lineId: string
  /** The batch leaving the source shelf. */
  batchId: number
  /** Base units. A branch legitimately asks for four strips, not four boxes. */
  qty: Qty
}

export interface TransferInput {
  idempotencyKey: string
  fromStoreId: number
  toStoreId: number
  issuedOn: IsoDate
  /** Mandatory. Stock leaving a building unexplained is what shrinkage is. */
  reason: string
  lines: TransferLineInput[]
}

export interface TransferLine {
  lineId: string
  batchId: number
  medicineId: number
  brandName: string
  packLabel: string
  batchNo: string
  expiryDate: IsoDate
  hsnCode: string
  qty: Qty
  /** Landed cost per unit, carried across so margin survives the move. */
  costPerUnit: Money
  mrpPerPack: Money
  /** qty × landed cost. The value of the movement, not a price. */
  lineValue: Money
}

export interface StockTransfer {
  id: number
  /** `TRF…` for a challan, the store's own series for a tax invoice. */
  documentNo: string
  document: TransferDocument
  fromStoreId: number
  fromStoreName: string
  toStoreId: number
  toStoreName: string
  issuedOn: IsoDate
  createdAt: string
  reason: string
  operatorName: string
  lines: TransferLine[]
  /** Total at landed cost. On a challan this is a declared value, not a price. */
  totalValue: Money
  /** Why this is a challan rather than an invoice, in words. Printed. */
  basis: string
  status: 'POSTED'
}

const invalid = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(details === undefined ? { code, message } : { code, message, details })

export const REASON_MIN = 6

const collapse = (v: string): string => (v ?? '').trim().replace(/\s+/g, ' ')

/**
 * Which document this movement needs.
 *
 * The whole question is whether the two branches are one legal person. A GSTIN
 * identifies a person, so identical GSTINs mean one person and no supply; two
 * GSTINs mean two persons and a real supply, even on the same PAN.
 *
 * A branch with NO GSTIN cannot be reasoned about and is treated as a distinct
 * person — the conservative direction: raising an invoice where a challan would
 * have done costs tax that can be reclaimed, while moving taxable goods on a
 * challan that should have been an invoice is an unreported supply.
 */
export function documentFor(from: StoreProfile, to: StoreProfile): TransferDocument {
  const a = from.gstin.trim().toUpperCase()
  const b = to.gstin.trim().toUpperCase()
  if (a === '' || b === '') return 'TAX_INVOICE'
  return a === b ? 'CHALLAN' : 'TAX_INVOICE'
}

export function basisFor(from: StoreProfile, to: StoreProfile): string {
  return documentFor(from, to) === 'CHALLAN'
    ? `Both branches are on GSTIN ${from.gstin}, so this is one legal person moving its own stock. Not a supply: it travels on a delivery challan and no tax is charged.`
    : `${from.name} and ${to.name} hold different GSTINs, so they are distinct persons under GST. This movement is a supply and needs a tax invoice with tax on it.`
}

export interface TransferContext {
  from: StoreProfile
  to: StoreProfile
  batchOf: (batchId: number) => Batch | undefined
  medicineOf: (medicineId: number) => Medicine | undefined
  operatorName: string
  createdAt: string
}

export type PricedTransfer = Omit<StockTransfer, 'id' | 'documentNo'>

export function priceTransfer(input: TransferInput, ctx: TransferContext): PricedTransfer {
  const reason = collapse(input.reason)
  if (reason.length < REASON_MIN) {
    throw invalid(
      'TRANSFER_REASON_REQUIRED',
      'Say why the stock is moving — the challan carries it',
      { field: 'reason' },
    )
  }
  if (input.fromStoreId === input.toStoreId) {
    throw invalid('TRANSFER_SAME_STORE', 'A branch cannot transfer stock to itself')
  }

  /* Summed per batch BEFORE anything is checked. Two lines against one batch
     each pass the stock test alone and overdraw it together — the same class of
     bug as checking a cart line against stock instead of the cart. */
  const wanted = new Map<number, D.Decimal>()
  for (const line of input.lines) {
    const qty = D.dec(line.qty)
    if (!D.gt(qty, D.ZERO)) continue
    wanted.set(line.batchId, D.add(wanted.get(line.batchId) ?? D.ZERO, qty))
  }
  if (wanted.size === 0) {
    throw invalid('TRANSFER_EMPTY', 'Nothing has been selected to move')
  }

  const lines: TransferLine[] = []
  let total = D.ZERO

  for (const line of input.lines) {
    const qty = D.dec(line.qty)
    if (!D.gt(qty, D.ZERO)) continue

    const batch = ctx.batchOf(line.batchId)
    if (!batch) {
      throw invalid('BATCH_MISSING', `Batch ${line.batchId} is not on this branch's shelf`, {
        batchId: line.batchId,
      })
    }
    /* Belt and braces on the store: `batchOf` is already scoped to the source
       branch, but a transfer is the one operation that legitimately names two
       stores and a mix-up here moves stock that was never there. */
    if (batch.storeId !== input.fromStoreId) {
      throw invalid('BATCH_WRONG_STORE', `Batch ${batch.batchNo} does not belong to this branch`, {
        batchId: batch.id,
      })
    }
    const asked = wanted.get(line.batchId) ?? qty
    if (D.gt(asked, D.dec(batch.qtyOnHand))) {
      throw invalid(
        'TRANSFER_EXCEEDS_STOCK',
        `Batch ${batch.batchNo} holds ${D.toStr(D.dec(batch.qtyOnHand), 0)}; ${D.toStr(asked, 0)} cannot be sent`,
        { batchId: batch.id, onHand: batch.qtyOnHand },
      )
    }
    /* Expired stock is refused outright. A branch that is short does not want
       stock that cannot be sold, and moving it only relocates a write-off — with
       a document that makes it look like supply. */
    if (batch.expiryDate < input.issuedOn) {
      throw invalid(
        'TRANSFER_EXPIRED',
        `Batch ${batch.batchNo} expired on ${batch.expiryDate}. Moving it relocates a write-off; issue it as an expiry claim instead.`,
        { batchId: batch.id },
      )
    }

    const medicine = ctx.medicineOf(batch.medicineId)
    if (!medicine) {
      throw invalid('MEDICINE_MISSING', `Medicine ${batch.medicineId} is not in the catalogue`)
    }

    const cost = D.dec(batch.landedCostPerUnit)
    const value = D.round(D.mul(cost, qty), 2)
    total = D.add(total, value)

    lines.push({
      lineId: line.lineId,
      batchId: batch.id,
      medicineId: batch.medicineId,
      brandName: medicine.brandName,
      packLabel: medicine.packLabel,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      hsnCode: medicine.hsnCode,
      qty: D.toStr(qty, 3) as Qty,
      /* The chain's cost, carried. A destination batch costed at anything else
         makes every margin report at the receiving branch fiction. */
      costPerUnit: batch.landedCostPerUnit,
      mrpPerPack: batch.mrpPerPack,
      lineValue: D.toStr(value, 2) as Money,
    })
  }

  return {
    document: documentFor(ctx.from, ctx.to),
    fromStoreId: input.fromStoreId,
    fromStoreName: ctx.from.name,
    toStoreId: input.toStoreId,
    toStoreName: ctx.to.name,
    issuedOn: input.issuedOn,
    createdAt: ctx.createdAt,
    reason,
    operatorName: ctx.operatorName,
    lines,
    totalValue: D.toStr(total, 2) as Money,
    basis: basisFor(ctx.from, ctx.to),
    status: 'POSTED',
  }
}

/**
 * The batch the destination should receive into.
 *
 * Batch identity is medicine + batch number + expiry + PRINTED MRP — the same
 * key the purchase side uses, and for the same reason: the same printed batch
 * number legitimately arrives at a revised MRP, and the customer pays what is on
 * the strip in their hand.
 *
 * Matching on medicine and batch number alone would merge two genuinely
 * different batches at the destination and sell one at the other's price.
 */
export function findDestinationBatch(
  line: TransferLine,
  destinationBatches: readonly Batch[],
): Batch | undefined {
  return destinationBatches.find((b) =>
    b.medicineId === line.medicineId
    && b.batchNo.trim().toLowerCase() === line.batchNo.trim().toLowerCase()
    && b.expiryDate === line.expiryDate
    && D.cmp(D.dec(b.mrpPerPack), D.dec(line.mrpPerPack)) === 0)
}

/** A destination batch that does not exist yet, built from the one that left. */
export function newDestinationBatch(
  line: TransferLine,
  source: Batch,
  toStoreId: number,
): Omit<Batch, 'id'> {
  return {
    storeId: toStoreId,
    medicineId: line.medicineId,
    batchNo: line.batchNo,
    expiryDate: line.expiryDate,
    mrpPerPack: line.mrpPerPack,
    mrpPerUnit: source.mrpPerUnit,
    ptrPerUnit: source.ptrPerUnit,
    landedCostPerUnit: line.costPerUnit,
    purchaseGstPct: source.purchaseGstPct,
    qtyOnHand: line.qty,
    /* Never arrives quarantined. A held batch is held for a reason at the shop
       that held it, and `priceTransfer` already refuses to move expired stock —
       so anything that gets this far is stock the receiving branch can sell. */
    isQuarantined: false,
  }
}

/** How the movement is titled wherever it is shown, so no screen invents one. */
export const DOCUMENT_LABEL: Record<TransferDocument, string> = {
  CHALLAN: 'Delivery challan',
  TAX_INVOICE: 'Tax invoice',
}
