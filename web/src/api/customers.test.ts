import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type { Customer, CustomerReceipt, PaymentInput, SaleInvoice } from '@contract'
import {
  ageInDays, buildRows, coerceReceipts, collectBills, compareRows, creditStanding, creditTaken,
  filterRows, matchesTerm, matchesView, mergeReceivable, prepareReceipt, receivableNote,
  receivableOf, summarise, unallocatedNote,
} from './customers'
import type { CustomerRow, ReceiptStamp } from './customers'

/**
 * The receivable, exercised as values.
 *
 * Four of these encode rules that are silently wrong rather than loudly broken
 * when they go the other way — a bill total aged instead of the credit taken on
 * it, a receipt applied newest-first, an unexplainable balance shown as zero,
 * and a receipt allowed past the outstanding — so they are asserted on numbers a
 * person can check by hand.
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

/** A bill carrying `credit` on the account and the rest in cash. */
function bill(over: {
  id: number
  invoiceDate: string
  credit?: string
  cash?: string
  customerId?: number | null
  status?: 'POSTED' | 'VOIDED'
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
    customerId: over.customerId === undefined ? 1 : over.customerId,
    customerName: 'Ramesh Kulkarni',
    customerPhone: '9822041100',
    interState: false,
    quote: {
      lines: [],
      grossAmount: '0.00', itemDiscount: '0.00', billDiscountPct: '0', billDiscount: '0.00',
      taxableValue: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', roundOff: '0.00',
      netAmount: over.credit ?? '0.00', taxBreakup: [], warnings: [], costOfGoods: '0.00',
    },
    payments,
    amountPaid: over.cash ?? '0.00',
    changeDue: '0.00',
    status: over.status ?? 'POSTED',
    prescription: null,
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

const STAMP: ReceiptStamp = {
  id: 7,
  storeId: 1,
  receiptNo: 'RC2627-00007',
  at: '2026-09-09T10:00:00.000Z',
  date: '2026-09-09',
}

const bucket = (r: ReturnType<typeof receivableOf>, key: string): string =>
  r.buckets.find((b) => b.key === key)?.amount ?? 'missing'

// ------------------------------------------------------------------ credit ---

describe('creditTaken', () => {
  it('reads the CREDIT tender, not the bill total', () => {
    // Split tender: ₹300 cash across the counter, ₹200 on the account. Ageing
    // the ₹500 net would put money the shop already has into the receivable.
    expect(creditTaken(bill({ id: 1, invoiceDate: '2026-09-01', cash: '300.00', credit: '200.00' })))
      .toEqual({ v: 200_000_000n })
  })

  it('is zero on a fully paid bill', () => {
    expect(creditTaken(bill({ id: 1, invoiceDate: '2026-09-01', cash: '500.00' })).v).toBe(0n)
  })

  it('treats an unreadable amount as absent rather than as zero-crashing', () => {
    const b = bill({ id: 1, invoiceDate: '2026-09-01' })
    b.payments = [{ mode: 'CREDIT', amount: 'n/a' }, { mode: 'CREDIT', amount: '100.00' }]
    expect(creditTaken(b)).toEqual({ v: 100_000_000n })
  })
})

// ------------------------------------------------------------------ ageing ---

describe('receivableOf', () => {
  it('files each bill in the bucket its age falls in, on the boundaries', () => {
    const r = receivableOf(
      customer({ outstanding: '4000.00' }),
      [
        bill({ id: 1, invoiceDate: '2026-09-01', credit: '1000.00' }), // 8 days
        bill({ id: 2, invoiceDate: '2026-08-10', credit: '1000.00' }), // 30 days
        bill({ id: 3, invoiceDate: '2026-08-09', credit: '1000.00' }), // 31 days
        bill({ id: 4, invoiceDate: '2026-05-01', credit: '1000.00' }), // 131 days
      ],
      [],
      TODAY,
    )
    expect(bucket(r, 'b30')).toBe('2000.00')
    expect(bucket(r, 'b60')).toBe('1000.00')
    expect(bucket(r, 'b90')).toBe('0.00')
    expect(bucket(r, 'b90p')).toBe('1000.00')
    expect(r.onBills).toBe('4000.00')
    expect(r.unallocated).toBeNull()
    expect(r.openCount).toBe(4)
    expect(r.oldestDays).toBe(131)
  })

  it('applies receipts to the OLDEST bill first', () => {
    // The convention every Indian outstanding report uses. Newest-first would
    // leave the ninety-day column clear while the debt being chased is untouched.
    const r = receivableOf(
      customer({ outstanding: '600.00' }),
      [
        bill({ id: 1, invoiceDate: '2026-09-05', credit: '1000.00' }),
        bill({ id: 2, invoiceDate: '2026-04-01', credit: '1000.00' }),
      ],
      [receipt({ amount: '1400.00' })],
      TODAY,
    )
    expect(bucket(r, 'b90p')).toBe('0.00')
    expect(bucket(r, 'b30')).toBe('600.00')
    expect(r.applied).toBe('1400.00')
    expect(r.openCount).toBe(1)
  })

  it('NAMES a balance no loaded bill accounts for instead of showing nothing due', () => {
    // The bug the payable side shipped once: an opening balance with no bill
    // behind it aged to four zeros, and the row read "Nothing due" next to a
    // live figure.
    const r = receivableOf(customer({ outstanding: '1240.00' }), [], [], TODAY)
    expect(r.onBills).toBe('0.00')
    expect(r.outstanding).toBe('1240.00')
    expect(r.unallocated).toBe('1240.00')
    expect(r.openCount).toBe(0)
  })

  it('names money received beyond the loaded bills as a negative remainder', () => {
    const r = receivableOf(
      customer({ outstanding: '0.00' }),
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '500.00' })],
      [],
      TODAY,
    )
    expect(r.onBills).toBe('500.00')
    expect(r.unallocated).toBe('-500.00')
  })

  it('skips a voided bill and a bill whose date cannot be read', () => {
    const r = receivableOf(
      customer({ outstanding: '0.00' }),
      [
        bill({ id: 1, invoiceDate: '2026-09-01', credit: '900.00', status: 'VOIDED' }),
        bill({ id: 2, invoiceDate: 'not-a-date', credit: '700.00' }),
      ],
      [],
      TODAY,
    )
    expect(r.onBills).toBe('0.00')
    expect(r.openCount).toBe(0)
  })

  it('shows an unreadable balance as stored rather than as a confident zero', () => {
    const r = receivableOf(customer({ outstanding: '' }), [], [], TODAY)
    expect(r.outstanding).toBe('')
    expect(r.unallocated).toBeNull()
  })

  it('orders settlement stably when two bills share a date', () => {
    const args = [
      bill({ id: 9, invoiceDate: '2026-03-01', credit: '100.00' }),
      bill({ id: 4, invoiceDate: '2026-03-01', credit: '100.00' }),
    ]
    const a = receivableOf(customer({ outstanding: '100.00' }), args, [receipt({ amount: '100.00' })], TODAY)
    const b = receivableOf(customer({ outstanding: '100.00' }), [...args].reverse(), [receipt({ amount: '100.00' })], TODAY)
    expect(a.buckets).toEqual(b.buckets)
  })
})

