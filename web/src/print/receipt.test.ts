import { describe, expect, it } from 'vitest'
import { RECEIPT_COLUMNS, amountInWords, fitCell, gridRow, ruleLine } from './index'

describe('amountInWords', () => {
  it('spells the whole rupees', () => {
    expect(amountInWords('0')).toBe('Zero Rupees Only')
    expect(amountInWords('0.00')).toBe('Zero Rupees Only')
    expect(amountInWords('15')).toBe('Fifteen Rupees Only')
    expect(amountInWords('100')).toBe('One Hundred Rupees Only')
    expect(amountInWords('999')).toBe('Nine Hundred Ninety Nine Rupees Only')
    expect(amountInWords('1000')).toBe('One Thousand Rupees Only')
    expect(amountInWords('1234')).toBe('One Thousand Two Hundred Thirty Four Rupees Only')
  })

  it('uses the Indian system: lakh and crore, never "million"', () => {
    expect(amountInWords('100000')).toBe('One Lakh Rupees Only')
    expect(amountInWords('1234567.89')).toBe(
      'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Eighty Nine Paise Only',
    )
    expect(amountInWords('123456.78')).toBe(
      'One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy Eight Paise Only',
    )
    expect(amountInWords('12345678')).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only',
    )
    // Above 99 crore the crore group spells itself, rather than running out of
    // names the way a fixed lakh/crore/arab table does.
    expect(amountInWords('1000000000')).toBe('One Hundred Crore Rupees Only')
  })

  it('is singular at exactly one', () => {
    expect(amountInWords('1')).toBe('One Rupee Only')
    expect(amountInWords('1.00')).toBe('One Rupee Only')
    expect(amountInWords('0.01')).toBe('One Paisa Only')
  })

  it('pads a short paise field rather than reading it as tens', () => {
    // "1234.5" is fifty paise, not five. Reading the digit as-is short-changes
    // the customer by 45 paise on a bill that already footed correctly.
    expect(amountInWords('1234.5')).toBe(
      'One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only',
    )
    expect(amountInWords('0.50')).toBe('Fifty Paise Only')
    expect(amountInWords('0.5')).toBe('Fifty Paise Only')
  })

  it('rounds the third decimal half AWAY from zero, and carries', () => {
    // A percentage discount produces a third decimal. IEEE-754 would round
    // 99.995 to even; the statutory rule takes it up.
    expect(amountInWords('99.995')).toBe('One Hundred Rupees Only')
    expect(amountInWords('1.004')).toBe('One Rupee Only')
    expect(amountInWords('0.004')).toBe('Zero Rupees Only')
    expect(amountInWords('0.005')).toBe('One Paisa Only')
  })

  it('handles a credit note amount', () => {
    expect(amountInWords('-1234.50')).toBe(
      'Minus One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only',
    )
  })

  it('renders an unparseable amount as an em dash, never as "NaN Rupees"', () => {
    expect(amountInWords('')).toBe('—')
    expect(amountInWords('not-a-number')).toBe('—')
    expect(amountInWords('1,234.50')).toBe('—')
  })
})

describe('the 42-column grid', () => {
  it('is 42 columns wide', () => {
    expect(RECEIPT_COLUMNS).toBe(42)
    expect(ruleLine()).toHaveLength(42)
  })

  it('pads to exactly the cell width', () => {
    expect(fitCell('Dolo', 10)).toBe('Dolo      ')
    expect(fitCell('60.00', 11, 'right')).toBe('      60.00')
    expect(fitCell('exact', 5)).toBe('exact')
    expect(fitCell('anything', 0)).toBe('')
  })

  it('marks a truncated name instead of clipping it silently', () => {
    // A brand name longer than the column budget is the normal case, not the
    // edge case: "AZITHROMYCIN 500MG TAB 5S" does not fit any thermal roll.
    const cell = fitCell('AZITHROMYCIN 500MG TAB 5S', 12)
    expect(cell).toBe('AZITHROMYCI…')
    expect(cell).toHaveLength(12)
    expect(fitCell('abc', 1)).toBe('…')
  })

  it('right-aligns the value and always fills the line', () => {
    const row = gridRow('Gross', '1,284.50')
    expect(row).toHaveLength(RECEIPT_COLUMNS)
    expect(row.startsWith('Gross ')).toBe(true)
    expect(row.endsWith('1,284.50')).toBe(true)
  })

  it('keeps the value whole when the label is too long for the line', () => {
    const row = gridRow('Bill discount on a very long promotional scheme name', '99.00')
    expect(row).toHaveLength(RECEIPT_COLUMNS)
    expect(row.endsWith('99.00')).toBe(true)
    expect(row).toContain('…')
  })

  it('holds the grid at a 32-column 58mm profile', () => {
    expect(gridRow('Round off', '-0.50', 32)).toHaveLength(32)
    expect(ruleLine(32)).toHaveLength(32)
  })
})
