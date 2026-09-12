import type {
  Customer, CustomerReceipt, CustomerReceiptInput, IsoDate, Money, ReceiptMode, SaleInvoice,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { daysUntil } from '@/lib/format'

/**
 * The receivable, as pure value logic.
 *
 * `Customer.outstanding` is one number, and one number cannot be argued with the
 * man at the counter. What settles a debt conversation is "these three bills
 * from March" — so everything below turns the account into bills with ages,
 * and every function here is a fold over arrays the screen already holds.
 *
 * THREE RULES, and each of them is a wrong answer if it goes the other way:
 *
 *  1. THE ADAPTER'S BALANCE IS AUTHORITATIVE. The buckets EXPLAIN it, they do
 *     not replace it. When they disagree — a balance carried in from the old
 *     software, bills older than the loaded window, money paid on account — the
 *     remainder is NAMED rather than absorbed. A stacked bar that silently
 *     fails to add up to the total printed beside it is how a screen loses its
 *     reader for good, and "nothing due" beside a live balance is worse still.
 *  2. AN UNREADABLE AMOUNT IS ABSENT, NEVER ZERO. `D.dec` throws on anything
 *     that is not a decimal string, which is right for arithmetic and wrong for
 *     a screen that must still render a half-migrated row. A confident ₹0.00
 *     receivable is the one wrong answer a shopkeeper would act on.
 *  3. RECEIPTS ARE APPLIED OLDEST BILL FIRST. A receipt carries no allocation
 *     (see `CustomerReceipt`), and oldest-first is the convention every Indian
 *     outstanding report uses. It is a DISPLAY rule, applied here and nowhere
 *     else, so no stored document is quietly rewritten by it.
 *
 * The payable side derives its own ageing in `pages/suppliers/SupplierDetail`.
 * The two are deliberately not one function: a payable ages against the
 * supplier's own credit days and reads `PurchaseInvoice.amountPaid`, while a
 * receivable has no agreed term on the contract at all and is built out of the
 * CREDIT tender on a sale. Merging them would mean inventing a customer credit
 * period, and an invented term makes every bucket boundary a guess.
 */

const DECIMALISH = /^-?\d+(\.\d+)?$/

/** Parse for display: a value that is not a decimal string is missing, not zero. */
export function money(v: string | null | undefined): D.Decimal | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return DECIMALISH.test(t) ? D.dec(t) : null
}

const money2 = (d: D.Decimal): Money => D.toStr(d, 2)

/** Whole days since a bill was raised. Null when the date is unreadable. */
export function ageInDays(iso: IsoDate, today: Date): number | null {
  const d = daysUntil(iso, today)
  // Subtracted rather than negated: `-d` hands back a negative zero for a bill
  // raised today, which every comparison treats as zero and `Object.is` does not.
  return Number.isFinite(d) ? 0 - d : null
}

/**
 * '+91 98220 41100', '098220 41100' and '9822041100' are one number.
 *
 * The same normalisation `prepareCustomer` applies before it stores one, and it
 * has to be the same: the search box would otherwise fail to find a customer
 * whose number the master had happily accepted, which at a counter reads as "not
 * registered" and gets them entered a second time. The two copies exist because
 * the adapter imports this module, so the dependency cannot run the other way.
 */
function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

/**
 * What went ON THE ACCOUNT on this bill.
 *
 * Not the bill total: a split-tender bill takes ₹300 in cash and ₹200 on
 * credit, and only the ₹200 is a receivable. Reading `netAmount` here would age
 * the whole day's takings against every credit customer.
 */
export function creditTaken(invoice: SaleInvoice): D.Decimal {
  let credit = D.ZERO
  for (const p of invoice.payments) {
    if (p.mode !== 'CREDIT') continue
    const amount = money(p.amount)
    if (amount) credit = D.add(credit, amount)
  }
  return credit
}

// ----------------------------------------------------------------- ageing ---

export type AgeingKey = 'b30' | 'b60' | 'b90' | 'b90p'

