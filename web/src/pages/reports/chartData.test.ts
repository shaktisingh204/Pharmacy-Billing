import { describe, expect, it } from 'vitest'
import type { ReportColumn, ReportRow } from '@contract'
import { buildSeries, chartDimensions, chartMeasures, defaultAxes } from './chartData'

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', kind: 'date' },
  { key: 'medicine', label: 'Medicine', kind: 'text' },
  { key: 'company', label: 'Company', kind: 'text' },
  { key: 'net', label: 'Sale value ₹', kind: 'money', total: true },
  { key: 'gpPct', label: 'GP %', kind: 'pct' },
  { key: 'bills', label: 'Bills', kind: 'count' },
]

const row = (key: string, cells: Record<string, string | null>): ReportRow => ({ key, cells })

const rows: ReportRow[] = [
  row('a', { date: '2026-09-01', medicine: 'Calpol', company: 'GSK', net: '400.00' }),
  row('b', { date: '2026-09-02', medicine: 'Dolo', company: 'Micro', net: '250.00' }),
  row('c', { date: '2026-09-02', medicine: 'Crocin', company: 'GSK', net: '100.00' }),
]

describe('axis discovery', () => {
  it('measures only what the report itself agreed to foot', () => {
    // `bills` is a count with no total flag and `gpPct` is an average: summing
    // either here would print a figure the footer deliberately refuses to.
    expect(chartMeasures(columns).map((m) => m.key)).toEqual(['net'])
  })

  it('offers only dimensions that actually split the rows', () => {
    const keys = chartDimensions(columns, rows).map((d) => d.key)
    expect(keys).toContain('company')
    expect(keys).toContain('date')
    expect(keys).not.toContain('net')

    const single = [row('x', { company: 'GSK', net: '1.00' }), row('y', { company: 'GSK', net: '2.00' })]
    expect(chartDimensions(columns, single).map((d) => d.key)).not.toContain('company')
  })

  it('gives each report the first cut worth looking at', () => {
    expect(defaultAxes('ITEM_SALES', columns, rows)).toEqual({
      measure: { key: 'net', label: 'Sale value ₹', kind: 'money' },
      dimension: { key: 'medicine', label: 'Medicine', kind: 'text' },
    })
    // An id with no opinion still gets a usable pair rather than nothing.
    expect(defaultAxes('H1_REGISTER', columns, rows)?.measure.key).toBe('net')
    expect(defaultAxes('ITEM_SALES', columns, [])).toBeNull()
  })
})

describe('buildSeries', () => {
  const byCompany = { measure: chartMeasures(columns)[0]!, dimension: { key: 'company', label: 'Company', kind: 'text' as const } }

  it('aggregates the rows on screen and keeps the exact total', () => {
    const s = buildSeries(rows, byCompany)
    expect(s.orientation).toBe('horizontal')
    expect(s.bars.map((b) => [b.label, b.exact])).toEqual([['GSK', '500.00'], ['Micro', '250.00']])
    expect(s.bars[0]?.hint).toBe('2 rows')
    expect(s.total).toBe('750.00')
    expect(s.omittedGroups).toBe(0)
  })

  it('ranks by the measure and reports the tail as a figure, never as a bar', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row(`r${i}`, { company: `C${i}`, net: `${(12 - i) * 100}.00` }))
    const s = buildSeries(many, byCompany, 3)
    expect(s.bars.map((b) => b.label)).toEqual(['C0', 'C1', 'C2'])
    expect(s.groups).toBe(12)
    expect(s.omittedGroups).toBe(9)
    // 900+800+…+100 = 4500 left out of 7800.
    expect(s.omitted).toBe('4500.00')
    expect(s.total).toBe('7800.00')
  })

  it('keeps a date dimension in chronological order, never re-sorted by size', () => {
    const s = buildSeries(rows, { measure: byCompany.measure, dimension: { key: 'date', label: 'Date', kind: 'date' } })
    expect(s.orientation).toBe('vertical')
    expect(s.bars.map((b) => b.label)).toEqual(['1 Sep', '2 Sep'])
    expect(s.bars[1]?.exact).toBe('350.00')
  })

  it('rolls a long run of days up to weeks rather than dropping two thirds of it', () => {
    // 40 trading days: labelling forty bars in a side panel is a smear, and
    // showing the last 31 would silently drop nine days of money.
    const days = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10)
      return row(`d${i}`, { date: d, net: '100.00' })
    })
    const s = buildSeries(days, {
      measure: byCompany.measure,
      dimension: { key: 'date', label: 'Date', kind: 'date' },
    })
    expect(s.grain).toBe('week')
    // 1 June 2026 is a Monday, so forty days is six weeks — five whole ones
    // and a part week, and the part week is a real week with real money in it.
    expect(s.bars.length).toBe(6)
    expect(s.omittedGroups).toBe(0)
    // Nothing is lost in the rollup: every rupee is still on the chart.
    expect(s.total).toBe('4000.00')
    expect(s.bars[0]?.hint).toContain('week of 1 Jun')
    expect(s.bars.reduce((sum, b) => sum + Number(b.exact), 0)).toBe(4000)
  })

  it('keeps a short run day by day', () => {
    const days = Array.from({ length: 5 }, (_, i) =>
      row(`d${i}`, { date: `2026-09-0${i + 1}`, net: '10.00' }))
    expect(buildSeries(days, {
      measure: byCompany.measure,
      dimension: { key: 'date', label: 'Date', kind: 'date' },
    }).grain).toBe('day')
  })

  it('counts what a magnitude bar cannot draw instead of drawing a zero', () => {
    const mixed = [
      row('a', { company: 'GSK', net: '400.00' }),
      row('b', { company: 'Micro', net: '-50.00' }),
      row('c', { company: 'Sun', net: '0.00' }),
    ]
    const s = buildSeries(mixed, byCompany)
    expect(s.bars.map((b) => b.label)).toEqual(['GSK'])
    expect(s.unplottable).toBe(2)
    // The total still counts them: the caption must not disagree with the footer.
    expect(s.total).toBe('350.00')
  })

  it('bands an empty cell rather than dropping the row', () => {
    const s = buildSeries([row('a', { company: '', net: '10.00' })], byCompany)
    expect(s.bars[0]?.label).toBe('(not set)')
  })
})
