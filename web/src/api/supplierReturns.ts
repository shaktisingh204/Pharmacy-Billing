import type {
  Batch, ClaimSettlementInput, IsoDate, Medicine, Money, Pct, Qty, ReturnKind,
  SupplierReturn, SupplierReturnInput, SupplierReturnLine,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { roundOff } from '@/domain/gst'
import { taxOn } from './purchases'

/**
 * Stock going back UP the supply chain, as pure value logic.
 *
 * There are two documents here and the whole module exists to keep them apart,
 * because CBIC Circular 72/46/2018-GST keeps them apart:
 *
 *  - A PURCHASE RETURN is a debit note against the bill the goods arrived on.
 *    It reverses the input tax credit that bill gave us, and it reduces what we
 *    owe the supplier. It settles the moment it is raised.
 *
 *  - An EXPIRY CLAIM is not a return at all in GST's eyes. It is a fresh
 *    OUTWARD supply from this shop on its own tax invoice, valued at the
 *    original supply-invoice value, on which we charge tax. Nothing is settled
 *    when it is raised: the manufacturer's credit arrives weeks later, usually
 *    net of a breakage allowance, and the gap is money the shop either recovers
 *    or writes off.
 *
 * Three rules hold both of them together:
 *
 *  1. PURCHASE-SIDE MONEY IS GST-EXCLUSIVE. The counter sells at an inclusive
 *     MRP and this side does not, and confusing the two is the easiest mistake
 *     in the app to make and the hardest to see — an 18% line comes out 15.25%
 *     wrong and still looks like a plausible invoice. `taxOn` is shared with
 *     `pricePurchase` so there is exactly one implementation of it.
 *
 *  2. THE RATE IS THE ONE FROZEN ON THE BATCH. `Batch.purchaseGstPct` is the
 *     rate that bill actually charged. Reversing credit at today's rate after a
 *     slab change reverses an amount that was never taken.
 *
 *  3. NOTHING GOES BACK THAT IS NOT THERE. The quantity is checked against
 *     `qtyOnHand` before any of the arithmetic, because a return that
 *     overdraws a batch is how stock goes negative on the one path nobody
 *     watches.
 */

const invalid = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(details === undefined ? { code, message } : { code, message, details })

/** What the caller must supply to price a return. Pure in, pure out. */
export interface SupplierReturnContext {
  storeId: number
  supplierName: string
  againstPurchaseNo: string | null
  /** IGST replaces CGST+SGST. Resolved by the caller from the supplier's GSTIN. */
  interState: boolean
  operatorName: string
  batchOf: (batchId: number) => Batch | undefined
  medicineOf: (medicineId: number) => Medicine | undefined
  createdAt: string
}

export type PricedSupplierReturn = Omit<SupplierReturn, 'id' | 'documentNo'>

/** The minimum a reason has to say. Matches the sale-return rule deliberately. */
export const REASON_MIN = 6

const collapse = (v: string): string => v.trim().replace(/\s+/g, ' ')

/**
 * Why the goods are going back, in the operator's words.
 *
 * Not optional and not defaulted. Stock leaving the building with no explanation
 * is indistinguishable from shrinkage six months later, and the claim file an
 * auditor asks for is exactly this field.
 */
export function requireReturnReason(reason: string): string {
  const trimmed = collapse(reason ?? '')
  if (trimmed.length < REASON_MIN) {
    throw invalid(
      'RETURN_REASON_REQUIRED',
      'Say why the goods are going back — the document carries it',
      { field: 'reason' },
    )
  }
  return trimmed
}

/**
 * A debit note has to point at a bill; a claim does not.
 *
 * Marg makes you pick the purchase from a "Pending Invoice" list before it will
 * post a debit note, and it is right to: a debit note floating free of the
 * invoice it reduces cannot be reconciled against the supplier's ledger by
 * anybody, and the supplier will not accept it either. A claim is the opposite
 * case — the strip expiring today was bought two years ago, the bill may pre-date
 * the software entirely, and the claim stands on its own invoice regardless.
 */
export function requirePurchaseLink(kind: ReturnKind, againstPurchaseId: number | null): void {
  if (kind === 'PURCHASE_RETURN' && againstPurchaseId === null) {
    throw invalid(
      'PURCHASE_LINK_REQUIRED',
      'A debit note has to be set against the purchase bill it reduces',
      { field: 'againstPurchaseId' },
    )
  }
}

/** Base units available to send back. Quarantined stock still counts — holding a
 *  batch for return is exactly why it was quarantined in the first place. */
const available = (batch: Batch): D.Decimal => D.dec(batch.qtyOnHand)

/**
 * Price a return without moving anything.
 *
 * The screen runs this live on every keystroke, so it throws on bad input rather
 * than returning a partial document: half a priced return rendered as a total is
 * a number somebody will read.
 */
export function priceSupplierReturn(
  input: SupplierReturnInput,
  ctx: SupplierReturnContext,
): PricedSupplierReturn {
  const reason = requireReturnReason(input.reason)
  requirePurchaseLink(input.kind, input.againstPurchaseId)

  if (input.lines.length === 0) {
    throw invalid('RETURN_EMPTY', 'Nothing has been selected to send back')
  }

  /* One row per batch, summed. Two lines against the same batch would each pass
     the stock check on their own and overdraw it together — the same class of
     bug as checking a cart line against stock instead of the cart. */
  const wanted = new Map<number, D.Decimal>()
  for (const line of input.lines) {
    const qty = D.dec(line.qty)
    if (!D.gt(qty, D.ZERO)) continue
    wanted.set(line.batchId, D.add(wanted.get(line.batchId) ?? D.ZERO, qty))
  }
  if (wanted.size === 0) {
    throw invalid('RETURN_EMPTY', 'Every line is zero — nothing would go back')
  }

  const lines: SupplierReturnLine[] = []
  for (const line of input.lines) {
    const qty = D.dec(line.qty)
    if (!D.gt(qty, D.ZERO)) continue

    const batch = ctx.batchOf(line.batchId)
    if (!batch) {
      throw invalid('BATCH_MISSING', `Batch ${line.batchId} is not in this store`, {
        batchId: line.batchId,
      })
    }
    const asked = wanted.get(line.batchId) ?? qty
    if (D.gt(asked, available(batch))) {
      throw invalid(
        'RETURN_EXCEEDS_STOCK',
        `Batch ${batch.batchNo} holds ${D.toStr(available(batch), 0)}; ${D.toStr(asked, 0)} cannot go back`,
        { batchId: batch.id, onHand: batch.qtyOnHand },
      )
    }
    const medicine = ctx.medicineOf(batch.medicineId)
    if (!medicine) {
      throw invalid('MEDICINE_MISSING', `Medicine ${batch.medicineId} is not in the catalogue`)
    }

    /* GST-EXCLUSIVE, per base unit, at the rate FROZEN on the batch. Both halves
       of that sentence are load-bearing — see the rules at the top. */
    const ratePerUnit = D.dec(batch.ptrPerUnit)
    const taxableValue = D.round(D.mul(ratePerUnit, qty), 2)
    const tax = taxOn(taxableValue, batch.purchaseGstPct)
    const cgst = ctx.interState ? D.ZERO : D.round(D.div(tax, D.dec(2)), 2)
    // The other half as a RESIDUAL, so cgst + sgst is exactly the tax.
    const sgst = ctx.interState ? D.ZERO : D.sub(tax, cgst)
    const igst = ctx.interState ? tax : D.ZERO

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
      ratePerUnit: D.toStr(ratePerUnit, 4) as Money,
      gstRatePct: batch.purchaseGstPct as Pct,
      taxableValue: D.toStr(taxableValue, 2) as Money,
      cgst: D.toStr(cgst, 2) as Money,
      sgst: D.toStr(sgst, 2) as Money,
      igst: D.toStr(igst, 2) as Money,
      lineTotal: D.toStr(D.sum([taxableValue, cgst, sgst, igst]), 2) as Money,
    })
  }

  const taxable = D.sum(lines.map((l) => D.dec(l.taxableValue)))
  const cgst = D.sum(lines.map((l) => D.dec(l.cgst)))
  const sgst = D.sum(lines.map((l) => D.dec(l.sgst)))
  const igst = D.sum(lines.map((l) => D.dec(l.igst)))
  const gross = D.sum([taxable, cgst, sgst, igst])
  const { rounded, adjustment } = roundOff(gross)

  return {
    kind: input.kind,
    storeId: ctx.storeId,
    terminalId: input.terminalId,
    supplierId: input.supplierId,
    supplierName: ctx.supplierName,
    againstPurchaseId: input.againstPurchaseId,
    againstPurchaseNo: ctx.againstPurchaseNo,
    issuedOn: input.issuedOn,
    createdAt: ctx.createdAt,
    reason,
    operatorName: ctx.operatorName,
    lines,
    taxableValue: D.toStr(taxable, 2) as Money,
    cgst: D.toStr(cgst, 2) as Money,
    sgst: D.toStr(sgst, 2) as Money,
    igst: D.toStr(igst, 2) as Money,
    roundOff: D.toStr(adjustment, 2) as Money,
    netAmount: D.toStr(rounded, 2) as Money,
    /* Null, not zero. "Nothing has come back yet" and "settled in full at zero"
       are different facts about a claim and only one of them means stop chasing.
       A purchase return has no settlement at all — it IS the settlement. */
    creditReceived: null,
    creditNoteRef: null,
    status: 'POSTED',
  }
}