export interface AgeingBucket {
  key: AgeingKey
  /** Spelled out. The bar carries severity; the word carries the meaning. */
  label: string
  short: string
  tone: string
  amount: Money
  count: number
}

interface BucketSpec {
  key: AgeingKey
  label: string
  short: string
  tone: string
  /** Inclusive upper bound in days; null closes the series. */
  upTo: number | null
}

/* Green → amber → orange → red, in one direction, and every segment is also
   labelled wherever it is drawn — the ramp reinforces the meaning and is never
   the only thing carrying it. */
const BUCKET_SPECS: BucketSpec[] = [
  { key: 'b30', label: '0–30 days', short: '0–30', tone: 'var(--success-11)', upTo: 30 },
  { key: 'b60', label: '31–60 days', short: '31–60', tone: 'var(--warning-11)', upTo: 60 },
  { key: 'b90', label: '61–90 days', short: '61–90', tone: 'var(--status-expiry-60)', upTo: 90 },
  { key: 'b90p', label: 'Over 90 days', short: '90+', tone: 'var(--danger-11)', upTo: null },
]

export interface Receivable {
  /** Always four, always in age order, even when every one of them is zero. */
  buckets: AgeingBucket[]
  /** Sum of the buckets: what is owed on bills inside the loaded window. */
  onBills: Money
  /** The adapter's figure. Authoritative; the buckets explain it. */
  outstanding: Money
  /**
   * `outstanding` − `onBills`, when the two disagree.
   *
   * Positive means bills older than the loaded window, or a balance carried in
   * from the previous software — either way there is money owed that no loaded
   * bill accounts for, and the row has to say so instead of showing an empty
   * bar. Negative means more has been received than the loaded bills carried:
   * an advance, sitting on account.
   */
  unallocated: Money | null
  /** Bills past ninety days — the number a shop actually chases. */
  over90: Money
  oldestDays: number | null
  openCount: number
  /** Receipts applied to the loaded bills. Nothing is stored; see rule 3. */
  applied: Money
}

interface OpenBill {
  age: number
  credit: D.Decimal
  /** Ordering key, so two bills on one day settle in a stable sequence. */
  id: number
}

const zeroBuckets = (): Array<{ amount: D.Decimal; count: number }> =>
  BUCKET_SPECS.map(() => ({ amount: D.ZERO, count: 0 }))

function toBuckets(totals: ReadonlyArray<{ amount: D.Decimal; count: number }>): AgeingBucket[] {
  return BUCKET_SPECS.map((spec, i) => ({
    key: spec.key,
    label: spec.label,
    short: spec.short,
    tone: spec.tone,
    amount: money2(totals[i]?.amount ?? D.ZERO),
    count: totals[i]?.count ?? 0,
  }))
}

const over90Of = (buckets: readonly AgeingBucket[]): Money =>
  buckets.find((b) => b.key === 'b90p')?.amount ?? '0.00'

/**
 * One customer's receivable, bill by bill.
 *
 * Bucketed on the BILL DATE, which is what every Indian outstanding report does
 * and the only thing the contract supports — `Customer` carries no agreed credit
 * period, so there is no due date to measure against and this deliberately does
 * not invent one. A voided bill owes nothing and is skipped; a bill whose date
 * cannot be read is skipped too, and its money resurfaces in `unallocated`
 * rather than being filed under a bucket that would be a guess.
 */
