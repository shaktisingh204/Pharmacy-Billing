import { describe, expect, it } from 'vitest'
import {
  VIZ_SEQ,
  VIZ_SLOTS,
  arcPath,
  compactINR,
  niceScale,
  polarToCartesian,
  seqStep,
} from './chartUtils'

describe('niceScale', () => {
  it('rounds a ragged maximum up to a round number', () => {
    // The amateur tell this exists to kill: an axis that stops at 4,873.
    const s = niceScale(4873)
    expect(s.max).toBe(5000)
    expect(s.ticks).toEqual([0, 1000, 2000, 3000, 4000, 5000])
  })

  it('always starts at zero and ends at the returned max', () => {
    for (const max of [3, 37, 412, 9_999, 1_250_000]) {
      const s = niceScale(max)
      expect(s.ticks[0]).toBe(0)
      expect(s.ticks[s.ticks.length - 1]).toBe(s.max)
      expect(s.max).toBeGreaterThanOrEqual(max)
    }
  })

  it('uses only 1 / 2 / 2.5 / 5 x 10^n steps', () => {
    const s = niceScale(12)
    expect(s.ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5])
  })

  it('produces exact tick values, not float dust', () => {
    // 0.1 * 3 is 0.30000000000000004, and that lands in an axis label.
    const s = niceScale(1)
    expect(s.ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(s.ticks.map(String)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1'])
  })

  it('handles a max of 0 without inventing fractional gridlines', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] })
  })

  it('treats negative and non-finite maxima as empty', () => {
    expect(niceScale(-5)).toEqual({ max: 1, ticks: [0, 1] })
    expect(niceScale(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] })
  })

  it('scales down to a single tiny value', () => {
    const s = niceScale(0.3)
    expect(s.max).toBe(0.3)
    expect(s.ticks).toEqual([0, 0.1, 0.2, 0.3])
  })

  it('honours a requested tick count', () => {
    expect(niceScale(100, 2).ticks.length).toBeLessThanOrEqual(4)
    expect(niceScale(100, 10).ticks.length).toBeGreaterThan(5)
  })
})

