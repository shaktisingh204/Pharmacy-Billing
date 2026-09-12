import { describe, expect, it } from 'vitest'
import type {
  Customer, CustomerReceipt, PaymentInput, QuoteLine, SaleInvoice,
} from '@contract'
import { buildRows } from '@/api/customers'
import type { CustomerRow } from '@/api/customers'
import {
  addDays, buildProfiles, countSegments, cycleOf, daysBetween, profileOf, refillsDue, toIsoDate,
} from './profile'
import { statementCsv, statementFilename, statementOf } from './statement'
import { ageOn, birthdaysDue, isDob, nextBirthday } from './careFile'
import { callListCsv, callListText, toCallRows, whenWords } from './callList'

/**
 * The buying half of the customer screen, exercised as values.
 *
 * Four of these encode rules that are silently wrong rather than loudly broken
 * when they go the other way — a cycle predicted off two purchases, a voided
 * bill voting on a refill date, a statement opened at a zero it invented, and a
 * cash bill listed on a statement of the account — so they are asserted on
 * numbers a person can check by hand.
 */

const TODAY = new Date('2026-09-09T10:00:00')

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    storeId: 1,
    name: 'Ramesh Kulkarni',
    phone: '9822041100',
    address: 'Deccan, Pune',
    gstin: null,
    allergies: ['Penicillin'],
    creditLimit: '5000.00',
    outstanding: '0.00',
    ...over,
  }
}

function line(over: Partial<QuoteLine> & { medicineId: number }): QuoteLine {
  return {
    lineId: `L${over.medicineId}`,
    brandName: `Brand ${over.medicineId}`,
    packLabel: '10 tablets',
    hsnCode: '3004',
    drugSchedule: 'H',
    requestedQty: '10',
    allocatedQty: '10',
    shortQty: '0',
    allocations: [],
    discountPct: '0',
    grossAmount: '100.00',
    discountAmount: '0.00',
    taxableValue: '100.00',
    cgst: '0.00',
    sgst: '0.00',
    igst: '0.00',
    lineTotal: '100.00',
    manualBatch: false,
    ...over,
  }
}

function bill(over: {
  id: number
  invoiceDate: string
  credit?: string
  cash?: string
  net?: string
  lines?: QuoteLine[]
  status?: 'POSTED' | 'VOIDED'
  prescriber?: string
}): SaleInvoice {
  const payments: PaymentInput[] = []
  if (over.cash) payments.push({ mode: 'CASH', amount: over.cash })
  if (over.credit) payments.push({ mode: 'CREDIT', amount: over.credit })
  return {
    id: over.id,
    invoiceNo: `INV-${over.id}`,
    storeId: 1,
    terminalId: 1,
    invoiceDate: over.invoiceDate,
    createdAt: `${over.invoiceDate}T11:00:00.000Z`,
    customerId: 1,
    customerName: 'Ramesh Kulkarni',
    customerPhone: '9822041100',
    interState: false,
    quote: {
      lines: over.lines ?? [],
      grossAmount: '0.00', itemDiscount: '0.00', billDiscountPct: '0', billDiscount: '0.00',
      taxableValue: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', roundOff: '0.00',
      netAmount: over.net ?? over.credit ?? over.cash ?? '0.00',
      taxBreakup: [], warnings: [], costOfGoods: '0.00',
    },
    payments,
    amountPaid: over.cash ?? '0.00',
    changeDue: '0.00',
    status: over.status ?? 'POSTED',
    prescription: over.prescriber
      ? {
        prescriberName: over.prescriber,
        patientName: 'Ramesh Kulkarni',
        prescriptionDate: over.invoiceDate,
      }
      : null,
    operatorName: 'Counter 1',
  }
}

function receipt(over: Partial<CustomerReceipt> = {}): CustomerReceipt {
  return {
    id: 1,
    storeId: 1,
    receiptNo: 'RC2627-00001',
    customerId: 1,
    at: '2026-09-01T09:00:00.000Z',
    date: '2026-09-01',
    amount: '500.00',
    mode: 'CASH',
    reference: null,
    note: null,
    balanceAfter: '0.00',
    ...over,
  }
}

/**
 * One row, assembled the way the screen assembles it.
 *
 * The bills and receipts are re-pointed at this customer: `buildRows` groups on
 * `customerId`, so a fixture built for customer 1 and handed to customer 2 would
 * silently produce an account with no history and a test that passes for the
 * wrong reason.
 */
