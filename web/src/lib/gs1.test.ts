import { describe, expect, it } from 'vitest'
import { ean13CheckDigit, isValidEan13, parseGs1 } from './gs1'

const GS = '\x1D'
/** GTIN-14 for the EAN-13 8901234567890 — an Indian (890) pack prefix. */
const GTIN = '08901234567890'

describe('GS1 element strings', () => {
  it('stops a variable-length batch at the FNC1, leaving the expiry intact', () => {
    // The shape a pharma DataMatrix actually has: GTIN, batch, separator, expiry.
    const g = parseGs1(`01${GTIN}10MFL2214${GS}17271130`)

    expect(g.gtin).toBe(GTIN)
    expect(g.batch).toBe('MFL2214')
    expect(g.expiry).toBe('2027-11-30')
    expect(g.unparsed).toEqual([])
  })

  it('lets the batch run to the end when the FNC1 was lost on the way in', () => {
    // This is the payload the same pack produces when the separator keystroke is
    // dropped. There is no honest way to recover: "MFL221417271130" is a legal
    // batch number. We keep it whole and report no expiry rather than guessing
    // one — a guessed expiry prints on the bill and drives FEFO.
    const g = parseGs1(`01${GTIN}10MFL221417271130`)

    expect(g.gtin).toBe(GTIN)
    expect(g.batch).toBe('MFL221417271130')
    expect(g.expiry).toBeUndefined()
  })

  it('reads a fixed-length AI without needing a separator after it', () => {
    const g = parseGs1(`01${GTIN}17271130`)

    expect(g.gtin).toBe(GTIN)
    expect(g.expiry).toBe('2027-11-30')
  })

  it('keeps a serial and a batch apart', () => {
    const g = parseGs1(`01${GTIN}21SN0001${GS}10MFL2214`)

    expect(g.serial).toBe('SN0001')
    expect(g.batch).toBe('MFL2214')
  })

  it('tolerates a leading and a doubled separator', () => {
    const g = parseGs1(`${GS}01${GTIN}${GS}${GS}10MFL2214`)

    expect(g.gtin).toBe(GTIN)
    expect(g.batch).toBe('MFL2214')
  })

  it('accepts the human-readable bracket form', () => {
    const g = parseGs1('(01)08901234567890(17)271130(10)MFL2214')

    expect(g.gtin).toBe(GTIN)
    expect(g.expiry).toBe('2027-11-30')
    expect(g.batch).toBe('MFL2214')
  })

  it('files an AI it does not model under unparsed, correctly delimited', () => {
    // 3103 is a 4-digit AI with a 6-digit value; getting its length wrong would
    // eat the batch that follows.
    const g = parseGs1(`01${GTIN}310300075010MFL2214`)

    expect(g.unparsed).toEqual(['3103000750'])
    expect(g.batch).toBe('MFL2214')
  })

  it('reads past a 3-digit AI in the 70-block', () => {
    // 710–716 are the only 3-digit AIs among the 70xx/72xx four-digit ones. Read
    // 710 as four digits and the AI stops parsing, taking the batch and the
    // expiry behind it into unparsed.
    const g = parseGs1(`01${GTIN}710PZN123${GS}10MFL2214${GS}17271130`)

    expect(g.batch).toBe('MFL2214')
    expect(g.expiry).toBe('2027-11-30')
    expect(g.unparsed).toEqual(['710PZN123'])
  })

  it('does not mistake a bracket in a batch number for the bracket form', () => {
    // '(' is a legal CSET 82 character, so this is the raw form despite it.
    const g = parseGs1(`01${GTIN}10AB(1)CD${GS}17271130`)

    expect(g.batch).toBe('AB(1)CD')
    expect(g.expiry).toBe('2027-11-30')
  })

  it('keeps a separator out of a bracket-form value', () => {
    // A wedge set to the bracket form still types the FNC1; the parens already
    // delimit, and a batch of "MFL2214\x1D" matches nothing on file.
    const g = parseGs1(`(01)08901234567890(17)271130(10)MFL2214${GS}`)

    expect(g.batch).toBe('MFL2214')
    expect(g.expiry).toBe('2027-11-30')
  })

  it('keeps an unreadable tail rather than inventing element strings', () => {
    const g = parseGs1(`01${GTIN}XX99`)

    expect(g.gtin).toBe(GTIN)
    expect(g.unparsed).toEqual(['XX99'])
  })
})

describe('AI 17 expiry dates', () => {
  it('resolves DD=00 to the last day of the month', () => {
    // The common case: a printed pharmacy expiry is a month, not a day.
    expect(parseGs1(`17271100`).expiry).toBe('2027-11-30')
    expect(parseGs1(`17271200`).expiry).toBe('2027-12-31')
  })

  it('gets February right in and out of a leap year', () => {
    expect(parseGs1(`17240200`).expiry).toBe('2024-02-29')
    expect(parseGs1(`17230200`).expiry).toBe('2023-02-28')
    expect(parseGs1(`17000200`).expiry).toBe('2000-02-29')
  })

  it('maps YY into the 2000s', () => {
    expect(parseGs1(`17991231`).expiry).toBe('2099-12-31')
  })

  it('rejects an impossible date instead of shifting it', () => {
    expect(parseGs1(`17271330`).expiry).toBeUndefined()
    expect(parseGs1(`17271330`).unparsed).toEqual(['17271330'])
    expect(parseGs1(`17230230`).expiry).toBeUndefined()
  })

  it('reads AI 11 as a production date', () => {
    expect(parseGs1(`11250315`).productionDate).toBe('2025-03-15')
  })
})

describe('EAN-13 check digit', () => {
  it('computes the digit that completes the sum to a multiple of ten', () => {
    expect(ean13CheckDigit('890123456789')).toBe('0')
    expect(ean13CheckDigit('590123412345')).toBe('7')
  })

  it('accepts a valid code and rejects a mistyped one', () => {
    expect(isValidEan13('8901234567890')).toBe(true)
    expect(isValidEan13('5901234123457')).toBe(true)
    // A single transposed digit is exactly what the check digit exists to catch.
    expect(isValidEan13('8901234567891')).toBe(false)
    expect(isValidEan13('8901234576890')).toBe(false)
  })

  it('rejects anything that is not thirteen digits', () => {
    expect(isValidEan13('890123456789')).toBe(false)
    expect(isValidEan13('89012345678901')).toBe(false)
    expect(isValidEan13('890123456789X')).toBe(false)
    expect(ean13CheckDigit('89012345678')).toBe('')
  })
})
