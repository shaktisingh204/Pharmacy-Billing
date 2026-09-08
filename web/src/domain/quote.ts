import type {
  Batch, Medicine, Quote, QuoteAllocation, QuoteLine, QuoteRequest,
  QuoteWarning, TaxBreakupRow,
} from '@contract'
import * as D from './decimal'
import type { Decimal } from './decimal'
import { allocateFefo, allocateManual, daysToExpiry } from './fefo'
import type { TaxRateRow } from './gst'
import { apportion, resolveGstRate, roundOff, splitInclusive } from './gst'

/**
 * The quote engine: pure, read-only, moves no stock and consumes no invoice number.
 *
 * The POS re-quotes on every cart change, so this is also the only place line
 * totals are ever produced. Nothing in the view layer does money arithmetic.
 */

export interface QuoteContext {
  today: string
  expiryGuardDays: number
  nearExpiryWarnDays: number
  roundOffEnabled: boolean
  taxRates: readonly TaxRateRow[]
  medicines: ReadonlyMap<number, Medicine>
  batchesByMedicine: ReadonlyMap<number, Batch[]>
  customerAllergies?: readonly string[]
}

interface WorkingAllocation {
  batch: Batch
  qty: Decimal
  freeQty: Decimal
  ratePerUnit: Decimal
  gross: Decimal
  lineDiscount: Decimal
  ratePct: string
  /** Set once the bill-level discount has been apportioned onto this allocation. */
  billDiscountShare: Decimal
}

