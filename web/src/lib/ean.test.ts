import { describe, expect, it } from 'vitest'
import { barsOf, eanCheckDigit, encodeEan } from './ean'

/**
 * The encoding is a lookup table, so what is worth asserting is the shape of
 * the symbol and the refusals — a barcode that is drawn slightly wrong is a
 * label somebody prints, sticks on a pack and then cannot scan.
 */

/** A well-formed EAN-13: '890' (India), a maker prefix, a serial, check digit. */
const DOLO = '8901234567890'

describe('check digit', () => {
  it('computes the digit the standard prints', () => {
    expect(eanCheckDigit(DOLO.slice(0, 12))).toBe(0)
    expect(eanCheckDigit('123456789012')).toBe(8)
    // EAN-8 uses the same weighting over seven digits.
    expect(eanCheckDigit('9638507')).toBe(4)
  })

  it('refuses anything that is not digits', () => {
    expect(eanCheckDigit('89012A456789')).toBeNull()
  })
})

describe('encoding', () => {
  it('lays an EAN-13 out as 95 modules with three guards', () => {
    const symbol = encodeEan(DOLO)
    expect(symbol?.kind).toBe('EAN-13')
    expect(symbol?.modules).toHaveLength(95)
    expect(symbol?.modules.startsWith('101')).toBe(true)
    expect(symbol?.modules.endsWith('101')).toBe(true)
    expect(symbol?.modules.slice(45, 50)).toBe('01010')
    // 1 | 6 | 6, which is how a retail symbol prints its number.
    expect(symbol?.groups).toEqual(['8', '901234', '567890'])
    expect(symbol?.checkDigitValid).toBe(true)
  })

  it('encodes the thirteenth digit as the PARITY of the first six', () => {
    // Both numbers share every left-hand digit and differ only in the leading
    // one, so a symbol that ignored the parity table would draw them alike.
    const a = encodeEan('0901234567895')
    const b = encodeEan('9901234567890')
    expect(a?.modules).not.toBe(b?.modules)
    // Leading zero is UPC-A's parity row: all six left digits use the L set,
    // so the first of them — a 9 — is L[9] and not G[9].
    expect(a?.modules.slice(3, 10)).toBe('0001011')
  })

  it('lays an EAN-8 out as 67 modules', () => {
    const symbol = encodeEan('96385074')
    expect(symbol?.kind).toBe('EAN-8')
    expect(symbol?.modules).toHaveLength(67)
    expect(symbol?.groups).toEqual(['9638', '5074'])
  })

  it('normalises the forms that are the same article number', () => {
    // UPC-A and a zero-padded GTIN-14 are the 13-digit code, which is exactly
    // how a code scanned off a GS1 DataMatrix reaches the app.
    expect(encodeEan(`0${DOLO}`)?.modules).toBe(encodeEan(DOLO)?.modules)
    expect(encodeEan('012345678905')?.kind).toBe('EAN-13')
  })

  it('says so rather than drawing something plausible', () => {
    // A shop's own internal code and a genuine case code have no EAN symbol.
    expect(encodeEan('LOCAL-42')).toBeNull()
    expect(encodeEan('19012345678909')).toBeNull()
    expect(encodeEan('')).toBeNull()
  })

  it('carries a bad check digit through, flagged, instead of refusing it', () => {
    // The code is on file and has to be shown; what it must not do is look
    // correct. A mistyped digit is found by reading the flag, not by silence.
    const symbol = encodeEan('8901234567891')
    expect(symbol).not.toBeNull()
    expect(symbol?.checkDigitValid).toBe(false)
  })
})

describe('bars', () => {
  it('collapses runs so the SVG is rects, not modules', () => {
    expect(barsOf('101')).toEqual([{ x: 0, width: 1 }, { x: 2, width: 1 }])
    expect(barsOf('0011100')).toEqual([{ x: 2, width: 3 }])
    expect(barsOf('0000')).toEqual([])
  })

  it('covers every bar in a real symbol', () => {
    const symbol = encodeEan(DOLO)
    const bars = barsOf(symbol?.modules ?? '')
    const painted = bars.reduce((n, b) => n + b.width, 0)
    expect(painted).toBe([...(symbol?.modules ?? '')].filter((c) => c === '1').length)
  })
})