describe('receivableNote', () => {
  const noteFor = (c: Partial<Customer>, bills: SaleInvoice[], receipts: CustomerReceipt[] = []) =>
    receivableNote(receivableOf(customer(c), bills, receipts, TODAY))

  it('never says "clear" about a balance no bill explains', () => {
    expect(noteFor({ outstanding: '1240.00' }, [])).toEqual({
      kind: 'carried', amount: '1240.00', count: 0, carried: null,
    })
  })

  it('says the balance is unknown rather than clear when it will not parse', () => {
    expect(noteFor({ outstanding: 'NaN' }, []).kind).toBe('unreadable')
  })

  it('leads with the ninety-day column when there is one', () => {
    expect(noteFor({ outstanding: '1000.00' }, [bill({ id: 1, invoiceDate: '2026-01-01', credit: '1000.00' })]))
      .toEqual({ kind: 'aged', amount: '1000.00', count: 1, carried: null })
  })

  it('falls back to the open-bill count when nothing is that old', () => {
    expect(noteFor({ outstanding: '1000.00' }, [bill({ id: 1, invoiceDate: '2026-09-01', credit: '1000.00' })]))
      .toEqual({ kind: 'open', amount: '1000.00', count: 1, carried: null })
  })


  it('names BOTH halves when open bills explain only part of the balance', () => {
    // Two thousand on a loaded bill, ten thousand owed. The row used to read
    // "1 open bill, none past 90 days" and never mention the other eight — the
    // larger, older half — because 'open' outranks 'carried' on precedence.
    const note = noteFor(
      { outstanding: '10000.00' },
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '2000.00' })],
    )
    expect(note.kind).toBe('open')
    expect(note.amount).toBe('2000.00')
    expect(note.carried).toBe('8000.00')
  })

  it('does not report an ADVANCE as more money owed', () => {
    // Receipts beyond the loaded bills make the remainder negative. That is an
    // advance, `unallocatedNote` already labels it in words, and appending it
    // here would print it as a further amount due — the same error backwards.
    const note = noteFor(
      { outstanding: '500.00' },
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '2000.00' })],
      [receipt({ amount: '1500.00' })],
    )
    expect(note.carried).toBeNull()
  })

  it('does not send anyone chasing a bill the account says is settled', () => {
    // Balance zero, and the window still holds the credit bill a receipt
    // cleared. "1 open bill" here is the same error as "nothing due" above,
    // pointing the other way.
    expect(noteFor({ outstanding: '0.00' }, [bill({ id: 1, invoiceDate: '2026-09-01', credit: '400.00' })]))
      .toEqual({ kind: 'onAccount', amount: '400.00', count: 0, carried: null })
  })

  it('is clear only when the account really is', () => {
    expect(noteFor({ outstanding: '0.00' }, []).kind).toBe('clear')
  })
})