export function computeQuote(req: QuoteRequest, ctx: QuoteContext): Quote {
  const warnings: QuoteWarning[] = []
  const working: Array<{ input: (typeof req.lines)[number]; allocs: WorkingAllocation[]; medicine: Medicine; shortQty: Decimal; manual: boolean }> = []

  for (const line of req.lines) {
    const medicine = ctx.medicines.get(line.medicineId)
    if (!medicine) {
      warnings.push({
        code: 'INSUFFICIENT_STOCK',
        lineId: line.lineId,
        message: `Medicine ${line.medicineId} not found`,
        blocking: true,
      })
      continue
    }

    const batches = ctx.batchesByMedicine.get(line.medicineId) ?? []
    const requested = D.dec(line.qty)
    const manual = Boolean(line.batchOverride?.length)
    const result = manual
      ? allocateManual(batches, line.batchOverride ?? [], requested)
      : allocateFefo(batches, requested, {
          today: ctx.today,
          expiryGuardDays: ctx.expiryGuardDays,
        })

    if (D.gt(result.shortQty, D.ZERO)) {
      warnings.push({
        code: 'INSUFFICIENT_STOCK',
        lineId: line.lineId,
        message: `Only ${D.toStr(D.sub(requested, result.shortQty), 0)} of ${D.toStr(requested, 0)} ${medicine.baseUom.toLowerCase()} available`,
        blocking: false,
      })
    }
    if (result.mixedMrp) {
      warnings.push({
        code: 'MIXED_MRP',
        lineId: line.lineId,
        // Two printed MRPs on the shelf for the same brand is routine after a
        // price revision. The customer pays what is printed on the strip they get,
        // so the split must be visible rather than silently averaged.
        message: `${medicine.brandName} is split across batches with different printed MRPs`,
        blocking: false,
      })
    }
    if (!medicine.allowLooseSale) {
      const packs = D.div(requested, D.dec(medicine.unitsPerPack))
      if (!D.eq(packs, D.round(packs, 0))) {
        warnings.push({
          code: 'LOOSE_SALE_NOT_ALLOWED',
          lineId: line.lineId,
          message: `${medicine.brandName} must be sold in whole packs of ${medicine.unitsPerPack}`,
          blocking: true,
        })
      }
    }
    if (medicine.drugSchedule === 'H1') {
      warnings.push({
        code: 'SCHEDULE_H1',
        lineId: line.lineId,
        message: `${medicine.brandName} is Schedule H1 — prescriber and patient details are required`,
        blocking: true,
      })
    } else if (medicine.requiresPrescription) {
      warnings.push({
        code: 'PRESCRIPTION_REQUIRED',
        lineId: line.lineId,
        message: `${medicine.brandName} requires a prescription`,
        blocking: false,
      })
    }
    for (const a of result.allocations) {
      const days = daysToExpiry(a.batch, ctx.today)
      if (days <= ctx.nearExpiryWarnDays) {
        warnings.push({
          code: 'NEAR_EXPIRY',
          lineId: line.lineId,
          message: `Batch ${a.batch.batchNo} expires in ${days} days`,
          blocking: false,
        })
      }
    }
    if (ctx.customerAllergies?.length) {
      const composition = medicine.compositionText.toLowerCase()
      for (const allergy of ctx.customerAllergies) {
        if (allergy.trim() && composition.includes(allergy.toLowerCase())) {
          warnings.push({
            code: 'ALLERGY_CONFLICT',
            lineId: line.lineId,
            message: `Customer is allergic to ${allergy} — ${medicine.brandName} contains it`,
            blocking: true,
          })
        }
      }
    }

    const ratePct = resolveGstRate(medicine.hsnCode, req.invoiceDate, ctx.taxRates).ratePct
    const discountPct = D.dec(line.discountPct ?? '0')
    const freeQty = D.dec(line.freeQty ?? '0')

    const allocs: WorkingAllocation[] = result.allocations.map((a, i) => {
      // A batch is priced at its OWN printed MRP; that is the whole reason MRP is
      // part of batch identity rather than a product attribute.
      const ratePerUnit = D.dec(a.batch.mrpPerUnit)
      const gross = D.round(D.mul(ratePerUnit, a.qty), 2)
      const lineDiscount = D.round(D.div(D.mul(gross, discountPct), D.HUNDRED), 2)
      return {
        batch: a.batch,
        qty: a.qty,
        // Free goods ride on the first allocation; they are dispensed, not charged.
        freeQty: i === 0 ? freeQty : D.ZERO,
        ratePerUnit,
        gross,
        lineDiscount,
        ratePct,
        billDiscountShare: D.ZERO,
      }
    })

    working.push({ input: line, allocs, medicine, shortQty: result.shortQty, manual })
  }

  // Bill discount is apportioned over ALLOCATIONS, not lines, so that each batch's
  // tax is computed on the amount actually attributable to it. Apportioning per
  // line and then splitting again would round twice.
  const flat = working.flatMap((w) => w.allocs)
  const netAfterLine = flat.map((a) => D.sub(a.gross, a.lineDiscount))
  const grossTotal = D.sum(flat.map((a) => a.gross))
  const itemDiscountTotal = D.sum(flat.map((a) => a.lineDiscount))
  const billDiscountPct = D.dec(req.billDiscountPct ?? '0')
  const billDiscountTotal = D.isZero(billDiscountPct)
    ? D.ZERO
    : D.round(D.div(D.mul(D.sum(netAfterLine), billDiscountPct), D.HUNDRED), 2)

  if (!D.isZero(billDiscountTotal)) {
    const shares = apportion(billDiscountTotal, netAfterLine)
    flat.forEach((a, i) => {
      a.billDiscountShare = shares[i] ?? D.ZERO
    })
  }

  const lines: QuoteLine[] = working.map((w) => {
    const quoteAllocs: QuoteAllocation[] = w.allocs.map((a) => {
      const inclusive = D.sub(D.sub(a.gross, a.lineDiscount), a.billDiscountShare)
      const split = splitInclusive(inclusive, a.ratePct, req.interState)
      const alloc: QuoteAllocation = {
        batchId: a.batch.id,
        batchNo: a.batch.batchNo,
        expiryDate: a.batch.expiryDate,
        qty: D.toStr(a.qty, 3),
        freeQty: D.toStr(a.freeQty, 3),
        mrpPerUnit: a.batch.mrpPerUnit,
        ratePerUnit: D.toStr(a.ratePerUnit, 4),
        grossAmount: D.toStr(a.gross, 2),
        discountAmount: D.toStr(D.add(a.lineDiscount, a.billDiscountShare), 2),
        taxableValue: D.toStr(split.taxableValue, 2),
        cgst: D.toStr(split.cgst, 2),
        sgst: D.toStr(split.sgst, 2),
        igst: D.toStr(split.igst, 2),
        lineTotal: D.toStr(inclusive, 2),
        gstRatePct: a.ratePct,
        costBasis: D.toStr(D.mul(D.dec(a.batch.landedCostPerUnit), D.add(a.qty, a.freeQty)), 2),
      }
      const first = w.allocs[0]
      if (first && first.batch.mrpPerUnit !== a.batch.mrpPerUnit) {
        alloc.repricedFrom = first.batch.mrpPerUnit
      }
      return alloc
    })

    const fold = (pick: (a: QuoteAllocation) => string): Decimal =>
      D.sum(quoteAllocs.map((a) => D.dec(pick(a))))

    return {
      lineId: w.input.lineId,
      medicineId: w.medicine.id,
      brandName: w.medicine.brandName,
      packLabel: w.medicine.packLabel,
      hsnCode: w.medicine.hsnCode,
      drugSchedule: w.medicine.drugSchedule,
      requestedQty: D.toStr(D.dec(w.input.qty), 3),
      allocatedQty: D.toStr(D.sum(w.allocs.map((a) => a.qty)), 3),
      shortQty: D.toStr(w.shortQty, 3),
      allocations: quoteAllocs,
      discountPct: w.input.discountPct ?? '0',
      grossAmount: D.toStr(fold((a) => a.grossAmount), 2),
      discountAmount: D.toStr(fold((a) => a.discountAmount), 2),
      taxableValue: D.toStr(fold((a) => a.taxableValue), 2),
      cgst: D.toStr(fold((a) => a.cgst), 2),
      sgst: D.toStr(fold((a) => a.sgst), 2),
      igst: D.toStr(fold((a) => a.igst), 2),
      lineTotal: D.toStr(fold((a) => a.lineTotal), 2),
      manualBatch: w.manual,
    }
  })

  const allAllocs = lines.flatMap((l) => l.allocations)
  const taxableValue = D.sum(allAllocs.map((a) => D.dec(a.taxableValue)))
  const cgst = D.sum(allAllocs.map((a) => D.dec(a.cgst)))
  const sgst = D.sum(allAllocs.map((a) => D.dec(a.sgst)))
  const igst = D.sum(allAllocs.map((a) => D.dec(a.igst)))
  const beforeRounding = D.sum(allAllocs.map((a) => D.dec(a.lineTotal)))

  const { rounded, adjustment } = ctx.roundOffEnabled
    ? roundOff(beforeRounding)
    : { rounded: beforeRounding, adjustment: D.ZERO }

  // One row per DISTINCT rate: a real pharmacy bill legitimately mixes nil-rated
  // ORS, 5% medicines and 18% nutraceuticals, and the filing needs them separated.
  const byRate = new Map<string, TaxBreakupRow>()
  for (const a of allAllocs) {
    const row = byRate.get(a.gstRatePct) ?? {
      gstRatePct: a.gstRatePct,
      taxableValue: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', total: '0.00',
    }
    byRate.set(a.gstRatePct, {
      gstRatePct: a.gstRatePct,
      taxableValue: D.toStr(D.add(D.dec(row.taxableValue), D.dec(a.taxableValue)), 2),
      cgst: D.toStr(D.add(D.dec(row.cgst), D.dec(a.cgst)), 2),
      sgst: D.toStr(D.add(D.dec(row.sgst), D.dec(a.sgst)), 2),
      igst: D.toStr(D.add(D.dec(row.igst), D.dec(a.igst)), 2),
      total: D.toStr(D.add(D.dec(row.total), D.dec(a.lineTotal)), 2),
    })
  }

  return {
    lines,
    grossAmount: D.toStr(grossTotal, 2),
    itemDiscount: D.toStr(itemDiscountTotal, 2),
    billDiscountPct: req.billDiscountPct ?? '0',
    billDiscount: D.toStr(billDiscountTotal, 2),
    taxableValue: D.toStr(taxableValue, 2),
    cgst: D.toStr(cgst, 2),
    sgst: D.toStr(sgst, 2),
    igst: D.toStr(igst, 2),
    roundOff: D.toStr(adjustment, 2),
    netAmount: D.toStr(rounded, 2),
    taxBreakup: [...byRate.values()].sort((a, b) => Number(a.gstRatePct) - Number(b.gstRatePct)),
    warnings,
    costOfGoods: D.toStr(D.sum(allAllocs.map((a) => D.dec(a.costBasis))), 2),
  }
}