function rowOf(
  c: Customer,
  bills: SaleInvoice[],
  receipts: CustomerReceipt[] = [],
): CustomerRow {
  const rows = buildRows(
    [c],
    bills.map((b) => ({ ...b, customerId: c.id })),
    receipts.map((r) => ({ ...r, customerId: c.id })),
    TODAY,
  )
  const row = rows[0]
  if (!row) throw new Error('buildRows returned nothing')
  return row
}

// ---------------------------------------------------------------- calendar ---

describe('calendar helpers', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02')
  })

  it('refuses to fabricate a date from an unreadable one', () => {
    expect(addDays('not-a-date', 3)).toBeNull()
    expect(daysBetween('not-a-date', '2026-09-09')).toBeNull()
  })

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-08-10', '2026-09-09')).toBe(30)
    expect(daysBetween('2026-09-09', '2026-08-10')).toBe(-30)
  })

  it('round-trips a Date to an ISO day', () => {
    expect(toIsoDate(new Date(2026, 8, 9))).toBe('2026-09-09')
  })
})

// ------------------------------------------------------------------- cycle ---

describe('cycleOf', () => {
  it('refuses to call two purchases a rhythm', () => {
    // One gap is a single number, and predicting off it is guessing.
    expect(cycleOf(['2026-07-10', '2026-08-09'])).toBeNull()
  })

  it('takes the MEDIAN gap, so one delayed refill does not move the date', () => {
    // 30, 30, 61 — the mean is 40, which no refill ever was.
    const cycle = cycleOf(['2026-05-01', '2026-05-31', '2026-06-30', '2026-08-30'])
    expect(cycle?.days).toBe(30)
  })

  it('reports gaps that agree as steady and gaps that do not as loose', () => {
    expect(cycleOf(['2026-06-01', '2026-07-01', '2026-07-31'])?.steady).toBe(true)
    expect(cycleOf(['2026-06-01', '2026-06-15', '2026-09-01'])?.steady).toBe(false)
  })

  it('ignores a repeat too tight to be a refill and a gap too wide to be a rhythm', () => {
    expect(cycleOf(['2026-09-01', '2026-09-04', '2026-09-07'])).toBeNull()
    expect(cycleOf(['2025-01-01', '2025-09-01', '2026-05-01'])).toBeNull()
  })

  it('counts one date once, however many lines it appeared on', () => {
    const cycle = cycleOf(['2026-07-01', '2026-07-01', '2026-07-31', '2026-08-30'])
    expect(cycle?.samples).toBe(2)
    expect(cycle?.days).toBe(30)
  })
})

// ----------------------------------------------------------------- profile ---

describe('profileOf', () => {
  const monthly = (id: number, dates: string[]): SaleInvoice[] =>
    dates.map((d, i) => bill({
      id: id * 100 + i,
      invoiceDate: d,
      cash: '100.00',
      lines: [line({ medicineId: id })],
    }))

  it('projects the next refill from the last purchase plus the cycle', () => {
    const p = profileOf(monthly(1, ['2026-06-11', '2026-07-11', '2026-08-10']), TODAY)
    const item = p.items[0]
    expect(item?.cycle?.days).toBe(30)
    expect(item?.dueOn).toBe('2026-09-09')
    expect(item?.dueInDays).toBe(0)
  })

  it('never lets a voided bill vote on a cycle', () => {
    const bills = monthly(1, ['2026-06-11', '2026-07-11', '2026-08-10'])
    bills.push(bill({
      id: 999, invoiceDate: '2026-09-08', cash: '100.00', status: 'VOIDED',
      lines: [line({ medicineId: 1 })],
    }))
    const p = profileOf(bills, TODAY)
    expect(p.voided).toBe(1)
    expect(p.bills).toBe(3)
    // A cancelled bill was never dispensed, so the last collection is still August.
    expect(p.items[0]?.lastBought).toBe('2026-08-10')
    expect(p.items[0]?.times).toBe(3)
  })

  it('counts what left the shelf, not what was asked for', () => {
    const p = profileOf(
      [bill({
        id: 1, invoiceDate: '2026-09-01', cash: '100.00',
        lines: [line({ medicineId: 1, requestedQty: '30', allocatedQty: '10', shortQty: '20' })],
      })],
      TODAY,
    )
    expect(p.items[0]?.qty).toBe('10.000')
  })

  it('orders favourites by repeats first and money only as a tie-break', () => {
    const p = profileOf(
      [
        ...monthly(1, ['2026-06-11', '2026-07-11', '2026-08-10']),
        bill({
          id: 50, invoiceDate: '2026-08-01', cash: '9000.00',
          lines: [line({ medicineId: 2, lineTotal: '9000.00' })],
        }),
      ],
      TODAY,
    )
    // One expensive one-off is not a favourite medicine.
    expect(p.items[0]?.medicineId).toBe(1)
    expect(p.items[1]?.medicineId).toBe(2)
  })

  it('sums the bill totals and averages over POSTED bills only', () => {
    const bills = [
      bill({ id: 1, invoiceDate: '2026-09-01', cash: '300.00', net: '300.00', lines: [line({ medicineId: 1 })] }),
      bill({ id: 2, invoiceDate: '2026-09-02', cash: '100.00', net: '100.00', lines: [line({ medicineId: 1 })] }),
      bill({ id: 3, invoiceDate: '2026-09-03', cash: '900.00', net: '900.00', status: 'VOIDED', lines: [line({ medicineId: 1 })] }),
    ]
    const p = profileOf(bills, TODAY)
    expect(p.spend).toBe('400.00')
    expect(p.average).toBe('200.00')
  })

  it('collects prescribers, most-billed first', () => {
    const p = profileOf(
      [
        bill({ id: 1, invoiceDate: '2026-09-01', cash: '1.00', prescriber: 'Dr. Pawar', lines: [line({ medicineId: 1 })] }),
        bill({ id: 2, invoiceDate: '2026-09-02', cash: '1.00', prescriber: 'Dr. Pawar', lines: [line({ medicineId: 1 })] }),
        bill({ id: 3, invoiceDate: '2026-09-03', cash: '1.00', prescriber: 'Dr. Rao', lines: [line({ medicineId: 1 })] }),
      ],
      TODAY,
    )
    expect(p.prescribers.map((x) => `${x.name}:${x.times}`)).toEqual(['Dr. Pawar:2', 'Dr. Rao:1'])
  })

  it('has nothing to say about an account with no bills', () => {
    const p = profileOf([], TODAY)
    expect(p.segment).toBe('none')
    expect(p.bills).toBe(0)
    expect(p.spend).toBe('0.00')
  })
})

