import type { Customer, CustomerReceipt, IsoDate, Money, SaleInvoice, StoreProfile } from '@contract'
import type { CustomerRow } from '@/api/customers'
import { creditTaken, money } from '@/api/customers'
import * as D from '@/domain/decimal'
import { csvCell } from '@/pages/reports/exportCsv'
import { toIsoDate } from './profile'

/**
 * The statement of account: the document that ends the argument at the counter.
 *
 * "You owe ₹4,320" is a claim. A statement is evidence — every bill that went on
 * the account and every rupee taken against it, in date order, with the balance
 * after each one — and it is what a credit customer asks for when they dispute a
 * figure, what a clinic account needs at month end, and what a shop hands over
 * before it stops supplying somebody.
 *
 * THE OPENING BALANCE IS DERIVED BACKWARDS, and that is the whole design.
 *
 * `Customer.outstanding` is authoritative (rule 1 in `api/customers`), and the
 * bill window this screen loaded may not reach back to the start of the period —
 * or to the start of the account at all. Adding movements forward from a zero
 * opening therefore produces a closing balance that disagrees with the balance
 * printed on the same page, which is the single fastest way to make a document
 * like this worthless. So the closing balance is pinned to the authoritative
 * figure, the movements inside the period are subtracted to get the opening, and
 * everything older is inside that opening and SAID to be. The statement then
 * reconciles by construction, and the one thing it cannot show — the detail of
 * what made up the opening — is named rather than implied to be nothing.
 *
 * Cash bills are not on it. Money that never went on the account never moved the
 * balance, and listing it would invite the customer to add up a column that has
 * nothing to do with what they owe. The note says so on the document itself.
 */

const money2 = (d: D.Decimal): Money => D.toStr(d, 2)

export type EntryKind = 'bill' | 'receipt'

export interface StatementEntry {
  key: string
  date: IsoDate
  kind: EntryKind
  ref: string
  particulars: string
  /** Money onto the account. Null on a voided bill, which owes nothing. */
  debit: Money | null
  credit: Money | null
  /** The account balance after this line. */
  balance: Money
  voided: boolean
}

export interface Statement {
  from: IsoDate
  to: IsoDate
  opening: Money
  entries: StatementEntry[]
  debit: Money
  credit: Money
  closing: Money
  /** The authoritative balance as it stands now. Null when it will not parse. */
  stated: Money | null
  /** Movement dated after `to`, which is why closing and stated can differ. */
  after: Money
  /** Documents older than `from` — all of them folded into the opening balance. */
  earlier: number
  /** True when the loaded window has no bill older than `from` to fold in. */
  windowStartsInside: boolean
}

interface Movement {
  key: string
  date: IsoDate
  order: number
  kind: EntryKind
  ref: string
  particulars: string
  debit: D.Decimal
  credit: D.Decimal
  voided: boolean
}

/** Bills before receipts on the same day: money goes on the account, then comes
 *  off it. Every Indian ledger is read in that order and an id breaks the tie. */
function inLedgerOrder(a: Movement, b: Movement): number {
  return a.date.localeCompare(b.date) || a.order - b.order
}

function billMovement(inv: SaleInvoice): Movement | null {
  const credit = creditTaken(inv)
  // Cash-only bills never touched the account, so they are not on a statement of
  // it. A voided bill that DID carry credit stays, at nil, because the customer
  // remembers being handed the bill and a silent gap reads as a missing document.
  if (!D.gt(credit, D.ZERO)) return null
  const voided = inv.status !== 'POSTED'
  const items = inv.quote.lines.length
  // Defensive, like every other read of a stored amount on this screen: a bill
  // total that will not parse must not take the statement down with it.
  const net = money(inv.quote.netAmount)
  return {
    key: `bill-${inv.id}`,
    date: inv.invoiceDate,
    order: inv.id * 2,
    kind: 'bill',
    ref: inv.invoiceNo,
    particulars: voided
      ? 'Bill voided — nothing owed on it'
      : `${items} item${items === 1 ? '' : 's'}${net ? ` · bill ${D.toStr(net, 2)}` : ''}, on account`,
    debit: voided ? D.ZERO : credit,
    credit: D.ZERO,
    voided,
  }
}