describe('mergeReceivable', () => {
  it('folds the book out of the rows it summarises', () => {
    const one = receivableOf(
      customer({ outstanding: '1000.00' }),
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '1000.00' })],
      [], TODAY,
    )
    const two = receivableOf(
      customer({ id: 2, outstanding: '2000.00' }),
      [bill({ id: 2, invoiceDate: '2026-01-01', credit: '2000.00' })],
      [], TODAY,
    )
    const book = mergeReceivable([one, two])
    expect(book.outstanding).toBe('3000.00')
    expect(bucket(book, 'b30')).toBe('1000.00')
    expect(bucket(book, 'b90p')).toBe('2000.00')
    expect(book.oldestDays).toBe(251)
  })

  it('stays silent about a remainder when every balance ties to a bill', () => {
    const clean = receivableOf(
      customer({ outstanding: '1000.00' }),
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '1000.00' })],
      [], TODAY,
    )
    expect(mergeReceivable([clean, clean]).unallocated).toBeNull()
  })

  it('stays silent when a carried balance and an advance cancel each other out', () => {
    // One customer carrying 5,000 from the old software, one sitting on a 5,000
    // advance. The book reconciles to its buckets, so printing "Not aged ₹0.00"
    // beside them invents a remainder that is not there.
    const carried = receivableOf(customer({ outstanding: '5000.00' }), [], [], TODAY)
    const advance = receivableOf(
      customer({ id: 2, outstanding: '0.00' }),
      [bill({ id: 1, invoiceDate: '2026-09-01', credit: '5000.00' })],
      [], TODAY,
    )
    expect(carried.unallocated).toBe('5000.00')
    expect(advance.unallocated).toBe('-5000.00')
    expect(mergeReceivable([carried, advance]).unallocated).toBeNull()
  })
})