describe('segments', () => {
  const monthly = (dates: string[]): SaleInvoice[] =>
    dates.map((d, i) => bill({ id: i + 1, invoiceDate: d, cash: '100.00', lines: [line({ medicineId: 1 })] }))

  it('calls a steady monthly refiller chronic', () => {
    expect(profileOf(monthly(['2026-07-11', '2026-08-10', '2026-09-09']), TODAY).segment).toBe('chronic')
  })

  it('calls somebody who buys on no rhythm occasional', () => {
    expect(profileOf(monthly(['2026-09-01', '2026-09-05']), TODAY).segment).toBe('occasional')
  })

  it('files a lapsed chronic under DORMANT, not under chronic', () => {
    // The most valuable name on the screen: still on the medicine, buying it
    // somewhere else. Filing them as chronic hides them among the ones turning up.
    const p = profileOf(monthly(['2026-01-11', '2026-02-10', '2026-03-12']), TODAY)
    expect(p.segment).toBe('dormant')
  })

  it('counts the book by segment', () => {
    const rows = [
      rowOf(customer({ id: 1 }), monthly(['2026-07-11', '2026-08-10', '2026-09-09'])),
      rowOf(customer({ id: 2 }), []),
    ]
    expect(countSegments(buildProfiles(rows, TODAY))).toEqual({
      chronic: 1, occasional: 0, dormant: 0, none: 1,
    })
  })
})

describe('refillsDue', () => {
  const rowWith = (id: number, dates: string[]): CustomerRow => rowOf(
    customer({ id, name: `Customer ${id}` }),
    dates.map((d, i) => bill({ id: id * 100 + i, invoiceDate: d, cash: '100.00', lines: [line({ medicineId: 1 })] })),
  )

  it('lists what falls inside the horizon, most overdue first', () => {
    const rows = [
      rowWith(1, ['2026-06-11', '2026-07-11', '2026-08-10']), // due 2026-09-09, today
      rowWith(2, ['2026-06-05', '2026-07-05', '2026-08-04']), // due 2026-09-03, 6 days late
    ]
    const due = refillsDue(rows, buildProfiles(rows, TODAY), 14)
    expect(due.map((d) => d.dueInDays)).toEqual([-6, 0])
  })

  it('drops an item more than a full cycle overdue', () => {
    // Not a reminder any more: that customer has stopped, and they resurface in
    // the dormant segment as a call rather than as a refill.
    const rows = [rowWith(1, ['2026-04-11', '2026-05-11', '2026-06-10'])]
    expect(refillsDue(rows, buildProfiles(rows, TODAY), 14)).toEqual([])
  })

  it('does not reach past the horizon it was asked for', () => {
    const rows = [rowWith(1, ['2026-07-01', '2026-08-01', '2026-09-01'])] // due 2026-10-01
    expect(refillsDue(rows, buildProfiles(rows, TODAY), 14)).toEqual([])
    expect(refillsDue(rows, buildProfiles(rows, TODAY), 30)).toHaveLength(1)
  })
})

