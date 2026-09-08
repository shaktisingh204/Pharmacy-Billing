import { describe, expect, it } from 'vitest'
import { formatAmount, formatExpiry, formatMoney, formatQty, daysUntil } from './format'
import { expiryBucket } from './expiry'

describe('money formatting', () => {
  it('uses Indian grouping, not thousands', () => {
    // 12 lakh, not 1,234,567 — a Western grouping is immediately wrong to a
    // pharmacist reading a day book.
    expect(formatMoney('1234567.89')).toBe('₹12,34,567.89')
    expect(formatAmount('1234567.89')).toBe('12,34,567.89')
  })

  it('always shows two decimals', () => {
    expect(formatMoney('99')).toBe('₹99.00')
    expect(formatMoney(0)).toBe('₹0.00')
  })

  it('accepts the decimal STRINGS the API sends', () => {
    expect(formatMoney('1284.50')).toBe('₹1,284.50')
  })

  it('renders unparseable values as an em dash, never NaN', () => {
    expect(formatMoney('not-a-number')).toBe('—')
    expect(formatQty('')).toBe('—')
  })
})

describe('expiry', () => {
  const today = new Date(2026, 8, 8) // 8 Sep 2026

  it('renders a printed expiry as a month, not a day', () => {
    expect(formatExpiry('2027-11-30')).toBe('11/27')
  })

  it('buckets by days remaining', () => {
    expect(expiryBucket('2026-08-01', today)).toBe('expired')
    expect(expiryBucket('2026-09-20', today)).toBe('d30')
    expect(expiryBucket('2026-10-25', today)).toBe('d60')
    expect(expiryBucket('2026-11-20', today)).toBe('d90')
    expect(expiryBucket('2027-02-01', today)).toBe('d180')
    expect(expiryBucket('2028-01-01', today)).toBe('ok')
  })

  it('treats today as not yet expired', () => {
    expect(daysUntil('2026-09-08', today)).toBe(0)
    expect(expiryBucket('2026-09-08', today)).toBe('d30')
  })
})