// ----------------------------------------------------------- the remainder ---

describe('unallocatedNote', () => {
  const noteOf = (outstanding: string, credit: string | null) => unallocatedNote(receivableOf(
    customer({ outstanding }),
    credit === null ? [] : [bill({ id: 1, invoiceDate: '2026-09-01', credit })],
    [], TODAY,
  ))

  it('hands back an UNSIGNED figure with the direction as a flag', () => {
    // The label beside it reads "Paid on account". Handing that label the raw
    // '-500.00' prints the direction twice, once of them backwards — a negative
    // payment — and contradicts the sentence under it, which abs'd all along.
    expect(noteOf('0.00', '500.00')).toEqual({ credit: true, amount: '500.00' })
  })

  it('keeps a carried balance as the debt it is', () => {
    expect(noteOf('1240.00', null)).toEqual({ credit: false, amount: '1240.00' })
  })

  it('says nothing when the buckets already add up', () => {
    expect(noteOf('500.00', '500.00')).toBeNull()
  })
})

// ------------------------------------------------------------ credit limit ---

describe('creditStanding', () => {
  it('draws no meter when no limit was agreed, and says so', () => {
    const s = creditStanding('0.00', '0.00')
    expect(s.meter).toBeNull()
    expect(s.overLimit).toBe(false)
    expect(s.word).toBe('No credit limit set')
  })

  it('flags a balance on an account that was never given credit', () => {
    // Credit nobody approved. A dash here hides the single most useful thing
    // this screen can point at.
    const s = creditStanding('500.00', '0.00')
    expect(s.overLimit).toBe(true)
    expect(s.overBy).toBe('500.00')
    expect(s.meter).toBeNull()
  })

  it('reads the ramp at the boundaries', () => {
    expect(creditStanding('3700.00', '5000.00').tone).toBe('ok')
    expect(creditStanding('3750.00', '5000.00').tone).toBe('near')
    expect(creditStanding('5000.00', '5000.00').tone).toBe('near')
    expect(creditStanding('5000.01', '5000.00').tone).toBe('over')
  })

  it('clamps the bar at full width but keeps the true percentage for the label', () => {
    const s = creditStanding('15000.00', '5000.00')
    expect(s.meter?.width).toBe(100)
    // Deliberately unclamped HERE: the meter element clamps it into ARIA's
    // min..max range at the DOM boundary, and the words carry the real figure.
    expect(s.meter?.valueNow).toBe(300)
    expect(s.overBy).toBe('10000.00')
  })
})

// -------------------------------------------------------------------- rows ---

const CUSTOMERS: Customer[] = [
  customer({ id: 1, name: 'Ramesh Kulkarni', outstanding: '1240.00', creditLimit: '5000.00' }),
  customer({ id: 2, name: 'Sunita Deshpande', phone: '9765432101', allergies: [], outstanding: '0.00', creditLimit: '2000.00' }),
  customer({ id: 3, name: 'Joshi Clinic', phone: '', gstin: '27AAECJ1234K1Z5', allergies: [], outstanding: '18450.00', creditLimit: '0.00' }),
]

const BILLS: SaleInvoice[] = [
  bill({ id: 10, invoiceDate: '2026-09-02', credit: '1240.00', customerId: 1 }),
  bill({ id: 11, invoiceDate: '2026-02-01', credit: '9000.00', customerId: 3 }),
  bill({ id: 12, invoiceDate: '2026-08-30', cash: '300.00', customerId: 2 }),
]

function rows(): CustomerRow[] {
  return buildRows(CUSTOMERS, BILLS, [], TODAY)
}