export function receivableOf(
  customer: Customer,
  bills: readonly SaleInvoice[],
  receipts: readonly CustomerReceipt[],
  today: Date,
): Receivable {
  const open: OpenBill[] = []
  for (const inv of bills) {
    if (inv.status !== 'POSTED') continue
    const credit = creditTaken(inv)
    if (!D.gt(credit, D.ZERO)) continue
    const age = ageInDays(inv.invoiceDate, today)
    if (age === null) continue
    open.push({ age, credit, id: inv.id })
  }
  // Oldest first, and the id breaks the tie: an unstable order would settle a
  // different bill between two renders that changed nothing, and the buckets
  // would shuffle on their own.
  open.sort((a, b) => b.age - a.age || a.id - b.id)

  let pool = D.ZERO
  for (const r of receipts) {
    const amount = money(r.amount)
    if (amount) pool = D.add(pool, amount)
  }
  const received = pool

  const totals = zeroBuckets()
  let oldestDays: number | null = null
  let openCount = 0

  for (const bill of open) {
    const settled = D.min(pool, bill.credit)
    pool = D.sub(pool, settled)
    const balance = D.sub(bill.credit, settled)
    if (!D.gt(balance, D.ZERO)) continue

    openCount += 1
    if (oldestDays === null || bill.age > oldestDays) oldestDays = bill.age

    const found = BUCKET_SPECS.findIndex((b) => b.upTo !== null && bill.age <= b.upTo)
    const slot = totals[found === -1 ? totals.length - 1 : found]
    if (slot) {
      slot.amount = D.add(slot.amount, balance)
      slot.count += 1
    }
  }

  const buckets = toBuckets(totals)
  const onBills = D.sum(totals.map((t) => t.amount))
  const stated = money(customer.outstanding)
  const gap = stated ? D.sub(stated, onBills) : null

  return {
    buckets,
    onBills: money2(onBills),
    // The raw string when it cannot be parsed, so a half-migrated row shows what
    // is actually stored rather than a zero this function made up.
    outstanding: stated ? money2(stated) : customer.outstanding,
    unallocated: gap && !D.isZero(gap) ? money2(gap) : null,
    over90: over90Of(buckets),
    oldestDays,
    openCount,
    applied: money2(D.sub(received, pool)),
  }
}

/**
 * The whole book, aged.
 *
 * Folded from the per-customer results rather than recomputed over every bill,
 * so the header total and the numbers under it are provably the same arithmetic
 * the rows show. A summary that can disagree with the list it summarises is the
 * fastest way to lose a screen's credibility.
 *
 * `unallocated` stays null unless at least one customer had one: a book where
 * every balance ties to a loaded bill should say nothing rather than say zero.
 */
export function mergeReceivable(parts: readonly Receivable[]): Receivable {
  const totals = zeroBuckets()
  let onBills = D.ZERO
  let outstanding = D.ZERO
  let unallocated = D.ZERO
  let anyUnallocated = false
  let applied = D.ZERO
  let oldestDays: number | null = null
  let openCount = 0

  for (const part of parts) {
    part.buckets.forEach((b, i) => {
      const slot = totals[i]
      const value = money(b.amount)
      if (!slot || !value) return
      slot.amount = D.add(slot.amount, value)
      slot.count += b.count
    })
    onBills = D.add(onBills, money(part.onBills) ?? D.ZERO)
    outstanding = D.add(outstanding, money(part.outstanding) ?? D.ZERO)
    if (part.unallocated) {
      anyUnallocated = true
      unallocated = D.add(unallocated, money(part.unallocated) ?? D.ZERO)
    }
    applied = D.add(applied, money(part.applied) ?? D.ZERO)
    openCount += part.openCount
    if (part.oldestDays !== null && (oldestDays === null || part.oldestDays > oldestDays)) {
      oldestDays = part.oldestDays
    }
  }

  const buckets = toBuckets(totals)
  return {
    buckets,
    onBills: money2(onBills),
    outstanding: money2(outstanding),
    /* Zero is not a remainder. One customer carrying ₹5,000 from the old
       software and another sitting on a ₹5,000 advance cancel exactly, and the
       book then reconciles to its buckets — so it must say nothing rather than
       print "Not aged ₹0.00", which is the same rule a single row follows. */
    unallocated: anyUnallocated && !D.isZero(unallocated) ? money2(unallocated) : null,
    over90: over90Of(buckets),
    oldestDays,
    openCount,
    applied: money2(applied),
  }
}

/**
 * The remainder as a MAGNITUDE, with its direction as a flag.
 *
 * `unallocated` is signed — negative is money received beyond what the loaded
 * bills carried — and every place that draws it labels the direction in words
 * first ("Paid on account", "Older than the loaded bills"). Handing those labels
 * the signed string prints the direction twice, once of them backwards: "Paid on
 * account −₹500" reads as a negative payment, and it contradicts the sentence
 * under it, which already takes the absolute value. So the sign is decided here,
 * once, and the figure that comes out is unsigned.
 *
 * Null when there is nothing to say — including when a book's carried balances
 * and its advances cancel, which is a remainder of zero and not a remainder.
 */
