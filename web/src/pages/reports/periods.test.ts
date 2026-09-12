import { describe, expect, it } from 'vitest'
import {
  PRESETS, dayCount, defaultRange, describeRange, presetKeyFor, previousRange, rangeOfPreset,
} from './periods'

/** A Tuesday, mid-month, so a preset that reaches backwards crosses a boundary. */
const TODAY = new Date(2026, 8, 8)

describe('presets', () => {
  it('opens on month-to-date, which is where both questions land', () => {
    expect(defaultRange(TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-08' })
  })

  it('gives last month its whole self, not the same day range shifted back', () => {
    expect(rangeOfPreset('lastMonth', TODAY)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('recognises a range it produced, and refuses to claim one it did not', () => {
    expect(presetKeyFor({ from: '2026-09-01', to: '2026-09-08' }, TODAY)).toBe('month')
    // 2-8 September IS the 7-day preset; a hand-picked window is not.
    expect(presetKeyFor({ from: '2026-09-02', to: '2026-09-08' }, TODAY)).toBe('week')
    expect(presetKeyFor({ from: '2026-09-03', to: '2026-09-08' }, TODAY)).toBeNull()
  })

  it('every preset is reachable by its own key', () => {
    for (const p of PRESETS) expect(rangeOfPreset(p.key, TODAY)).toEqual(p.range(TODAY))
  })
})

describe('previousRange', () => {
  it('is the same number of days, ending the day before', () => {
    // Eight days of September compare against 24-31 August, not against the
    // whole of August: comparing 8 days with 31 is not a comparison.
    expect(previousRange({ from: '2026-09-01', to: '2026-09-08' }))
      .toEqual({ from: '2026-08-24', to: '2026-08-31' })
  })

  it('handles a single day and a leap day without losing one', () => {
    expect(previousRange({ from: '2026-09-08', to: '2026-09-08' }))
      .toEqual({ from: '2026-09-07', to: '2026-09-07' })
    // 31 days ending 29 February, in a leap year: the previous window reaches
    // back into January rather than assuming a month is a month.
    expect(previousRange({ from: '2028-03-01', to: '2028-03-31' }))
      .toEqual({ from: '2028-01-30', to: '2028-02-29' })
  })

  it('counts days inclusively, so one day is one day', () => {
    expect(dayCount('2026-09-08', '2026-09-08')).toBe(1)
    expect(dayCount('2026-09-01', '2026-09-30')).toBe(30)
  })
})

describe('describeRange', () => {
  it('says the month once when the range sits inside one', () => {
    expect(describeRange({ from: '2026-09-01', to: '2026-09-08' })).toBe('1–8 Sep 2026')
  })

  it('names both months across a boundary, and both years across a new year', () => {
    expect(describeRange({ from: '2026-08-24', to: '2026-09-08' })).toBe('24 Aug – 8 Sep 2026')
    expect(describeRange({ from: '2025-12-28', to: '2026-01-03' }))
      .toBe('28 Dec 2025 – 3 Jan 2026')
  })

  it('reads a single day as a day', () => {
    expect(describeRange({ from: '2026-09-08', to: '2026-09-08' })).toBe('8 Sep 2026')
  })
})