// ------------------------------------------------------------ settlement ---

/**
 * What the manufacturer actually paid against a claim.
 *
 * Kept as its own number rather than netted off the claim, because the DIFFERENCE
 * is the point. A breakage allowance of 2% on a ₹40,000 expiry claim is ₹800 the
 * shop will never see, and a system that quietly reduces the claim to what
 * arrived leaves nobody able to say how much was lost that way over a year.
 */
export function settleClaim(doc: SupplierReturn, input: ClaimSettlementInput): SupplierReturn {
  if (doc.kind !== 'EXPIRY_CLAIM') {
    throw invalid(
      'NOT_A_CLAIM',
      'A debit note settles when it is adjusted against its bill; there is nothing to record here',
      { kind: doc.kind },
    )
  }
  if (doc.status !== 'POSTED') {
    throw invalid('RETURN_CANCELLED', `${doc.documentNo} has been cancelled`)
  }
  const received = D.dec(input.creditReceived)
  if (D.isNeg(received)) {
    throw invalid('CREDIT_NEGATIVE', 'A credit received cannot be negative', {
      field: 'creditReceived',
    })
  }
  /* Above the claim is refused rather than clamped. A credit larger than what was
     claimed is not a windfall, it is a keying error or a credit for a different
     claim — and silently accepting it would make the shortfall report show money
     the shop is owed by the manufacturer, which is nonsense. */
  if (D.gt(received, D.dec(doc.netAmount))) {
    throw invalid(
      'CREDIT_EXCEEDS_CLAIM',
      `${doc.documentNo} claimed ${doc.netAmount}; a credit of ${input.creditReceived} is more than that`,
      { claimed: doc.netAmount },
    )
  }
  const ref = collapse(input.creditNoteRef ?? '')
  if (ref === '') {
    throw invalid(
      'CREDIT_REF_REQUIRED',
      'Record their credit note number — it is the only way to trace this settlement',
      { field: 'creditNoteRef' },
    )
  }
  return { ...doc, creditReceived: D.toStr(received, 2) as Money, creditNoteRef: ref }
}

