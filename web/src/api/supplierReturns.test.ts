import { describe, expect, it } from 'vitest'
import type {
  ApiError, Batch, Medicine, SupplierReturn, SupplierReturnInput,
} from '@contract'
import * as D from '@/domain/decimal'
import {
  RETURN_KIND_LABEL, claimPosition, claimable, priceSupplierReturn, requirePurchaseLink,
  requireReturnReason, returnMovements, settleClaim,
} from './supplierReturns'
import type { SupplierReturnContext } from './supplierReturns'

/**
 * The two documents, and the reason they are two.
 *
 * Purchase-side money is GST-EXCLUSIVE, which is the opposite of the counter,
 * and the rate is the one FROZEN on the batch rather than today's. Those two
 * facts are asserted with hand-computed figures below rather than by calling the
 * same helper the code calls, because a test that reuses the implementation
 * cannot catch the implementation being wrong.
 */

const TODAY = '2026-09-09'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  return {
    id,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: null,
    compositionText: 'Paracetamol 650mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '650mg',
    packLabel: '10x15',
    unitsPerPack: 15,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A1',
    reorderLevel: 100,
    saleRank: 0,
    isActive: true,
    ...over,
  }
}

function batch(id: number, over: Partial<Batch> = {}): Batch {
  return {
    id,
    storeId: 1,
    medicineId: 1,
    batchNo: `B${id}`,
    expiryDate: '2027-06-30',
    mrpPerPack: '150.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.5000',
    purchaseGstPct: '12',
    qtyOnHand: '40',
    isQuarantined: false,
    ...over,
  }
}

const BATCHES = new Map<number, Batch>([[1, batch(1)]])

function ctx(over: Partial<SupplierReturnContext> = {}): SupplierReturnContext {
  return {
    storeId: 1,
    supplierName: 'Sai Distributors',
    againstPurchaseNo: 'PB2627-00041',
    interState: false,
    operatorName: 'Prakash Nene',
    batchOf: (id) => BATCHES.get(id),
    medicineOf: (id) => (id === 1 ? medicine(1) : undefined),
    createdAt: '2026-09-09T10:00:00.000Z',
    ...over,
  }
}

function input(over: Partial<SupplierReturnInput> = {}): SupplierReturnInput {
  return {
    idempotencyKey: 'k1',
    kind: 'PURCHASE_RETURN',
    supplierId: 1,
    againstPurchaseId: 41,
    issuedOn: TODAY,
    terminalId: 1,
    reason: 'Wrong strength delivered against the order',
    lines: [{ lineId: 'l1', batchId: 1, qty: '10' }],
    ...over,
  }
}

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as ApiError).code
  }
  return 'DID_NOT_THROW'
}

// ------------------------------------------------------------- arithmetic ---