// --------------------------------------------------------------- statement ---

describe('statementOf', () => {
  it('derives the opening balance BACKWARDS from the authoritative balance', () => {
    // ₹1,000 on the account in the period and ₹400 taken, balance today ₹1,000.
    // The opening therefore has to be ₹400 — anything else makes the closing
    // balance disagree with the figure printed beside it.
    const row = rowOf(
      customer({ outstanding: '1000.00' }),
      [bill({ id: 1, invoiceDate: '2026-08-15', credit: '1000.00' })],
      [receipt({ id: 1, date: '2026-08-20', amount: '400.00' })],
    )
    const s = statementOf(row, '2026-08-01', '2026-08-31')
    expect(s.opening).toBe('400.00')
    expect(s.debit).toBe('1000.00')
    expect(s.credit).toBe('400.00')
    expect(s.closing).toBe('1000.00')
    expect(s.entries.map((e) => e.balance)).toEqual(['1400.00', '1000.00'])
  })

  it('keeps money dated after the period out of the closing balance, and says how much', () => {
    const row = rowOf(
      customer({ outstanding: '1500.00' }),
      [
        bill({ id: 1, invoiceDate: '2026-08-15', credit: '1000.00' }),
        bill({ id: 2, invoiceDate: '2026-09-05', credit: '500.00' }),
      ],
    )
    const s = statementOf(row, '2026-08-01', '2026-08-31')
    expect(s.after).toBe('500.00')
    expect(s.closing).toBe('1000.00')
    expect(s.stated).toBe('1500.00')
  })

  it('leaves cash bills off a statement of the ACCOUNT', () => {
    const row = rowOf(
      customer({ outstanding: '0.00' }),
      [bill({ id: 1, invoiceDate: '2026-08-15', cash: '900.00' })],
    )
    expect(statementOf(row, '2026-08-01', '2026-08-31').entries).toEqual([])
  })

  it('shows a voided bill at nil rather than as a gap in the numbering', () => {
    const row = rowOf(
      customer({ outstanding: '0.00' }),
      [bill({ id: 1, invoiceDate: '2026-08-15', credit: '400.00', status: 'VOIDED' })],
    )
    const s = statementOf(row, '2026-08-01', '2026-08-31')
    expect(s.entries).toHaveLength(1)
    expect(s.entries[0]?.debit).toBeNull()
    expect(s.entries[0]?.voided).toBe(true)
    expect(s.closing).toBe('0.00')
  })

  it('puts a bill before a receipt raised on the same day', () => {
    const row = rowOf(
      customer({ outstanding: '0.00' }),
      [bill({ id: 1, invoiceDate: '2026-08-15', credit: '400.00' })],
      [receipt({ id: 1, date: '2026-08-15', amount: '400.00' })],
    )
    expect(statementOf(row, '2026-08-01', '2026-08-31').entries.map((e) => e.kind))
      .toEqual(['bill', 'receipt'])
  })

  it('counts older documents rather than itemising them, and flags the window', () => {
    const row = rowOf(
      customer({ outstanding: '900.00' }),
      [
        bill({ id: 1, invoiceDate: '2026-05-01', credit: '400.00' }),
        bill({ id: 2, invoiceDate: '2026-08-15', credit: '500.00' }),
      ],
    )
    const s = statementOf(row, '2026-08-01', '2026-08-31')
    expect(s.earlier).toBe(1)
    expect(s.opening).toBe('400.00')
    expect(s.windowStartsInside).toBe(false)
  })

  it('does not pin to a balance it cannot read', () => {
    const row = rowOf(customer({ outstanding: 'n/a' }), [])
    const s = statementOf(row, '2026-08-01', '2026-08-31')
    expect(s.stated).toBeNull()
  })
})

describe('statementCsv', () => {
  const row = rowOf(
    customer({ outstanding: '1000.00' }),
    [bill({ id: 1, invoiceDate: '2026-08-15', credit: '1000.00' })],
  )
  const s = statementOf(row, '2026-08-01', '2026-08-31')
  const csv = statementCsv({
    store: null,
    customer: row.customer,
    statement: s,
    generatedAt: '2026-09-09T10:00:00.000Z',
  })

  it('opens with the BOM Excel needs to decode the rupee sign', () => {
    expect(csv.startsWith('﻿')).toBe(true)
  })

  it('carries the basis, the period and the closing balance in the manifest', () => {
    expect(csv).toContain('2026-08-01 to 2026-08-31')
    expect(csv).toContain('Closing balance')
    expect(csv).toContain('never moved this balance')
  })

  it('writes money as bare decimals, never grouped and never with a symbol', () => {
    expect(csv).toContain('1000.00')
    expect(csv).not.toContain('₹1,000')
  })

  it('names the file after the customer and the period', () => {
    expect(statementFilename(row.customer, s)).toBe('statement-ramesh-kulkarni-2026-08-01_2026-08-31.csv')
  })
})