export interface UnallocatedNote {
  /** True when more was received than the loaded bills carried. */
  credit: boolean
  /** Unsigned. The label carries the direction; the figure must not repeat it. */
  amount: Money
}

export function unallocatedNote(r: Receivable): UnallocatedNote | null {
  const gap = money(r.unallocated)
  if (!gap || D.isZero(gap)) return null
  return { credit: D.isNeg(gap), amount: money2(D.abs(gap)) }
}

export type ReceivableNoteKind =
  | 'unreadable'
  | 'aged'
  | 'open'
  | 'carried'
  | 'onAccount'
  | 'clear'

export interface ReceivableNote {
  kind: ReceivableNoteKind
  /** The amount the note is about, when it is about one. */
  amount: Money | null
  /** Bills behind it, when there are any. */
  count: number
  /**
   * Money owed that the loaded bills DO NOT account for, when the note is
   * already about something else.
   *
   * A customer can be both: two bills inside 30 days AND eight thousand rupees
   * brought in from the previous software. The kind can only be one of those,
   * and 'aged' and 'open' both won on precedence — so the row said "2 open
   * bills" and the larger, older, un-ageable money went unmentioned. That is the
   * file's own rule ("a row must not go quiet about money owed") broken by the
   * precedence meant to enforce it. Reordering would only move the silence onto
   * the other half, so the note carries both and the row prints both.
   *
   * Null when there is nothing extra, which is the ordinary case.
   */
  carried: Money | null
}

/**
 * What a row is allowed to SAY about a balance it could not fully age.
 *
 * The precedence is the whole point. `clear` sits last and is reachable only
 * when there is genuinely nothing owed — because "Nothing due" printed beside a
 * live figure is not a cosmetic slip, it is the screen telling a shopkeeper to
 * stop chasing money they are owed. The payable side shipped exactly that bug:
 * an opening balance with no bill behind it aged to four zeros and the row went
 * quiet.
 *
 * `unreadable` outranks everything for the same reason. A balance that will not
 * parse is unknown, and unknown is not nothing.
 *
 * The ACCOUNT decides first, not the buckets. A customer whose balance is zero
 * owes nothing even while the loaded window still shows the bills their receipts
 * cleared, and announcing "1 open bill" there sends somebody to chase money that
 * has already been paid — the same error as the one above, pointing the other
 * way.
 */
export function receivableNote(r: Receivable): ReceivableNote {
  const stated = money(r.outstanding)
  if (stated === null) return { kind: 'unreadable', amount: null, count: 0, carried: null }

  if (!D.gt(stated, D.ZERO)) {
    const settled = money(r.unallocated)
    return settled && D.isNeg(settled)
      ? { kind: 'onAccount', amount: money2(D.abs(settled)), count: 0, carried: null }
      : { kind: 'clear', amount: null, count: 0, carried: null }
  }

  /* The remainder the loaded bills cannot explain, only when it is genuinely
     owed. A NEGATIVE remainder is an advance and belongs to `unallocatedNote`,
     which labels the direction in words; reported here it would read as more
     money owed, pointing the wrong way. */
  const gap = money(r.unallocated)
  const extra = gap && D.gt(gap, D.ZERO) ? money2(gap) : null

  const over90 = money(r.over90)
  if (over90 && D.gt(over90, D.ZERO)) {
    const count = r.buckets.find((b) => b.key === 'b90p')?.count ?? 0
    return { kind: 'aged', amount: r.over90, count, carried: extra }
  }
  if (r.openCount > 0) {
    return { kind: 'open', amount: r.onBills, count: r.openCount, carried: extra }
  }
  // Owed, but no loaded bill accounts for it: a balance carried in from the
  // previous software, or bills older than the window. The remainder IS the
  // note here, so it is not repeated as a second clause.
  return { kind: 'carried', amount: r.unallocated ?? r.outstanding, count: 0, carried: null }
}

