import { describe, expect, it } from 'vitest'
import type { ApiError, StoreProfile } from '@contract'
import { branchConsequences, branchTemplate, newBranchProfile, nextBranchId } from './branches'
import type { NewBranch } from './branches'

const HQ: StoreProfile = {
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
  nearExpiryBuckets: [180, 90, 60, 30],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: 'sanjeevani@okhdfc',
  footerNote: 'Store below 25°C.',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

function form(over: Partial<NewBranch> = {}): NewBranch {
  return {
    ...branchTemplate(HQ),
    name: 'Sanjeevani — Kothrud',
    addressLine: 'Shop 4, Paud Road',
    city: 'Kothrud',
    phone: '2025559999',
    dlNos: ['MH-PN4-118B'],
    invoicePrefix: 'KT',
    ...over,
  }
}

const code = (over: Partial<NewBranch>, siblings: StoreProfile[] = [HQ]): string => {
  try {
    newBranchProfile(form(over), HQ, siblings)
  } catch (e) {
    return (e as ApiError).code
  }
  return 'DID_NOT_THROW'
}

describe('opening a branch', () => {
  it('produces a profile that inherits chain policy and keeps its own identity', () => {
    const branch = newBranchProfile(form(), HQ, [HQ])

    expect(branch.id).toBe(2)
    expect(branch.name).toBe('Sanjeevani — Kothrud')
    expect(branch.invoicePrefix).toBe('KT')
    expect(branch.dlNos).toEqual(['MH-PN4-118B'])

    // Chain policy is inherited, never re-keyed per branch.
    expect(branch.filing).toEqual(HQ.filing)
    expect(branch.expiryGuardDays).toBe(HQ.expiryGuardDays)
    expect(branch.nearExpiryBuckets).toEqual(HQ.nearExpiryBuckets)
    expect(branch.footerNote).toBe(HQ.footerNote)
    expect(branch.roundOffEnabled).toBe(HQ.roundOffEnabled)
  })

  it('normalises the prefix and the GSTIN before validating them', () => {
    // Both are typed by hand and both are upper-case by convention; rejecting
    // the case a keyboard is actually in rejects a correct answer.
    const branch = newBranchProfile(form({ invoicePrefix: ' kt ', gstin: '27aaccs4471m1zb' }), HQ, [HQ])
    expect(branch.invoicePrefix).toBe('KT')
    expect(branch.gstin).toBe('27AACCS4471M1ZB')
  })

  it('REFUSES a prefix another branch already issues', () => {
    // Two branches on one prefix issue the same invoice number twice.
    expect(code({ invoicePrefix: 'RX' })).toBe('PREFIX_TAKEN')
    expect(code({ invoicePrefix: 'rx' })).toBe('PREFIX_TAKEN')
  })

  it('refuses a prefix that cannot be part of a document number', () => {
    expect(code({ invoicePrefix: '' })).toBe('PREFIX_INVALID')
    expect(code({ invoicePrefix: '1ST' })).toBe('PREFIX_INVALID')
    expect(code({ invoicePrefix: 'TOOLONG' })).toBe('PREFIX_INVALID')
  })

  it('refuses to open a branch with no drug licence of its own', () => {
    // The licence is issued against premises. The head office's does not cover
    // the new counter, so it is required rather than inherited.
    expect(code({ dlNos: [] })).toBe('DL_REQUIRED')
    expect(code({ dlNos: ['   '] })).toBe('DL_REQUIRED')
  })

  it('refuses a GSTIN whose state disagrees with the state code', () => {
    expect(code({ stateCode: '29' })).toBe('GSTIN_STATE_MISMATCH')
    expect(code({ stateCode: '2' })).toBe('STATE_CODE_INVALID')
    expect(code({ gstin: '27AACCS4471M1Z' })).toBe('GSTIN_INVALID')
  })

  it('refuses a nameless, addressless or unreachable branch', () => {
    expect(code({ name: '  ' })).toBe('NAME_REQUIRED')
    expect(code({ name: 'sanjeevani medical store' })).toBe('NAME_TAKEN')
    expect(code({ addressLine: '' })).toBe('ADDRESS_REQUIRED')
    expect(code({ city: '' })).toBe('ADDRESS_REQUIRED')
    expect(code({ phone: '' })).toBe('PHONE_REQUIRED')
  })

  it('refuses a UPI id that would take that branch\'s money nowhere', () => {
    expect(code({ upiVpa: 'not-a-vpa' })).toBe('VPA_INVALID')
    expect(newBranchProfile(form({ upiVpa: 'kothrud@okaxis' }), HQ, [HQ]).upiVpa)
      .toBe('kothrud@okaxis')
  })

  it('turns an empty UPI id into NULL, not an empty string', () => {
    // The receipt asks `if (store.upiVpa)`; a blank prints a QR pointing nowhere.
    expect(newBranchProfile(form({ upiVpa: '' }), HQ, [HQ]).upiVpa).toBeNull()
  })

  it('names the field a refusal belongs to, so the form can mark it', () => {
    try {
      newBranchProfile(form({ invoicePrefix: 'RX' }), HQ, [HQ])
      expect.unreachable('a taken prefix must be refused')
    } catch (e) {
      expect((e as ApiError).details).toEqual({ field: 'invoicePrefix' })
    }
  })
})

describe('branch ids', () => {
  it('never reuses one, because every transactional row carries it', () => {
    // A reused id inherits the closed shop's stock, bills and day close.
    expect(nextBranchId([HQ])).toBe(2)
    expect(nextBranchId([HQ, { ...HQ, id: 7 }])).toBe(8)
    expect(nextBranchId([])).toBe(1)
  })
})

describe('what opening a branch does elsewhere', () => {
  it('always says the catalogue comes across and the stock does not', () => {
    expect(branchConsequences(form(), HQ).join(' ')).toMatch(/same catalogue and no stock/)
  })

  it('says when a branch is filing under the head office registration', () => {
    expect(branchConsequences(form(), HQ).join(' ')).toMatch(/files under the same GSTIN/)
    expect(branchConsequences(form({ gstin: '29AACCS4471M1ZB' }), HQ).join(' '))
      .not.toMatch(/files under the same GSTIN/)
  })

  it('says a branch with no UPI id prints no QR', () => {
    expect(branchConsequences(form(), HQ).join(' ')).toMatch(/without a payment QR/)
    expect(branchConsequences(form({ upiVpa: 'kothrud@okaxis' }), HQ).join(' '))
      .not.toMatch(/without a payment QR/)
  })
})

describe('the form a branch starts from', () => {
  it('inherits the state and the registration, and never the identity', () => {
    const t = branchTemplate(HQ)
    expect(t.state).toBe('Maharashtra')
    expect(t.stateCode).toBe('27')
    expect(t.gstin).toBe(HQ.gstin)
    expect(t.name).toBe('')
    expect(t.invoicePrefix).toBe('')
    expect(t.dlNos).toEqual([''])
  })
})