function receiptMovement(r: CustomerReceipt): Movement | null {
  const amount = money(r.amount)
  if (!amount) return null
  return {
    key: `receipt-${r.id}`,
    date: r.date,
    order: r.id * 2 + 1,
    kind: 'receipt',
    ref: r.receiptNo,
    particulars: `Received by ${r.mode}${r.reference ? ` · ${r.reference}` : ''}`,
    debit: D.ZERO,
    credit: amount,
    voided: false,
  }
}

/**
 * One account, for one period.
 *
 * `from` and `to` are inclusive and are compared as ISO strings, which sort
 * correctly by date and cost nothing per row.
 */
export function statementOf(row: CustomerRow, from: IsoDate, to: IsoDate): Statement {
  const movements: Movement[] = []
  for (const inv of row.bills) {
    const m = billMovement(inv)
    if (m) movements.push(m)
  }
  for (const receipt of row.receipts) {
    const m = receiptMovement(receipt)
    if (m) movements.push(m)
  }
  movements.sort(inLedgerOrder)

  let after = D.ZERO
  let earlier = 0
  let oldest: IsoDate | null = null
  const inRange: Movement[] = []
  for (const m of movements) {
    if (oldest === null || m.date < oldest) oldest = m.date
    if (m.date > to) { after = D.add(after, D.sub(m.debit, m.credit)); continue }
    if (m.date < from) { earlier += 1; continue }
    inRange.push(m)
  }

  const stated = money(row.customer.outstanding)
  // Pinned to the authoritative balance, then walked backwards. When it will not
  // parse there is nothing to pin to, and the statement says so rather than
  // opening at a zero it invented.
  const closing = stated ? D.sub(stated, after) : D.ZERO
  let debit = D.ZERO
  let credit = D.ZERO
  for (const m of inRange) {
    debit = D.add(debit, m.debit)
    credit = D.add(credit, m.credit)
  }
  const opening = D.sub(closing, D.sub(debit, credit))

  let running = opening
  const entries: StatementEntry[] = inRange.map((m) => {
    running = D.add(running, D.sub(m.debit, m.credit))
    return {
      key: m.key,
      date: m.date,
      kind: m.kind,
      ref: m.ref,
      particulars: m.particulars,
      debit: m.voided || D.isZero(m.debit) ? null : money2(m.debit),
      credit: D.isZero(m.credit) ? null : money2(m.credit),
      balance: money2(running),
      voided: m.voided,
    }
  })

  return {
    from,
    to,
    opening: money2(opening),
    entries,
    debit: money2(debit),
    credit: money2(credit),
    closing: money2(closing),
    stated: stated ? money2(stated) : null,
    after: money2(after),
    earlier,
    windowStartsInside: oldest !== null && oldest >= from,
  }
}

// ------------------------------------------------------------------ ranges ---

export interface RangePreset {
  id: string
  label: string
  of: (today: Date) => { from: IsoDate; to: IsoDate }
}

const startOfMonth = (d: Date, back: number): Date => new Date(d.getFullYear(), d.getMonth() - back, 1)
const endOfMonth = (d: Date, back: number): Date => new Date(d.getFullYear(), d.getMonth() - back + 1, 0)

/**
 * The four periods a shop actually asks for.
 *
 * "This financial year" is deliberately absent: the year start is a store
 * setting, and a preset that guesses April would be quietly wrong for the shops
 * that do not. The custom fields cover it exactly.
 */
export const RANGE_PRESETS: readonly RangePreset[] = [
  {
    id: 'month',
    label: 'This month',
    of: (t) => ({ from: toIsoDate(startOfMonth(t, 0)), to: toIsoDate(t) }),
  },
  {
    id: 'last-month',
    label: 'Last month',
    of: (t) => ({ from: toIsoDate(startOfMonth(t, 1)), to: toIsoDate(endOfMonth(t, 1)) }),
  },
  {
    id: 'q',
    label: 'Last 90 days',
    of: (t) => {
      const from = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 89)
      return { from: toIsoDate(from), to: toIsoDate(t) }
    },
  },
  {
    id: 'year',
    label: 'Last 12 months',
    of: (t) => {
      const from = new Date(t.getFullYear() - 1, t.getMonth(), t.getDate() + 1)
      return { from: toIsoDate(from), to: toIsoDate(t) }
    },
  },
]

// --------------------------------------------------------------------- csv ---

const BOM = '﻿'
const CRLF = '\r\n'