// ----------------------------------------------------------- credit limit ---

export type CreditTone = 'ok' | 'near' | 'over' | 'unset'

export interface CreditStanding {
  tone: CreditTone
  /** ALWAYS present, and always the carrier of the meaning. The bar reinforces. */
  word: string
  /** True whenever more is owed than was agreed — including when nothing was. */
  overLimit: boolean
  /** How far past the agreed limit. Null unless over. */
  overBy: Money | null
  /**
   * Geometry for the meter, or null when there is no limit to draw against.
   *
   * A bar with no maximum is a lie, and "no credit agreed" is a real and common
   * answer — so a customer with no limit gets the WORDS and no bar, rather than
   * a full red bar that would read as a limit they had blown.
   */
  meter: { width: number; valueNow: number; fill: string; track: string } | null
}

/**
 * Credit used against the limit the shop granted this customer.
 *
 * Widths are geometry, not money: the amounts stay decimal strings and only the
 * ratio is ever taken to a float, because a pixel does not need paise.
 *
 * The zero-limit case is the one that matters and the one usually got wrong. A
 * customer with no agreed limit who nevertheless owes ₹500 has been given credit
 * nobody approved — that is the single most useful thing this screen can point
 * at, so it is `overLimit` with words and no bar, not a quiet dash.
 *
 * (The billing panel carries an inline twin of this geometry for the attached
 * customer. This is the tested one, and the panel's should collapse into it the
 * next time that file is opened for another reason.)
 */
export function creditStanding(outstanding: Money, creditLimit: Money): CreditStanding {
  const used = money(outstanding)
  const cap = money(creditLimit)

  if (!used) {
    return { tone: 'unset', word: 'Balance unreadable', overLimit: false, overBy: null, meter: null }
  }

  if (!cap || !D.gt(cap, D.ZERO)) {
    if (D.gt(used, D.ZERO)) {
      return {
        tone: 'over',
        word: `No credit agreed — ${money2(used)} outstanding anyway`,
        overLimit: true,
        overBy: money2(used),
        meter: null,
      }
    }
    return { tone: 'unset', word: 'No credit limit set', overLimit: false, overBy: null, meter: null }
  }

  const pct = D.toNumber(D.div(D.mul(used, D.HUNDRED), cap))
  const valueNow = Math.max(0, Math.round(pct))

  if (D.gt(used, cap)) {
    const overBy = money2(D.sub(used, cap))
    return {
      tone: 'over',
      word: `Over the limit by ${overBy}`,
      overLimit: true,
      overBy,
      meter: { width: 100, valueNow, fill: 'var(--danger-9)', track: 'var(--danger-3)' },
    }
  }

  const width = Math.min(100, Math.max(0, pct))
  if (pct >= 75) {
    return {
      tone: 'near',
      word: `${valueNow}% used — close to the limit`,
      overLimit: false,
      overBy: null,
      meter: { width, valueNow, fill: 'var(--warning-9)', track: 'var(--warning-3)' },
    }
  }
  return {
    tone: 'ok',
    word: `${valueNow}% of the limit used`,
    overLimit: false,
    overBy: null,
    meter: { width, valueNow, fill: 'var(--success-9)', track: 'var(--success-3)' },
  }
}

// ------------------------------------------------------------------- rows ---

export interface CustomerRow {
  customer: Customer
  receivable: Receivable
  credit: CreditStanding
  /** This customer's bills out of the loaded window, newest first. */
  bills: readonly SaleInvoice[]
  /** This customer's receipts, newest first. */
  receipts: readonly CustomerReceipt[]
  lastPurchase: IsoDate | null
  lastReceipt: CustomerReceipt | null
  /** Parsed ONCE: comparing the strings would put '9,00,000' below '95'. */
  outstanding: D.Decimal
  haystack: string
}

const EMPTY_BILLS: readonly SaleInvoice[] = []
const EMPTY_RECEIPTS: readonly CustomerReceipt[] = []

