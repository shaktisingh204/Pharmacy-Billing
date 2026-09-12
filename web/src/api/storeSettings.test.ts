import { describe, expect, it } from 'vitest'
import type { ApiError, StoreProfile } from '@contract'
import { applyStorePatch, warningsFor } from './storeSettings'
import type { StorePatch } from './storeSettings'

const STORE: StoreProfile = {
  id: 1,
  name: 'Sanjeevani Medical Store',
  tagline: null,
  addressLine: '12 Laxmi Road',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  phone: '2025551234',
  email: null,
  gstin: '27AACCS4471M1ZB',
  dlNos: ['MH-PN1-114B'],
  invoicePrefix: 'RX',
  financialYearStartMonth: 4,
  currency: 'INR',
  expiryGuardDays: 30,
  nearExpiryBuckets: [30, 60, 90, 180],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: 'sanjeevani@okhdfc',
  footerNote: '',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

const apply = (patch: StorePatch, issuedThisYear = 0) =>
  applyStorePatch(STORE, patch, { issuedThisYear })

const code = (patch: StorePatch, issuedThisYear = 0): string => {
  try {
    apply(patch, issuedThisYear)
  } catch (e) {
    return (e as ApiError).code
  }
  return 'DID_NOT_THROW'
}

// ------------------------------------------------------------- numbering ---

describe('the things that decide document numbers', () => {
  it('refuses a prefix change once documents exist in the year', () => {
    // Two series inside one financial year cannot be reported as either one
    // series or two without a gap — and Table 13 asks for exactly that.
    expect(code({ invoicePrefix: 'SM' }, 412)).toBe('PREFIX_LOCKED_THIS_YEAR')
    // And says how many, because "at the year end" is only actionable if you
    // know why now is not the year end.
    try {
      apply({ invoicePrefix: 'SM' }, 412)
    } catch (e) {
      expect((e as Error).message).toContain('412')
    }
  })

  it('allows a prefix change before anything has been issued', () => {
    expect(apply({ invoicePrefix: 'SM' }, 0).invoicePrefix).toBe('SM')
  })

  it('refuses to move the year boundary once numbers have been given out', () => {
    // Re-issuing a number that has already been handed to a customer breaks the
    // one assumption everything downstream rests on.
    expect(code({ financialYearStartMonth: 1 }, 412)).toBe('FY_LOCKED_THIS_YEAR')
    expect(apply({ financialYearStartMonth: 1 }, 0).financialYearStartMonth).toBe(1)
  })

  it('rejects a prefix that is not usable in a document number', () => {
    expect(code({ invoicePrefix: '1X' })).toBe('PREFIX_INVALID')
    expect(code({ invoicePrefix: 'TOOLONGPREFIX' })).toBe('PREFIX_INVALID')
    expect(apply({ invoicePrefix: 'sm' }).invoicePrefix).toBe('SM')
  })

  it('rejects a month that is not a month', () => {
    expect(code({ financialYearStartMonth: 13 })).toBe('FY_MONTH_INVALID')
    expect(code({ financialYearStartMonth: 0 })).toBe('FY_MONTH_INVALID')
  })
})

// ------------------------------------------------------------- statutory ---

describe('what prints on every bill', () => {
  it('refuses a GSTIN that is not one', () => {
    expect(code({ gstin: '27AACCS4471M1' })).toBe('GSTIN_INVALID')
    expect(apply({ gstin: '27aaccs4471m1zb' }).gstin).toBe('27AACCS4471M1ZB')
  })

  it('refuses a GSTIN and a state code that disagree', () => {
    // Every bill would be taxed against one state and filed against the other,
    // and neither figure looks wrong on its own screen.
    expect(code({ gstin: '24AAACM6677R1ZK' })).toBe('GSTIN_STATE_MISMATCH')
    // Changing both together is fine.
    expect(apply({ gstin: '24AAACM6677R1ZK', stateCode: '24' }).stateCode).toBe('24')
  })

  it('refuses to leave the shop with no drug licence', () => {
    expect(code({ dlNos: [] })).toBe('DL_REQUIRED')
    expect(code({ dlNos: ['  '] })).toBe('DL_REQUIRED')
  })

  it('refuses an unnamed pharmacy', () => {
    expect(code({ name: '   ' })).toBe('NAME_REQUIRED')
  })

  it('refuses to erase the premises or the phone number', () => {
    // Both print at the head of every bill: a bill that does not say where it
    // came from or how to reach the shop is not traceable to these premises.
    expect(code({ addressLine: '  ' })).toBe('ADDRESS_REQUIRED')
    expect(code({ city: '' })).toBe('CITY_REQUIRED')
    expect(code({ phone: '' })).toBe('PHONE_REQUIRED')
  })

  it('refuses an email that is not one, and accepts none at all', () => {
    expect(code({ email: 'care at sanjeevani' })).toBe('EMAIL_INVALID')
    expect(apply({ email: '' }).email).toBe('')
    expect(apply({ email: 'care@sanjeevanimeds.in' }).email).toBe('care@sanjeevanimeds.in')
  })
})

// ------------------------------------------------------- expiry windows ---

describe('the near-expiry windows', () => {
  it('are stored WIDEST FIRST whatever order they were typed in', () => {
    /* Two consumers read position rather than value — the dashboard takes the
       max as its horizon and the day close takes `.at(-1)` as its warning — so a
       shop that typed them ascending would warn at 180 days and nothing on any
       screen would look wrong. */
    expect(apply({ nearExpiryBuckets: [30, 90, 60] }).nearExpiryBuckets).toEqual([90, 60, 30])
  })

  it('refuses a set that would leave the expiry column meaningless', () => {
    expect(code({ nearExpiryBuckets: [] })).toBe('BUCKETS_REQUIRED')
    expect(code({ nearExpiryBuckets: [30, 30] })).toBe('BUCKET_DUPLICATE')
    expect(code({ nearExpiryBuckets: [0] })).toBe('BUCKET_INVALID')
    expect(code({ nearExpiryBuckets: [900] })).toBe('BUCKET_INVALID')
    expect(code({ nearExpiryBuckets: [30.5] })).toBe('BUCKET_INVALID')
    expect(code({ nearExpiryBuckets: [10, 20, 30, 40, 50, 60, 70] })).toBe('BUCKETS_TOO_MANY')
  })
})

// -------------------------------------------------------------- payments ---

describe('the UPI id, which becomes a QR on paper', () => {
  it('refuses one that is not a VPA — a wrong one takes money nowhere', () => {
    expect(code({ upiVpa: 'not-a-vpa' })).toBe('VPA_INVALID')
    expect(code({ upiVpa: '@okhdfc' })).toBe('VPA_INVALID')
  })

  it('accepts the handles banks actually issue', () => {
    for (const v of ['shop@okaxis', 'sanjeevani.store@ybl', 'a-b_c@paytm']) {
      expect(apply({ upiVpa: v }).upiVpa, v).toBe(v)
    }
  })

  it('turns a cleared field into NULL, not an empty string', () => {
    // The receipt asks `if (store.upiVpa)`; a blank string would print a QR
    // pointing at nothing.
    expect(apply({ upiVpa: '' }).upiVpa).toBeNull()
    expect(apply({ upiVpa: '   ' }).upiVpa).toBeNull()
  })
})

// --------------------------------------------------------------- filing ---

describe('the filing thresholds', () => {
  it('are editable, which is what makes them settings rather than law', () => {
    const next = apply({ filing: { b2clMinimum: '100000.00' } })
    expect(next.filing.b2clMinimum).toBe('100000.00')
    // And the rest are untouched by a partial patch.
    expect(next.filing.rule46Minimum).toBe('50000.00')
  })

  it('refuses an amount that is not an amount', () => {
    expect(code({ filing: { b2clMinimum: 'two lakh' } })).toBe('THRESHOLD_INVALID')
    expect(code({ filing: { rule46Minimum: '50000.000' } })).toBe('THRESHOLD_INVALID')
  })

  it('accepts only the HSN lengths GSTR-1 reports at', () => {
    expect(code({ filing: { hsnDigits: 5 } })).toBe('HSN_DIGITS_INVALID')
    for (const d of [4, 6, 8]) expect(apply({ filing: { hsnDigits: d } }).filing.hsnDigits).toBe(d)
  })
})

// ------------------------------------------------------------- warnings ---

describe('what is allowed and still worth saying', () => {
  it('warns that turning round-off off leaves the till short every bill', () => {
    expect(warningsFor(STORE, { roundOffEnabled: false }).join(' '))
      .toMatch(/cannot make 40 paise/)
  })

  it('warns that allowing negative stock removes a real guard', () => {
    expect(warningsFor(STORE, { allowNegativeStock: true }).join(' '))
      .toMatch(/removes the guard/)
  })

  it('warns that clearing the UPI id removes the QR from the paper', () => {
    expect(warningsFor(STORE, { upiVpa: '' }).join(' ')).toMatch(/removes the payment QR/)
  })

  it('warns that a new GSTIN does not reach bills already issued', () => {
    // The GSTIN is snapshotted onto each document, not looked up on reprint.
    expect(warningsFor(STORE, { gstin: '29AACCS4471M1ZB' }).join(' '))
      .toMatch(/keep the old GSTIN/)
    expect(warningsFor(STORE, { gstin: '27aaccs4471m1zb' })).toEqual([])
  })

  it('warns that moving the expiry windows re-colours every screen at once', () => {
    expect(warningsFor(STORE, { nearExpiryBuckets: [45, 120] }).join(' '))
      .toMatch(/re-bucket immediately/)
  })

  it('says nothing about a change with no consequence elsewhere', () => {
    expect(warningsFor(STORE, { name: 'New Name' })).toEqual([])
    // Turning round-off back ON is not a warning; only turning it off is.
    expect(warningsFor({ ...STORE, roundOffEnabled: false }, { roundOffEnabled: true })).toEqual([])
  })
})