const row = (fields: readonly string[]): string => fields.join(',')
const pair = (key: string, value: string): string => row([csvCell(key, 'text'), csvCell(value, 'text')])

/**
 * The statement as a file the customer's accountant can open.
 *
 * Escaping is `csvCell` from the reports exporter rather than a second copy: the
 * part of CSV that goes wrong is the escaping — the BOM, the formula lead, the
 * batch number Excel reads as a date — and it is already written and tested once.
 *
 * Money goes out as bare decimal strings with no grouping and no symbol, for the
 * same reason the reports do: `12,34,567.00` is a number in Mumbai and three
 * columns in London.
 */
export function statementCsv(input: {
  store: StoreProfile | null
  customer: Customer
  statement: Statement
  generatedAt: string
}): string {
  const { store, customer, statement: s } = input
  const lines: string[] = []

  if (store) {
    lines.push(pair('Statement of account', store.name))
    lines.push(pair('Shop address', [store.addressLine, store.city, store.state].filter(Boolean).join(', ')))
    lines.push(pair('Shop GSTIN', store.gstin))
  } else {
    lines.push(pair('Statement of account', 'Customer account'))
  }
  lines.push(pair('Customer', customer.name))
  lines.push(pair('Phone', customer.phone || 'not on file'))
  if (customer.gstin) lines.push(pair('Customer GSTIN', customer.gstin))
  lines.push(pair('Period', `${s.from} to ${s.to}`))
  lines.push(pair('Generated at', input.generatedAt))
  lines.push(pair('Opening balance', s.opening))
  lines.push(pair('Billed on account', s.debit))
  lines.push(pair('Received', s.credit))
  lines.push(pair('Closing balance', s.closing))
  if (s.stated !== null) lines.push(pair('Balance today', s.stated))
  lines.push(pair('Basis', 'Only amounts that went ON the account appear. Cash, UPI and card bills settled at the counter never moved this balance and are not listed.'))
  lines.push(pair('Basis', 'The closing balance is pinned to the account balance held on the customer master; the opening balance is derived back from it across the documents below.'))
  if (s.earlier > 0) {
    lines.push(pair('Basis', `${s.earlier} earlier document${s.earlier === 1 ? ' is' : 's are'} inside the opening balance and not itemised here.`))
  }
  if (!s.windowStartsInside) {
    lines.push(pair('Note', 'The opening balance also carries anything older than the loaded bill window, including a balance brought in from previous software.'))
  }
  if (!D.isZero(D.dec(s.after))) {
    lines.push(pair('Note', `Documents dated after this period move the account by ${s.after}, which is why the closing balance differs from the balance today.`))
  }
  lines.push(pair('Rows', String(s.entries.length)))

  lines.push('')
  lines.push(row(['Date', 'Document', 'Type', 'Particulars', 'Debit', 'Credit', 'Balance'].map((h) => csvCell(h, 'text'))))
  lines.push(row([
    csvCell(s.from, 'text'),
    '',
    csvCell('Opening', 'text'),
    csvCell('Balance brought forward', 'text'),
    '',
    '',
    csvCell(s.opening),
  ]))
  for (const e of s.entries) {
    lines.push(row([
      csvCell(e.date, 'text'),
      csvCell(e.ref, 'code'),
      csvCell(e.kind === 'bill' ? (e.voided ? 'Bill (voided)' : 'Bill') : 'Receipt', 'text'),
      csvCell(e.particulars, 'text'),
      csvCell(e.debit),
      csvCell(e.credit),
      csvCell(e.balance),
    ]))
  }
  lines.push(row([
    csvCell(s.to, 'text'),
    '',
    csvCell('Closing', 'text'),
    csvCell('Balance carried forward', 'text'),
    csvCell(s.debit),
    csvCell(s.credit),
    csvCell(s.closing),
  ]))

  return BOM + lines.join(CRLF) + CRLF
}

export function statementFilename(customer: Customer, s: Statement): string {
  const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `statement-${slug(customer.name) || `customer-${customer.id}`}-${s.from}_${s.to}.csv`
}

/** Kept apart from the serialiser so the escaping can be tested without a DOM —
 *  the part that goes wrong is never the anchor. */
export function downloadStatement(input: {
  store: StoreProfile | null
  customer: Customer
  statement: Statement
  generatedAt: string
}): void {
  const blob = new Blob([statementCsv(input)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = statementFilename(input.customer, input.statement)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
