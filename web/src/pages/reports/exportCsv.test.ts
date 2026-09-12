import { describe, expect, it } from 'vitest'
import type { ReportColumn, ReportResult, ReportRow } from '@contract'
import { csvCell, csvFilename, toCsv } from './exportCsv'

const COLUMNS: ReportColumn[] = [
  { key: 'medicine', label: 'Medicine', kind: 'text' },
  { key: 'batch', label: 'Batch', kind: 'code' },
  { key: 'expiry', label: 'Expiry', kind: 'expiry' },
  { key: 'atCost', label: 'At cost ₹', kind: 'money', total: true },
]

function result(rows: ReportRow[], over: Partial<ReportResult> = {}): ReportResult {
  return {
    reportId: 'STOCK_VALUATION',
    productName: 'RxBill',
    title: 'Stock valuation',
    question: 'What is on the shelves, and what it is worth.',
    from: '2026-09-01',
    to: '2026-09-30',
    basis: ['Landed cost, frozen at receipt.'],
    notes: [],
    generatedAt: '2026-09-08T12:00:00.000Z',
    columns: COLUMNS,
    rows,
    totals: { atCost: '1234.50' },
    headline: [],
    facetLabel: null,
    facets: [],
    checks: [],
    groupable: [],
    groupBy: null,
    groups: null,
    ...over,
  }
}

const row = (key: string, cells: Record<string, string | null>): ReportRow => ({ key, cells })

const body = (csv: string): string[] => {
  const lines = csv.split('\r\n')
  const blank = lines.indexOf('')
  return lines.slice(blank + 1).filter((l) => l !== '')
}

describe('csvCell', () => {
  it('quotes a field carrying a comma, a quote or a newline', () => {
    expect(csvCell('Crocin 650, strip')).toBe('"Crocin 650, strip"')
    expect(csvCell('Betnovate "N"')).toBe('"Betnovate ""N"""')
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('quotes edge whitespace a parser would otherwise trim away', () => {
    expect(csvCell(' AB-2214 ')).toBe('" AB-2214 "')
  })

  it('leaves an ordinary field alone', () => {
    expect(csvCell('Crocin 650')).toBe('Crocin 650')
    expect(csvCell('1284.50', 'money')).toBe('1284.50')
  })

  it('renders a missing value as empty rather than as zero', () => {
    expect(csvCell(null, 'money')).toBe('')
  })

  it('guards a code that Excel would turn into scientific notation', () => {
    // A 13-digit EAN reaches Excel as 8.90123E+12 without this.
    expect(csvCell('8901234567890', 'code')).toBe('="8901234567890"')
  })

  it('guards a leading zero and a date-shaped batch number', () => {
    expect(csvCell('0123', 'code')).toBe('="0123"')
    expect(csvCell('3-25', 'code')).toBe('="3-25"')
    expect(csvCell('10/24', 'code')).toBe('="10/24"')
  })

  it('does not guard a code Excel would leave alone', () => {
    expect(csvCell('AB-2214', 'code')).toBe('AB-2214')
    expect(csvCell('30049099', 'code')).toBe('30049099')
  })

  it('guards only inside a code column — a plain field is never rewritten', () => {
    expect(csvCell('8901234567890', 'text')).toBe('8901234567890')
  })
})

describe('toCsv', () => {
  const csv = toCsv(result([
    row('a', { medicine: 'Crocin 650', batch: 'AB-2214', expiry: '2027-11-30', atCost: '700.00' }),
    row('b', { medicine: 'Dolo, 650', batch: '0123', expiry: '2027-01-31', atCost: '534.50' }),
  ]))

  it('starts with a UTF-8 BOM, or Excel mis-decodes the rupee sign', () => {
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('At cost ₹')
  })

  it('uses CRLF, which is what RFC 4180 and Excel both expect', () => {
    expect(csv).toContain('\r\n')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('carries the manifest the accountant needs to reproduce the number', () => {
    expect(csv).toContain('"RxBill report",Stock valuation')
    expect(csv).toContain('"Period",2026-09-01 to 2026-09-30')
    expect(csv).toContain('"Basis","Landed cost, frozen at receipt."')
    expect(csv).toContain('"Generated at",2026-09-08T12:00:00.000Z')
    expect(csv).toContain('"Rows",2')
    expect(csv).toContain('"Control total — At cost ₹",1234.50')
  })

  it('writes the header, the rows and a footed total in column order', () => {
    expect(body(csv)).toEqual([
      'Medicine,Batch,Expiry,At cost ₹',
      'Crocin 650,AB-2214,2027-11-30,700.00',
      '"Dolo, 650",="0123",2027-01-31,534.50',
      'TOTAL,,,1234.50',
    ])
  })

  it('exports the reconciliation, and says so in words when it does not balance', () => {
    const broken = toCsv(result([], {
      checks: [{
        label: 'Taxable value',
        leftLabel: 'Rate rows',
        left: '250.00',
        rightLabel: 'Bill lines',
        right: '249.00',
        difference: '1.00',
        balanced: false,
        explain: 'Both describe the same supplies.',
      }],
    }))
    expect(broken).toContain('DOES NOT BALANCE')
    expect(broken).toContain('difference 1.00')
  })

  it('emits an empty cell for a row that has nothing in that column', () => {
    const sparse = toCsv(result([row('a', { medicine: 'Crocin 650' })]))
    expect(body(sparse)[1]).toBe('Crocin 650,,,')
  })
})

describe('csvFilename', () => {
  it('names the file after the report and the period it covers', () => {
    expect(csvFilename(result([]))).toBe('rxbill-stock-valuation-2026-09-01_2026-09-30.csv')
  })

  it('survives a title with punctuation in it', () => {
    expect(csvFilename(result([], { title: 'GST rate-wise summary' })))
      .toBe('rxbill-gst-rate-wise-summary-2026-09-01_2026-09-30.csv')
  })
})

describe('formula injection', () => {
  it('neutralises a name that would execute, and leaves every negative alone', () => {
    // Master data is typed by shop staff; it is the untrusted input here.
    expect(csvCell('=1+1', 'text')).toBe('="=1+1"')
    expect(csvCell('@SUM(A1:A9)', 'text')).toBe('="@SUM(A1:A9)"')
    expect(csvCell('+91-98765', 'text')).toBe('="+91-98765"')

    // Money never reaches the guard, so a credit balance still sums in Excel.
    expect(csvCell('-1240.00', 'money')).toBe('-1240.00')
    expect(csvCell('-31.60', 'qty')).toBe('-31.60')
    // Nor does a hyphenated name become text: a leading minus is not arithmetic.
    expect(csvCell('Anne-Marie', 'text')).toBe('Anne-Marie')
  })
})