describe('pricing a return', () => {
  it('treats purchase-side money as GST-EXCLUSIVE — the opposite of the counter', () => {
    const doc = priceSupplierReturn(input(), ctx())
    // 10 units at 7.0000 = 70.00 taxable. Tax is ADDED at 12%: 8.40.
    // Read inclusively instead, the taxable would be 62.50 and the tax 7.50 —
    // a plausible-looking invoice understating the credit reversal by 0.90.
    expect(doc.taxableValue).toBe('70.00')
    expect(doc.cgst).toBe('4.20')
    expect(doc.sgst).toBe('4.20')
    expect(doc.igst).toBe('0.00')
    // 78.40 gross, rounded to the rupee like every Indian invoice, with the
    // adjustment shown rather than absorbed. The TAX lines are never rounded —
    // those are what the credit reversal is computed on.
    expect(doc.roundOff).toBe('-0.40')
    expect(doc.netAmount).toBe('78.00')
  })

  it('reverses at the rate FROZEN on the batch, not at today\'s slab', () => {
    // The same units bought when the slab was 5% reverse 5% of credit, whatever
    // the rate is now. Reversing today's rate reverses money never taken.
    const old = new Map([[1, batch(1, { purchaseGstPct: '5' })]])
    const doc = priceSupplierReturn(input(), ctx({ batchOf: (id) => old.get(id) }))
    expect(doc.lines[0]?.gstRatePct).toBe('5')
    expect(doc.taxableValue).toBe('70.00')
    // 70.00 + 1.75 + 1.75 = 73.50, and a half rounds AWAY from zero, which is
    // the statutory rule rather than banker's rounding.
    expect(doc.netAmount).toBe('74.00')
  })

  it('splits the halves as a residual so the line always foots', () => {
    // 3 units at 7.0000 = 21.00 at 12% = 2.52 tax; halves 1.26 / 1.26.
    const doc = priceSupplierReturn(
      input({ lines: [{ lineId: 'l1', batchId: 1, qty: '3' }] }),
      ctx(),
    )
    const line = doc.lines[0]
    expect(line).toBeDefined()
    const summed = D.sum([
      D.dec(line?.taxableValue ?? '0'), D.dec(line?.cgst ?? '0'),
      D.dec(line?.sgst ?? '0'), D.dec(line?.igst ?? '0'),
    ])
    expect(D.toStr(summed, 2)).toBe(line?.lineTotal)
  })

  it('puts the whole tax in IGST for an out-of-state supplier, never both', () => {
    const doc = priceSupplierReturn(input(), ctx({ interState: true }))
    expect(doc.igst).toBe('8.40')
    expect(doc.cgst).toBe('0.00')
    expect(doc.sgst).toBe('0.00')
    expect(doc.netAmount).toBe('78.00')
  })

  it('foots: every line total sums to the net, round-off included', () => {
    const doc = priceSupplierReturn(
      input({
        lines: [
          { lineId: 'l1', batchId: 1, qty: '7' },
          { lineId: 'l2', batchId: 1, qty: '3' },
        ],
      }),
      ctx(),
    )
    const lines = D.sum(doc.lines.map((l) => D.dec(l.lineTotal)))
    expect(D.toStr(D.add(lines, D.dec(doc.roundOff)), 2)).toBe(doc.netAmount)
  })
})

// ------------------------------------------------------------------ stock ---

describe('what may go back', () => {
  it('refuses more than the batch holds', () => {
    expect(code(() => priceSupplierReturn(
      input({ lines: [{ lineId: 'l1', batchId: 1, qty: '41' }] }), ctx(),
    ))).toBe('RETURN_EXCEEDS_STOCK')
  })

  it('sums two lines against ONE batch before checking it', () => {
    // 25 + 20 each pass alone against 40 on hand and overdraw it together — the
    // same bug as checking a cart line against stock instead of the cart.
    expect(code(() => priceSupplierReturn(
      input({
        lines: [
          { lineId: 'l1', batchId: 1, qty: '25' },
          { lineId: 'l2', batchId: 1, qty: '20' },
        ],
      }),
      ctx(),
    ))).toBe('RETURN_EXCEEDS_STOCK')
  })

  it('takes stock OFF the shelf, by batch, for both kinds', () => {
    for (const kind of ['PURCHASE_RETURN', 'EXPIRY_CLAIM'] as const) {
      // A debit note still needs its bill; only the claim may stand alone.
      const doc = priceSupplierReturn(
        input({ kind, againstPurchaseId: kind === 'PURCHASE_RETURN' ? 41 : null }),
        ctx(),
      )
      const moves = returnMovements(doc)
      expect(moves).toHaveLength(1)
      expect(moves[0]?.qtyDelta, kind).toBe('-10.000')
      expect(moves[0]?.reason, kind).toBe(kind)
    }
  })

  it('offers a quarantined batch for a claim — holding it is why it was held', () => {
    expect(claimable(batch(1, { isQuarantined: true }), TODAY)).toBe(true)
    expect(claimable(batch(1, { expiryDate: '2026-08-31' }), TODAY)).toBe(true)
    expect(claimable(batch(1), TODAY)).toBe(false)
  })
})

// -------------------------------------------------------------- paperwork ---

describe('the paperwork each kind demands', () => {
  it('makes a debit note point at the bill it reduces', () => {
    expect(code(() => requirePurchaseLink('PURCHASE_RETURN', null)))
      .toBe('PURCHASE_LINK_REQUIRED')
  })

  it('lets a claim stand alone — the strip expiring today was bought years ago', () => {
    expect(() => requirePurchaseLink('EXPIRY_CLAIM', null)).not.toThrow()
  })

  it('will not move stock out of the building unexplained', () => {
    expect(code(() => requireReturnReason('  '))).toBe('RETURN_REASON_REQUIRED')
    expect(requireReturnReason('  Short   dated  stock ')).toBe('Short dated stock')
  })

  it('refuses a document with nothing on it', () => {
    expect(code(() => priceSupplierReturn(input({ lines: [] }), ctx()))).toBe('RETURN_EMPTY')
    expect(code(() => priceSupplierReturn(
      input({ lines: [{ lineId: 'l1', batchId: 1, qty: '0' }] }), ctx(),
    ))).toBe('RETURN_EMPTY')
  })

  it('names the two documents differently, because they ARE different', () => {
    expect(RETURN_KIND_LABEL.PURCHASE_RETURN).toBe('Debit note')
    expect(RETURN_KIND_LABEL.EXPIRY_CLAIM).toBe('Expiry claim')
  })
})

