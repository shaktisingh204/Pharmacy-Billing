import { describe, expect, it } from 'vitest'
import type { StoreProfile } from '@contract'
import { daysSince, openInSection, outstanding, readiness, readyCount } from './readiness'

const NOW = new Date('2026-09-09T10:00:00.000Z')

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
  nearExpiryBuckets: [180, 90, 60, 30],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: 'sanjeevani@okhdfc',
  footerNote: 'Store below 25°C.',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

const run = (over: Partial<StoreProfile> = {}, extra: Partial<{
  printerConfigured: boolean
  lastBackupAt: string | null
}> = {}) => readiness({
  store: { ...STORE, ...over },
  printerConfigured: true,
  lastBackupAt: '2026-09-08T10:00:00.000Z',
  now: NOW,
  ...extra,
})

const open = (over: Partial<StoreProfile> = {}, extra = {}) =>
  outstanding(run(over, extra)).map((c) => c.id)

describe('is this shop ready to bill', () => {
  it('a fully set-up shop has nothing outstanding', () => {
    const checks = run()
    expect(outstanding(checks)).toEqual([])
    expect(readyCount(checks)).toBe(checks.length)
  })

  it('catches the things that make a bill non-compliant', () => {
    expect(open({ dlNos: [] })).toEqual(['licence'])
    expect(open({ dlNos: ['  '] })).toEqual(['licence'])
    expect(open({ gstin: 'not-a-gstin' })).toEqual(['gstin'])
    expect(open({ addressLine: '' })).toEqual(['address'])
    expect(open({ phone: '   ' })).toEqual(['phone'])
  })

  it('catches a GSTIN and a state code that disagree, which neither field shows alone', () => {
    // Both fields look right on their own screen; the bill is taxed against one
    // state and filed against the other.
    const [check] = outstanding(run({ stateCode: '29' }))
    expect(check?.id).toBe('gstin')
    expect(check?.detail).toMatch(/taxed against one state and filed against the other/)
  })

  it('treats a malformed UPI id as no UPI id, because the QR would take money nowhere', () => {
    expect(open({ upiVpa: 'not-a-vpa' })).toEqual(['upi'])
    expect(open({ upiVpa: null })).toEqual(['upi'])
  })

  it('counts a missing printer and a missing backup, which are per machine', () => {
    expect(open({}, { printerConfigured: false })).toEqual(['printer'])
    expect(open({}, { lastBackupAt: null })).toEqual(['backup'])
  })

  it('treats a week-old backup as still good and an older one as none', () => {
    expect(open({}, { lastBackupAt: '2026-09-02T10:00:00.000Z' })).toEqual([])
    expect(open({}, { lastBackupAt: '2026-09-01T09:00:00.000Z' })).toEqual(['backup'])
    const [stale] = outstanding(run({}, { lastBackupAt: '2026-07-01T10:00:00.000Z' }))
    expect(stale?.detail).toMatch(/days of bills exist nowhere else/)
  })

  it('routes every outstanding item to the panel that fixes it', () => {
    const checks = run({ dlNos: [], upiVpa: null }, { printerConfigured: false })
    expect(openInSection(checks, 'store')).toBe(1)
    expect(openInSection(checks, 'payments')).toBe(1)
    expect(openInSection(checks, 'printing')).toBe(1)
    expect(openInSection(checks, 'branding')).toBe(0)
  })

  it('shows the value itself once a check passes, not just a tick', () => {
    const gstin = run().find((c) => c.id === 'gstin')
    expect(gstin?.detail).toBe('27AACCS4471M1ZB')
  })
})

describe('daysSince', () => {
  it('is null for a machine that has never taken a backup', () => {
    expect(daysSince(null, NOW)).toBeNull()
    expect(daysSince('', NOW)).toBeNull()
    expect(daysSince('yesterday', NOW)).toBeNull()
  })

  it('counts whole days', () => {
    expect(daysSince('2026-09-09T09:00:00.000Z', NOW)).toBe(0)
    expect(daysSince('2026-09-07T09:00:00.000Z', NOW)).toBe(2)
  })
})