describe('buildRows', () => {
  it('groups bills onto their customer and takes the newest as last purchase', () => {
    const [first] = rows()
    expect(first?.bills.map((b) => b.id)).toEqual([10])
    expect(first?.lastPurchase).toBe('2026-09-02')
  })

  it('leaves a customer with no bills with an empty history rather than a hole', () => {
    const [only] = buildRows([customer({ id: 4 })], BILLS, [], TODAY)
    expect(only?.bills).toEqual([])
    expect(only?.lastPurchase).toBe(null)
    expect(only?.receivable.openCount).toBe(0)
  })

  it('keeps a cash-only bill as a purchase while owing nothing on it', () => {
    // The "last purchase" column is about the relationship, not the debt: a
    // regular who always pays cash must not read as somebody who never came in.
    const found = rows().find((r) => r.customer.id === 2)
    expect(found?.lastPurchase).toBe('2026-08-30')
    expect(found?.receivable.onBills).toBe('0.00')
  })
})

describe('summarise', () => {
  it('counts who is on credit and who is past what was agreed', () => {
    const book = summarise(rows())
    expect(book.customers).toBe(3)
    expect(book.onCredit).toBe(2)
    // Joshi Clinic owes ₹18,450 against a limit of nothing.
    expect(book.overLimit).toBe(1)
    expect(book.receivable.outstanding).toBe('19690.00')
  })
})

describe('filters', () => {
  it('finds a customer by a phone number typed with a country code', () => {
    const [first] = rows()
    expect(first && matchesTerm(first, '+91 98220 41100')).toBe(true)
  })

  it('does not let an empty digit run match every row through the phone clause', () => {
    const target = rows().find((r) => r.customer.id === 3)
    expect(target && matchesTerm(target, 'ramesh')).toBe(false)
  })

  it('answers each preset over the whole book', () => {
    const all = rows()
    const ids = (view: Parameters<typeof matchesView>[1]) =>
      all.filter((r) => matchesView(r, view)).map((r) => r.customer.id)
    expect(ids('all')).toEqual([1, 2, 3])
    expect(ids('owes')).toEqual([1, 3])
    expect(ids('overlimit')).toEqual([3])
    expect(ids('aged')).toEqual([3])
    expect(ids('allergies')).toEqual([1])
    expect(ids('nophone')).toEqual([3])
  })

  it('sorts by outstanding as money, not as a string', () => {
    // '9,00,000' sorts below '95' if the strings are compared.
    const big = buildRows(
      [customer({ id: 1, outstanding: '900000.00' }), customer({ id: 2, outstanding: '95.00' })],
      [], [], TODAY,
    )
    const [first, second] = [...big].sort((a, b) => compareRows('outstanding', a, b))
    expect(first?.customer.id).toBe(1)
    expect(second?.customer.id).toBe(2)
  })

  it('breaks every tie on id so the highlight cannot drift between renders', () => {
    const same = buildRows(
      [customer({ id: 5, name: 'A', outstanding: '0.00' }), customer({ id: 2, name: 'A', outstanding: '0.00' })],
      [], [], TODAY,
    )
    for (const sort of ['name', 'outstanding', 'oldest', 'recent'] as const) {
      expect([...same].sort((a, b) => compareRows(sort, a, b)).map((r) => r.customer.id)).toEqual([2, 5])
    }
  })

  it('filters and sorts in one pass', () => {
    const out = filterRows(rows(), { term: '', view: 'owes', sort: 'outstanding' })
    expect(out.map((r) => r.customer.id)).toEqual([3, 1])
  })
})

// ------------------------------------------------------------- the window ---