/** Newest first, id breaking the tie — one ordering, so every consumer agrees. */
function newestFirst(a: SaleInvoice, b: SaleInvoice): number {
  return b.invoiceDate.localeCompare(a.invoiceDate) || b.id - a.id
}

/**
 * Group a window of bills and every receipt onto the customer book.
 *
 * One pass, and the grouping is done here rather than per selection: there is no
 * per-customer bill call worth making when the numbers are already in memory,
 * and arrowing down the list would otherwise be N+1 round trips.
 */
export function buildRows(
  customers: readonly Customer[],
  bills: readonly SaleInvoice[],
  receipts: readonly CustomerReceipt[],
  today: Date,
): CustomerRow[] {
  const billsBy = new Map<number, SaleInvoice[]>()
  for (const inv of bills) {
    if (inv.customerId === null) continue
    const list = billsBy.get(inv.customerId)
    if (list) list.push(inv)
    else billsBy.set(inv.customerId, [inv])
  }
  for (const list of billsBy.values()) list.sort(newestFirst)

  const receiptsBy = new Map<number, CustomerReceipt[]>()
  for (const r of receipts) {
    const list = receiptsBy.get(r.customerId)
    if (list) list.push(r)
    else receiptsBy.set(r.customerId, [r])
  }
  for (const list of receiptsBy.values()) {
    list.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  }

  return customers.map((customer) => {
    const own = billsBy.get(customer.id) ?? EMPTY_BILLS
    const paid = receiptsBy.get(customer.id) ?? EMPTY_RECEIPTS
    const posted = own.find((inv) => inv.status === 'POSTED')
    return {
      customer,
      receivable: receivableOf(customer, own, paid, today),
      credit: creditStanding(customer.outstanding, customer.creditLimit),
      bills: own,
      receipts: paid,
      lastPurchase: posted?.invoiceDate ?? null,
      lastReceipt: paid[0] ?? null,
      outstanding: money(customer.outstanding) ?? D.ZERO,
      haystack: [
        customer.name,
        customer.phone,
        customer.gstin ?? '',
        customer.address ?? '',
        customer.allergies.join(' '),
      ].join(' ').toLowerCase(),
    }
  })
}

export interface BookSummary {
  receivable: Receivable
  /** Rows carrying a positive balance. */
  onCredit: number
  /** Rows owing more than was agreed — a zero limit with a balance counts. */
  overLimit: number
  customers: number
}

/** The book is the WHOLE book, never the filtered view: a total that moves when
 *  a chip is pressed is not a total. */
export function summarise(rows: readonly CustomerRow[]): BookSummary {
  let onCredit = 0
  let overLimit = 0
  for (const row of rows) {
    if (D.gt(row.outstanding, D.ZERO)) onCredit += 1
    if (row.credit.overLimit) overLimit += 1
  }
  return {
    receivable: mergeReceivable(rows.map((r) => r.receivable)),
    onCredit,
    overLimit,
    customers: rows.length,
  }
}

// ---------------------------------------------------------------- filters ---

export type ViewKey = 'all' | 'owes' | 'overlimit' | 'aged' | 'allergies' | 'nophone'
export type SortKey = 'name' | 'outstanding' | 'oldest' | 'recent'

export const VIEW_VALUES: ViewKey[] = ['all', 'owes', 'overlimit', 'aged', 'allergies', 'nophone']
export const SORT_VALUES: SortKey[] = ['name', 'outstanding', 'oldest', 'recent']

/**
 * The presets that can only be answered once the bill window has landed.
 *
 * Until then every ageing is a zero, so "Past 90 days" would match nobody — and
 * an empty list under it reads as "nothing is that old", which is the one answer
 * a shopkeeper would act on and the one the data cannot support yet. `owes` and
 * `overlimit` are deliberately NOT here: both read `Customer.outstanding`, which
 * arrives with the customer.
 */
export const BILL_BACKED_VIEWS: ReadonlySet<ViewKey> = new Set<ViewKey>(['aged'])

export interface FilterState {
  term: string
  view: ViewKey
  sort: SortKey
}