// ------------------------------------------------------------- settlement ---

describe('settling a claim', () => {
  const claim = (over: Partial<SupplierReturn> = {}): SupplierReturn => ({
    ...priceSupplierReturn(input({ kind: 'EXPIRY_CLAIM', againstPurchaseId: null }), ctx()),
    id: 1,
    documentNo: 'RXEC2627-00001',
    ...over,
  })

  it('starts NULL, not zero — "nothing back yet" is not "settled at zero"', () => {
    expect(claim().creditReceived).toBeNull()
    expect(claim().creditNoteRef).toBeNull()
  })

  it('keeps what was claimed and what came back as SEPARATE numbers', () => {
    // The manufacturer credits 70.00 against a 78.00 claim: a breakage allowance
    // took 8.00. Netting it off the claim would leave nobody able to say how much
    // was lost that way over a year, which is the whole reason to track claims.
    const settled = settleClaim(claim(), {
      returnId: 1, creditReceived: '70.00', creditNoteRef: 'CN/2026/8871',
    })
    expect(settled.netAmount).toBe('78.00')
    expect(settled.creditReceived).toBe('70.00')
    expect(settled.creditNoteRef).toBe('CN/2026/8871')
  })

  it('refuses a credit larger than the claim rather than clamping it', () => {
    expect(code(() => settleClaim(claim(), {
      returnId: 1, creditReceived: '90.00', creditNoteRef: 'CN/1',
    }))).toBe('CREDIT_EXCEEDS_CLAIM')
  })

  it('demands their credit note number — it is the only trace of the settlement', () => {
    expect(code(() => settleClaim(claim(), {
      returnId: 1, creditReceived: '70.00', creditNoteRef: '   ',
    }))).toBe('CREDIT_REF_REQUIRED')
  })

  it('has nothing to settle on a debit note', () => {
    const dn: SupplierReturn = {
      ...priceSupplierReturn(input(), ctx()), id: 2, documentNo: 'RXDN2627-00001',
    }
    expect(code(() => settleClaim(dn, {
      returnId: 2, creditReceived: '10.00', creditNoteRef: 'CN/1',
    }))).toBe('NOT_A_CLAIM')
  })
})

describe('the claim position', () => {
  const claim = (id: number, net: string, received: string | null): SupplierReturn => ({
    ...priceSupplierReturn(input({ kind: 'EXPIRY_CLAIM', againstPurchaseId: null }), ctx()),
    id,
    documentNo: `RXEC2627-0000${id}`,
    netAmount: net,
    creditReceived: received,
  })

  it('separates what is still chaseable from what has already been lost', () => {
    const position = claimPosition([
      claim(1, '1000.00', null),      // nothing back yet — still chaseable
      claim(2, '2000.00', '1800.00'), // settled 200 short — already lost
      claim(3, '500.00', '500.00'),   // settled in full
    ])
    expect(position.claimed).toBe('3500.00')
    expect(position.received).toBe('2300.00')
    expect(position.outstanding).toBe('1000.00')
    expect(position.shortfall).toBe('200.00')
    expect(position.openCount).toBe(1)
    expect(position.settledCount).toBe(2)
  })

  it('counts no debit note toward a claim position', () => {
    const dn: SupplierReturn = {
      ...priceSupplierReturn(input(), ctx()), id: 9, documentNo: 'RXDN2627-00001',
    }
    expect(claimPosition([dn]).claimed).toBe('0.00')
    expect(claimPosition([dn]).openCount).toBe(0)
  })

  it('drops a cancelled claim out of every figure', () => {
    expect(claimPosition([{ ...claim(1, '1000.00', null), status: 'CANCELLED' }]).claimed)
      .toBe('0.00')
  })
})