// ------------------------------------------------------------- the care file ---

describe('isDob', () => {
  it('accepts a real past date', () => {
    expect(isDob('1979-04-18', TODAY)).toBe(true)
  })

  it('rejects a date that never existed rather than rolling it into March', () => {
    expect(isDob('2026-02-31', TODAY)).toBe(false)
  })

  it('rejects the future and anything past a human lifetime', () => {
    expect(isDob('2027-01-01', TODAY)).toBe(false)
    expect(isDob('1899-01-01', TODAY)).toBe(false)
  })
})

describe('age and birthdays', () => {
  it('does not count a birthday that has not happened yet this year', () => {
    expect(ageOn('1979-12-25', TODAY)).toBe(46)
    expect(ageOn('1979-01-25', TODAY)).toBe(47)
  })

  it('finds the next birthday and what they turn on it', () => {
    const b = nextBirthday('1979-09-20', TODAY)
    expect(b).toEqual({ on: '2026-09-20', inDays: 11, turning: 47 })
  })

  it('rolls to next year once the one this year has passed', () => {
    expect(nextBirthday('1979-09-01', TODAY)?.on).toBe('2027-09-01')
  })

  it('treats a birthday today as zero days away, not as next year', () => {
    expect(nextBirthday('1979-09-09', TODAY)?.inDays).toBe(0)
  })

  it('lists only the ones inside the horizon, soonest first', () => {
    const book = {
      '1': { conditions: [], dob: '1979-09-20', note: null, updatedAt: '' },
      '2': { conditions: [], dob: '1990-09-11', note: null, updatedAt: '' },
      '3': { conditions: [], dob: '1990-12-01', note: null, updatedAt: '' },
    }
    const people = [
      { id: 1, name: 'A', phone: '1' },
      { id: 2, name: 'B', phone: '2' },
      { id: 3, name: 'C', phone: '3' },
    ]
    expect(birthdaysDue(people, book, TODAY, 14).map((b) => b.name)).toEqual(['B', 'A'])
  })
})

// -------------------------------------------------------------- call list ---

describe('the call list', () => {
  const rows = [
    rowOf(
      customer({ id: 1, name: 'Ramesh Kulkarni', phone: '9822041100' }),
      ['2026-06-05', '2026-07-05', '2026-08-04'].map((d, i) => bill({
        id: 100 + i, invoiceDate: d, cash: '100.00', lines: [line({ medicineId: 1 })],
      })),
    ),
  ]
  const refills = refillsDue(rows, buildProfiles(rows, TODAY), 14)

  it('says when in words, never as a bare number', () => {
    expect(whenWords(-1)).toBe('1 day late')
    expect(whenWords(0)).toBe('today')
    expect(whenWords(3)).toBe('in 3 days')
  })

  it('carries a reason with every name', () => {
    const list = toCallRows(refills, [])
    expect(list[0]?.reason).toContain('Brand 1')
    expect(list[0]?.reason).toContain('every 30 days')
  })

  it('sorts the overdue above the merely upcoming, across both kinds', () => {
    const birthdays = birthdaysDue(
      [{ id: 9, name: 'Z', phone: '9' }],
      { '9': { conditions: [], dob: '1980-09-10', note: null, updatedAt: '' } },
      TODAY,
      14,
    )
    expect(toCallRows(refills, birthdays).map((r) => r.inDays)).toEqual([-6, 1])
  })

  it('reads as one line per call, with nothing to decode', () => {
    const text = callListText(toCallRows(refills, []), '2026-09-09')
    expect(text).toContain('Ramesh Kulkarni · 9822041100 —')
    expect(text).toContain('6 days late')
  })

  it('guards a phone number so Excel does not eat its leading zero', () => {
    const csv = callListCsv(
      [{ name: 'A', phone: '02026441120', reason: 'x', on: '2026-09-09', inDays: 0, kind: 'refill' }],
      '2026-09-09',
    )
    expect(csv).toContain('="02026441120"')
  })

  it('says so plainly when there is nothing to do', () => {
    expect(callListText([], '2026-09-09')).toBe('No customer reminders as at 2026-09-09.')
  })
})