export const DEFAULT_FILTERS: FilterState = { term: '', view: 'all', sort: 'name' }

export function isFiltered(f: FilterState): boolean {
  return f.term.trim() !== '' || f.view !== 'all'
}

export function matchesTerm(row: CustomerRow, term: string): boolean {
  if (row.haystack.includes(term)) return true
  /* Normalised digits against normalised digits, so a number read off a card
     with its +91 finds the same person as the ten typed at the counter. Guarded
     on length because `''.includes('')` is true: an unguarded empty digit run
     would match every row through this clause and make a name search useless. */
  const digits = phoneDigits(term)
  return digits.length >= 4 && phoneDigits(row.customer.phone).includes(digits)
}

export function matchesView(row: CustomerRow, view: ViewKey): boolean {
  if (view === 'all') return true
  if (view === 'owes') return D.gt(row.outstanding, D.ZERO)
  if (view === 'overlimit') return row.credit.overLimit
  if (view === 'allergies') return row.customer.allergies.length > 0
  /* Short of ten digits, not merely blank. A half-typed number is exactly as
     unreachable as none, and it is the one a clean-up pass has to find. */
  if (view === 'nophone') return phoneDigits(row.customer.phone).length < 10
  return D.gt(D.dec(row.receivable.over90), D.ZERO)
}

export function compareRows(sort: SortKey, a: CustomerRow, b: CustomerRow): number {
  const primary =
    sort === 'outstanding' ? D.cmp(b.outstanding, a.outstanding)
      : sort === 'oldest' ? (b.receivable.oldestDays ?? -1) - (a.receivable.oldestDays ?? -1)
        : sort === 'recent' ? (b.lastPurchase ?? '').localeCompare(a.lastPurchase ?? '')
          : a.customer.name.localeCompare(b.customer.name)
  // Ties break on id, without exception: an unstable order makes the highlight
  // land on a different row between two renders that changed nothing.
  return primary || a.customer.id - b.customer.id
}

/** Search and the presets refine in the browser, which is EXACT here because
 *  `listCustomers` returns the complete book. */
export function filterRows(rows: readonly CustomerRow[], f: FilterState): CustomerRow[] {
  const term = f.term.trim().toLowerCase()
  return rows
    .filter((r) => (term === '' || matchesTerm(r, term)) && matchesView(r, f.view))
    .sort((a, b) => compareRows(f.sort, a, b))
}

// ------------------------------------------------------------ the window ---

export interface BillPage {
  rows: SaleInvoice[]
  nextCursor: number | null
}

/**
 * Assemble the bill window by FOLLOWING THE CURSOR.
 *
 * `listCustomerBills` is a paged call and an adapter is free to serve fewer rows
 * than the limit asked for — the local one clamps a page at 200. Trusting one
 * call would make the window size a wish: the ageing would come off a fraction
 * of the register and every older bill would drift into "not aged" for no reason
 * the reader could see.
 *
 * Both loop guards are load-bearing. An exhausted register ends it; so does a
 * cursor that fails to advance, which is the one way a paging bug here could
 * spin a browser tab forever.
 */
export async function collectBills(
  fetchPage: (q: { limit: number; cursor?: number }) => Promise<BillPage>,
  size: number,
): Promise<SaleInvoice[]> {
  const rows: SaleInvoice[] = []
  let cursor: number | undefined
  while (rows.length < size) {
    const page = await fetchPage({
      limit: size - rows.length,
      ...(cursor === undefined ? {} : { cursor }),
    })
    rows.push(...page.rows)
    if (page.nextCursor === null || page.rows.length === 0) break
    if (cursor !== undefined && page.nextCursor <= cursor) break
    cursor = page.nextCursor
  }
  return rows
}

// --------------------------------------------------------------- receipts ---

function receiptInvalid(field: string, message: string): ApiError {
  return new ApiError({ code: 'RECEIPT_INVALID', message, details: { field } })
}

const RECEIPT_MODES: ReceiptMode[] = ['CASH', 'UPI', 'CARD']