/**
 * Claim value, credit received and shortfall — three numbers, never one.
 *
 * `outstanding` is what has not been answered at all; `shortfall` is what came
 * back short of what was claimed. They are different money: the first is still
 * being chased, the second has been decided and lost. A single "balance" hides
 * exactly the number worth knowing.
 */
export interface ClaimPosition {
  claimed: Money
  received: Money
  /** Claims with nothing back yet. Still chaseable. */
  outstanding: Money
  /** Settled claims that came back short. Already lost. */
  shortfall: Money
  openCount: number
  settledCount: number
}

export function claimPosition(docs: readonly SupplierReturn[]): ClaimPosition {
  let claimed = D.ZERO
  let received = D.ZERO
  let outstanding = D.ZERO
  let shortfall = D.ZERO
  let openCount = 0
  let settledCount = 0

  for (const doc of docs) {
    if (doc.kind !== 'EXPIRY_CLAIM' || doc.status !== 'POSTED') continue
    const value = D.dec(doc.netAmount)
    claimed = D.add(claimed, value)
    if (doc.creditReceived === null) {
      outstanding = D.add(outstanding, value)
      openCount += 1
      continue
    }
    const got = D.dec(doc.creditReceived)
    received = D.add(received, got)
    shortfall = D.add(shortfall, D.sub(value, got))
    settledCount += 1
  }

  return {
    claimed: D.toStr(claimed, 2) as Money,
    received: D.toStr(received, 2) as Money,
    outstanding: D.toStr(outstanding, 2) as Money,
    shortfall: D.toStr(shortfall, 2) as Money,
    openCount,
    settledCount,
  }
}

/**
 * The stock each line takes off the shelf.
 *
 * Always negative and always by batch: both kinds physically remove the same
 * units, and only the paperwork differs. The reason code differs too, so the
 * ledger can tell a debit note from a claim without joining anything.
 */
export interface ReturnMovement {
  batchId: number
  medicineId: number
  qtyDelta: Qty
  reason: 'PURCHASE_RETURN' | 'EXPIRY_CLAIM'
}

export function returnMovements(doc: PricedSupplierReturn): ReturnMovement[] {
  return doc.lines.map((line) => ({
    batchId: line.batchId,
    medicineId: line.medicineId,
    qtyDelta: D.toStr(D.neg(D.dec(line.qty)), 3) as Qty,
    reason: doc.kind,
  }))
}

/** How the document is titled wherever it is shown, so no screen invents its own. */
export const RETURN_KIND_LABEL: Record<ReturnKind, string> = {
  PURCHASE_RETURN: 'Debit note',
  EXPIRY_CLAIM: 'Expiry claim',
}

/** What the operator is actually doing, in the words used on the shop floor. */
export const RETURN_KIND_ACTION: Record<ReturnKind, string> = {
  PURCHASE_RETURN: 'Return to supplier',
  EXPIRY_CLAIM: 'Issue breakage / expiry',
}

/**
 * The sentence printed under each choice.
 *
 * These are the tax positions, said plainly, because the operator picking
 * between them is deciding which document the shop issues and most of them have
 * never been told the two are different.
 */
export const RETURN_KIND_BASIS: Record<ReturnKind, string> = {
  PURCHASE_RETURN:
    'A debit note against the purchase bill. Reverses the input tax credit that bill gave, and reduces what is owed to the supplier.',
  EXPIRY_CLAIM:
    'A fresh outward tax invoice from this shop, valued at what was paid. Tax is charged, not reversed — and the credit comes back later, often net of a breakage allowance.',
}

/** Is this batch worth offering for a claim? Expired or already held aside. */
export function claimable(batch: Batch, today: IsoDate): boolean {
  return batch.expiryDate <= today || batch.isQuarantined
}