describe('collectBills', () => {
  it('keeps paging when the adapter serves fewer rows than asked for', () => {
    const all = Array.from({ length: 25 }, (_, i) => bill({ id: i + 1, invoiceDate: '2026-09-01' }))
    const asked: number[] = []
    const fetchPage = async ({ limit, cursor }: { limit: number; cursor?: number }) => {
      asked.push(limit)
      const start = cursor ?? 0
      // The clamp the local adapter really applies, scaled down.
      const rowsOut = all.slice(start, start + Math.min(limit, 10))
      const next = start + rowsOut.length
      return { rows: rowsOut, nextCursor: next < all.length ? next : null }
    }
    return collectBills(fetchPage, 25).then((out) => {
      expect(out).toHaveLength(25)
      expect(asked).toEqual([25, 15, 5])
    })
  })

  it('stops rather than spinning when a cursor fails to advance', async () => {
    let calls = 0
    const out = await collectBills(async () => {
      calls += 1
      return { rows: [bill({ id: calls, invoiceDate: '2026-09-01' })], nextCursor: 1 }
    }, 500)
    expect(calls).toBe(2)
    expect(out).toHaveLength(2)
  })

  it('stops on an empty page', async () => {
    const out = await collectBills(async () => ({ rows: [], nextCursor: 5 }), 100)
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------- receipts ---

describe('prepareReceipt', () => {
  const owing = customer({ outstanding: '1240.00' })

  it('takes money off the balance and stamps what it leaves behind', () => {
    const r = prepareReceipt({ customerId: 1, amount: '240.00', mode: 'UPI', reference: ' TXN-9 ' }, owing, STAMP)
    expect(r.amount).toBe('240.00')
    expect(r.balanceAfter).toBe('1000.00')
    expect(r.receiptNo).toBe('RC2627-00007')
    expect(r.reference).toBe('TXN-9')
    expect(r.note).toBe(null)
  })

  it('settles the account exactly when the whole balance is paid', () => {
    expect(prepareReceipt({ customerId: 1, amount: '1240.00', mode: 'CASH' }, owing, STAMP).balanceAfter)
      .toBe('0.00')
  })

  const refused: Array<[string, string, string]> = [
    ['zero', '0', 'settles nothing'],
    ['zero with paise', '0.00', 'settles nothing'],
    ['negative', '-100.00', 'cannot be negative'],
    ['more than the balance', '1240.01', 'more than the'],
    ['not an amount', '12,40', 'Amount in rupees'],
    ['three decimal places', '10.005', 'Amount in rupees'],
  ]

  for (const [name, amount, fragment] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => prepareReceipt({ customerId: 1, amount, mode: 'CASH' }, owing, STAMP))
        .toThrow(new RegExp(fragment))
    })
  }

  it('points at the field it rejected so the form can focus it', () => {
    try {
      prepareReceipt({ customerId: 1, amount: '9999.00', mode: 'CASH' }, owing, STAMP)
      expect.unreachable('an over-payment must be refused')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('RECEIPT_INVALID')
      expect((err as ApiError).details).toEqual({ field: 'amount' })
    }
  })

  it('refuses to take money against an account that owes nothing', () => {
    expect(() => prepareReceipt({ customerId: 1, amount: '10.00', mode: 'CASH' }, customer(), STAMP))
      .toThrow(/owes nothing/)
  })

  it('refuses CREDIT as a mode — a receipt settles credit, it does not take it', () => {
    expect(() => prepareReceipt(
      { customerId: 1, amount: '10.00', mode: 'CREDIT' as never }, owing, STAMP,
    )).toThrow(/cash, by UPI or by card/)
  })
})

describe('coerceReceipts', () => {
  it('keeps a good row and drops one with no readable amount', () => {
    const out = coerceReceipts([
      receipt({ id: 1 }),
      { ...receipt({ id: 2 }), amount: undefined },
      { ...receipt({ id: 3 }), mode: 'CREDIT' },
      'nonsense',
      null,
    ])
    expect(out.map((r) => r.id)).toEqual([1])
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(coerceReceipts({ receipts: [] })).toEqual([])
    expect(coerceReceipts(null)).toEqual([])
  })
})

describe('ageInDays', () => {
  it('counts whole days back from today and is null on an unreadable date', () => {
    expect(ageInDays('2026-09-01', TODAY)).toBe(8)
    expect(ageInDays('2026-09-09', TODAY)).toBe(0)
    expect(ageInDays('rubbish', TODAY)).toBeNull()
  })
})