export interface ReceiptStamp {
  id: number
  storeId: number
  receiptNo: string
  at: string
  date: IsoDate
}

/**
 * Validate money taken against an account, and compute the balance it leaves.
 *
 * Three refusals, and each is a different kind of wrong:
 *  - ZERO records a payment that did not happen. It leaves a document in the
 *    register that has to be explained later and settles nothing now.
 *  - NEGATIVE is a refund, which moves money the other way and needs the
 *    opposite document. Letting it through here would let a receipt silently
 *    INCREASE a debt.
 *  - MORE THAN THE BALANCE is an advance. That is a real thing a customer does,
 *    and it is a different document with different tax treatment — GST calls it
 *    a receipt voucher against a supply not yet made. Quietly driving the
 *    account negative would hide it, and the next bill would be discounted by
 *    money nobody could trace.
 */
export function prepareReceipt(
  input: CustomerReceiptInput,
  customer: Customer,
  stamp: ReceiptStamp,
): CustomerReceipt {
  const mode = RECEIPT_MODES.find((m) => m === input.mode)
  if (!mode) {
    throw receiptInvalid('mode', 'A receipt is taken in cash, by UPI or by card')
  }

  const raw = (input.amount ?? '').trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw receiptInvalid('amount', 'Amount in rupees, e.g. 500 or 500.50')
  }
  const amount = D.dec(raw)
  if (D.isZero(amount)) {
    throw receiptInvalid('amount', 'A receipt of nothing settles nothing')
  }
  if (D.isNeg(amount)) {
    throw receiptInvalid('amount', 'A receipt cannot be negative — a refund is a different document')
  }

  const balance = money(customer.outstanding)
  if (!balance) {
    throw receiptInvalid('amount', `${customer.name}'s balance cannot be read, so nothing can be set against it`)
  }
  if (!D.gt(balance, D.ZERO)) {
    throw receiptInvalid('amount', `${customer.name} owes nothing`)
  }
  if (D.gt(amount, balance)) {
    throw receiptInvalid(
      'amount',
      `That is more than the ${money2(balance)} outstanding. Take the balance, or record the excess as an advance.`,
    )
  }

  const reference = (input.reference ?? '').trim()
  const note = (input.note ?? '').trim().replace(/\s+/g, ' ')
  return {
    id: stamp.id,
    storeId: stamp.storeId,
    receiptNo: stamp.receiptNo,
    customerId: customer.id,
    at: stamp.at,
    date: stamp.date,
    amount: money2(amount),
    mode,
    reference: reference ? reference : null,
    note: note ? note : null,
    balanceAfter: money2(D.sub(balance, amount)),
  }
}

/**
 * Read a stored receipt list back defensively.
 *
 * Anything malformed is dropped rather than trusted: a receipt with no amount
 * would be counted as a zero-rupee payment against the account, which reads as
 * "we took money and it settled nothing". Dropping it makes the balance
 * disagree with the register loudly, which is the failure a person notices.
 */
export function coerceReceipts(raw: unknown): CustomerReceipt[] {
  if (!Array.isArray(raw)) return []
  const out: CustomerReceipt[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const src = item as Record<string, unknown>
    const mode = RECEIPT_MODES.find((m) => m === src.mode)
    if (
      typeof src.id !== 'number' ||
      typeof src.customerId !== 'number' ||
      typeof src.receiptNo !== 'string' ||
      typeof src.at !== 'string' ||
      mode === undefined ||
      money(typeof src.amount === 'string' ? src.amount : null) === null
    ) continue
    out.push({
      id: src.id,
      storeId: typeof src.storeId === 'number' ? src.storeId : 0,
      receiptNo: src.receiptNo,
      customerId: src.customerId,
      at: src.at,
      date: typeof src.date === 'string' ? src.date : src.at.slice(0, 10),
      amount: src.amount as Money,
      mode,
      reference: typeof src.reference === 'string' ? src.reference : null,
      note: typeof src.note === 'string' ? src.note : null,
      balanceAfter: typeof src.balanceAfter === 'string' ? src.balanceAfter : '0.00',
    })
  }
  return out
}