describe('compactINR', () => {
  it('stays plain below a thousand', () => {
    expect(compactINR(0)).toBe('0')
    expect(compactINR(999)).toBe('999')
  })

  it('switches to K at a thousand', () => {
    expect(compactINR(1000)).toBe('1K')
    expect(compactINR(1200)).toBe('1.2K')
    expect(compactINR(45_200)).toBe('45.2K')
  })

  it('counts in lakhs and crores, never millions', () => {
    expect(compactINR(100_000)).toBe('1L')
    expect(compactINR(180_000)).toBe('1.8L')
    expect(compactINR(10_000_000)).toBe('1Cr')
    expect(compactINR(20_500_000)).toBe('2.05Cr')
  })

  it('promotes a value that rounds into the next unit', () => {
    // 99,999 is one lakh to every reader; "100K" is a unit nobody uses here.
    expect(compactINR(99_999)).toBe('1L')
    expect(compactINR(9_999_999)).toBe('1Cr')
    expect(compactINR(999.6)).toBe('1K')
  })

  it('keeps about three significant digits and trims trailing zeros', () => {
    expect(compactINR(1_500)).toBe('1.5K')
    expect(compactINR(12_340)).toBe('12.3K')
    expect(compactINR(123_400)).toBe('1.23L')
    expect(compactINR(2_000_000)).toBe('20L')
  })

  it('carries the sign and rejects nonsense', () => {
    expect(compactINR(-45_200)).toBe('-45.2K')
    expect(compactINR(Number.NaN)).toBe('—')
    expect(compactINR(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('polarToCartesian', () => {
  it('puts 0 degrees at 12 o’clock and runs clockwise', () => {
    const top = polarToCartesian(50, 50, 10, 0)
    expect(top.x).toBeCloseTo(50)
    expect(top.y).toBeCloseTo(40)

    const right = polarToCartesian(50, 50, 10, 90)
    expect(right.x).toBeCloseTo(60)
    expect(right.y).toBeCloseTo(50)

    const bottom = polarToCartesian(50, 50, 10, 180)
    expect(bottom.y).toBeCloseTo(60)
  })
})

describe('arcPath', () => {
  it('sets the large-arc flag only past 180 degrees', () => {
    // The flag, not the sweep, is what breaks here: an arc command only says
    // "there is an ellipse through these two points".
    expect(arcPath(50, 50, 40, 24, 0, 179)).toContain('A 40 40 0 0 1')
    expect(arcPath(50, 50, 40, 24, 0, 181)).toContain('A 40 40 0 1 1')
  })

  it('keeps the flag consistent on both radii of one segment', () => {
    const d = arcPath(50, 50, 40, 24, 10, 250)
    expect(d).toContain('A 40 40 0 1 1')
    expect(d).toContain('A 24 24 0 1 0')
  })

  it('draws a full circle as two half arcs, with the hole wound the other way', () => {
    const d = arcPath(50, 50, 40, 24, 0, 360)
    // A single 360-degree arc has coincident endpoints and renders nothing.
    expect(d.match(/A /g)).toHaveLength(4)
    expect(d.match(/M /g)).toHaveLength(2)
    expect(d).toContain('A 40 40 0 1 1')
    expect(d).toContain('A 24 24 0 1 0')
  })

  it('draws a full pie (no hole) as a single closed circle', () => {
    const d = arcPath(50, 50, 40, 0, 0, 360)
    expect(d.match(/M /g)).toHaveLength(1)
    expect(d.match(/A /g)).toHaveLength(2)
  })

  it('returns a wedge from the centre when there is no inner radius', () => {
    expect(arcPath(50, 50, 40, 0, 0, 90)).toMatch(/^M 50 50 L /)
  })

  it('returns nothing for a zero, negative or degenerate sweep', () => {
    expect(arcPath(50, 50, 40, 24, 90, 90)).toBe('')
    expect(arcPath(50, 50, 40, 24, 90, 10)).toBe('')
    expect(arcPath(50, 50, 0, 0, 0, 90)).toBe('')
  })
})

describe('seqStep', () => {
  const darkest = VIZ_SEQ[5]

  it('gives the largest rank the darkest step', () => {
    expect(seqStep(0, 5)).toBe(darkest)
    expect(seqStep(0, 1)).toBe(darkest)
  })

  it('gets lighter as the rank grows', () => {
    const steps = [0, 1, 2, 3].map((r) => seqStep(r, 4)).map((c) => VIZ_SEQ.indexOf(c as never))
    expect(steps).toEqual([...steps].sort((a, b) => b - a))
    expect(new Set(steps).size).toBe(4)
  })

  it('never reaches for the palest step, which is invisible on a white card', () => {
    for (let n = 1; n <= 12; n += 1) {
      for (let i = 0; i < n; i += 1) {
        expect(seqStep(i, n)).not.toBe(VIZ_SEQ[0])
      }
    }
  })

  it('clamps at both ends rather than returning undefined', () => {
    expect(seqStep(-4, 3)).toBe(seqStep(0, 3))
    expect(seqStep(99, 3)).toBe(seqStep(2, 3))
    expect(seqStep(0, 0)).toBe(darkest)
    expect(seqStep(Number.NaN, 3)).toBe(seqStep(0, 3))
  })
})

describe('palette', () => {
  it('exposes five categorical slots and six sequential steps', () => {
    expect(VIZ_SLOTS).toHaveLength(5)
    expect(VIZ_SEQ).toHaveLength(6)
  })

  it('is tokens only — never a literal colour', () => {
    for (const c of [...VIZ_SLOTS, ...VIZ_SEQ]) expect(c).toMatch(/^var\(--viz-/)
  })
})
