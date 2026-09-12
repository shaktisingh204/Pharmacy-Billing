import type {
  CreditNote, Customer, DocSeriesSummary, FilingCheck, FilingIssue, FilingThresholds,
  IsoDate, Money, SaleInvoice, StoreProfile,
} from '@contract'
import * as D from '@/domain/decimal'

/**
 * Is this period fit to file? — as pure value logic.
 *
 * The screen this feeds exists because the alternative is finding out from the
 * portal. A GSTR-1 rejected at upload gives an error against a line number in a
 * JSON nobody wrote by hand, at the end of the month, usually on the due date.
 * Every check below is something that can be known WEEKS earlier from documents
 * the shop already has.
 *
 * Two rules hold the whole file together:
 *
 *  1. NOTHING HERE ASSERTS THE LAW. Every threshold arrives from
 *     `StoreProfile.filing`, every one of them is recorded in
 *     `docs/UNVERIFIED.md`, and the figure actually used is printed in `basis`
 *     so a reader can check it against the notification rather than against
 *     RxBill's confidence. A compliance screen that states an unverified
 *     threshold as fact is worse than no compliance screen — it is believed.
 *
 *  2. A BLOCKER IS SOMETHING THAT WILL BE REJECTED; EVERYTHING ELSE IS A
 *     WARNING. Reporting a judgement call as a hard failure is how a screen
 *     like this gets ignored, and once it is ignored the real blockers go with
 *     it.
 */

export const DEFAULT_THRESHOLDS: FilingThresholds = {
  /* The higher of the two conflicting figures. Shipping the LOWER one would
     mark invoices as B2CL that may not be, which reads as RxBill knowing
     something it does not; the higher one under-reports the bucket count, which
     is visible and correctable. Neither is filed on. */
  b2clMinimum: '250000.00',
  rule46Minimum: '50000.00',
  hsnDigits: 6,
}

const money = (d: D.Decimal): Money => D.toStr(d, 2) as Money

/** Documents named on an issue. Beyond this the count carries the truth — a
 *  list of four hundred invoice numbers is not something anybody reads. */
const MAX_REFS = 8

interface Bucket {
  key: string
  label: string
  count: number
  taxableValue: D.Decimal
}

export interface FilingInputs {
  invoices: readonly SaleInvoice[]
  creditNotes: readonly CreditNote[]
  customers: readonly Customer[]
  store: StoreProfile
  generatedAt: string
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/

/** The two leading digits of a GSTIN are the state. Everything else about it is
 *  format, and format is all that can be checked without the portal. */
const stateOf = (gstin: string): string => gstin.trim().slice(0, 2)

function issue(
  code: string,
  severity: FilingIssue['severity'],
  title: string,
  detail: string,
  refs: readonly string[],
): FilingIssue {
  return { code, severity, title, detail, refs: refs.slice(0, MAX_REFS), count: refs.length }
}

/**
 * Series totals for Table 13.
 *
 * A cancelled document still consumed its number and still has to be reported —
 * which is exactly why `voidSale` keeps the document in place rather than
 * deleting it. A series that reports fewer numbers than it burned is a gap, and
 * a gap is the single thing most likely to be asked about.
 */
export function seriesSummaries(
  invoices: readonly SaleInvoice[],
  creditNotes: readonly CreditNote[],
): DocSeriesSummary[] {
  const groups = new Map<string, { label: string; nos: string[]; cancelled: number }>()

  const add = (no: string, cancelled: boolean, label: string) => {
    /* Grouped by the series PREFIX — everything up to the last hyphen — so
       RX2627-T1-00001 and RX2627-T2-00001 are two series, which they are: the
       numbering is per terminal and reporting them as one produces duplicates. */
    const key = no.slice(0, no.lastIndexOf('-') + 1) || no
    const g = groups.get(key) ?? { label, nos: [], cancelled: 0 }
    g.nos.push(no)
    if (cancelled) g.cancelled += 1
    groups.set(key, g)
  }

  for (const inv of invoices) add(inv.invoiceNo, inv.status === 'VOIDED', 'Tax invoice')
  for (const note of creditNotes) add(note.creditNoteNo, false, 'Credit note')

  return [...groups.entries()]
    .map(([, g]) => {
      const sorted = [...g.nos].sort()
      return {
        label: g.label,
        from: sorted[0] ?? '',
        to: sorted[sorted.length - 1] ?? '',
        total: g.nos.length,
        cancelled: g.cancelled,
        net: g.nos.length - g.cancelled,
      }
    })
    .sort((a, b) => a.from.localeCompare(b.from))
}

export function checkFiling(
  from: IsoDate,
  to: IsoDate,
  inputs: FilingInputs,
): FilingCheck {
  const { store } = inputs
  const t = store.filing ?? DEFAULT_THRESHOLDS
  const homeState = store.stateCode.trim()

  const inPeriod = inputs.invoices.filter((i) => i.invoiceDate >= from && i.invoiceDate <= to)
  const notesInPeriod = inputs.creditNotes.filter((n) => n.issuedOn >= from && n.issuedOn <= to)
  const posted = inPeriod.filter((i) => i.status === 'POSTED')
  const byId = new Map(inputs.customers.map((c) => [c.id, c]))

  const issues: FilingIssue[] = []
  const buckets = new Map<string, Bucket>()
  const bump = (key: string, label: string, taxable: D.Decimal) => {
    const b = buckets.get(key) ?? { key, label, count: 0, taxableValue: D.ZERO }
    b.count += 1
    b.taxableValue = D.add(b.taxableValue, taxable)
    buckets.set(key, b)
  }

  const badGstin: string[] = []
  const wrongStateGstin: string[] = []
  const missingRule46: string[] = []
  const noHsn: string[] = []
  const shortHsn: string[] = []
  const doesNotFoot: string[] = []
  const orphanNotes: string[] = []
  const zeroRated: string[] = []

  let taxable = D.ZERO
  let cgst = D.ZERO
  let sgst = D.ZERO
  let igst = D.ZERO

  for (const inv of posted) {
    const q = inv.quote
    const lineTaxable = D.dec(q.taxableValue)
    taxable = D.add(taxable, lineTaxable)
    cgst = D.add(cgst, D.dec(q.cgst))
    sgst = D.add(sgst, D.dec(q.sgst))
    igst = D.add(igst, D.dec(q.igst))

    /* The invoice must FOOT. taxable + tax + round-off = net, exactly. A bill
       that does not is a bill the portal will reject, and it is the one defect
       nobody finds by reading a summary — the summary adds up either way. */
    const sum = D.sum([lineTaxable, D.dec(q.cgst), D.dec(q.sgst), D.dec(q.igst), D.dec(q.roundOff)])
    if (D.cmp(sum, D.dec(q.netAmount)) !== 0) doesNotFoot.push(inv.invoiceNo)

    const customer = inv.customerId === null ? undefined : byId.get(inv.customerId)
    const gstin = customer?.gstin?.trim() ?? ''
    const b2b = gstin !== ''

    if (b2b) {
      if (!GSTIN.test(gstin)) badGstin.push(inv.invoiceNo)
      /* A GSTIN whose state does not match the place of supply the invoice was
         taxed at means one of the two is wrong, and the return will carry an
         inter-state supply taxed as intra-state or the reverse. */
      else if ((stateOf(gstin) !== homeState) !== inv.interState) {
        wrongStateGstin.push(inv.invoiceNo)
      }
      bump('b2b', 'B2B — registered buyer', lineTaxable)
    } else if (inv.interState && D.gte(D.dec(q.netAmount), D.dec(t.b2clMinimum))) {
      bump('b2cl', 'B2CL — inter-state, above the threshold', lineTaxable)
    } else {
      bump('b2cs', 'B2CS — counter', lineTaxable)
      /* Rule 46 wants the recipient named above a value. Only ever a WARNING:
         the threshold itself is unverified, and a shop that has the details on
         paper is not non-compliant because RxBill cannot see them. */
      if (D.gte(D.dec(q.netAmount), D.dec(t.rule46Minimum)) && !customer) {
        missingRule46.push(inv.invoiceNo)
      }
    }

    for (const line of q.lines) {
      /* The HSN SNAPSHOTTED ON THE LINE, not today's master. The return is
         built from what the invoice actually carried; reading the master would
         report a period as clean because somebody fixed the medicine last week,
         while the filed document still says nothing. */
      const hsn = line.hsnCode.trim()
      if (hsn === '') noHsn.push(inv.invoiceNo)
      else if (hsn.length < t.hsnDigits) shortHsn.push(inv.invoiceNo)

      /* Nil-rated is read off the line's OWN tax, for the same reason: a line
         that carried no tax carried no tax, whatever rate the master holds now. */
      const lineTax = D.sum([D.dec(line.cgst), D.dec(line.sgst), D.dec(line.igst)])
      if (D.isZero(lineTax) && D.gt(D.dec(line.taxableValue), D.ZERO)) {
        zeroRated.push(inv.invoiceNo)
      }
    }
  }

  const invoiceNos = new Set(inputs.invoices.map((i) => i.invoiceNo))
  for (const note of notesInPeriod) {
    const parent = inputs.invoices.find((i) => i.id === note.invoiceId)
    if (!parent || !invoiceNos.has(parent.invoiceNo)) orphanNotes.push(note.creditNoteNo)
    taxable = D.sub(taxable, D.dec(note.taxableValue))
    cgst = D.sub(cgst, D.dec(note.cgst))
    sgst = D.sub(sgst, D.dec(note.sgst))
    igst = D.sub(igst, D.dec(note.igst))
    bump('cdnr', 'Credit notes', D.neg(D.dec(note.taxableValue)))
  }

  // ------------------------------------------------------------- blockers ---

  if (!GSTIN.test(store.gstin.trim())) {
    issues.push(issue(
      'STORE_GSTIN_INVALID', 'blocker',
      'The store GSTIN is not a valid GSTIN',
      `"${store.gstin}" does not match the 15-character format. Every document in this period carries it, so nothing can be filed until Settings is corrected.`,
      [store.gstin],
    ))
  }
  if (doesNotFoot.length > 0) {
    issues.push(issue(
      'INVOICE_DOES_NOT_FOOT', 'blocker',
      `${doesNotFoot.length} invoice${doesNotFoot.length === 1 ? '' : 's'} do not add up`,
      'Taxable value plus tax plus round-off does not equal the net. The portal rejects these outright, and a summary total will not show it because the summary adds up either way.',
      doesNotFoot,
    ))
  }
  if (badGstin.length > 0) {
    issues.push(issue(
      'BUYER_GSTIN_INVALID', 'blocker',
      `${badGstin.length} B2B invoice${badGstin.length === 1 ? '' : 's'} carry an unusable GSTIN`,
      'A B2B line is filed against the buyer\'s GSTIN. One that fails the format check will be rejected at upload, and the buyer will not get their credit.',
      badGstin,
    ))
  }
  if (noHsn.length > 0) {
    issues.push(issue(
      'HSN_MISSING', 'blocker',
      `${dedupe(noHsn).length} invoice${dedupe(noHsn).length === 1 ? '' : 's'} contain a line with no HSN`,
      'Table 12 is built from HSN. A medicine with none was almost certainly created in a hurry at the counter or imported from a pre-GST layout that had no HSN column.',
      dedupe(noHsn),
    ))
  }

  // ------------------------------------------------------------- warnings ---

  if (wrongStateGstin.length > 0) {
    issues.push(issue(
      'PLACE_OF_SUPPLY_MISMATCH', 'warning',
      `${wrongStateGstin.length} invoice${wrongStateGstin.length === 1 ? '' : 's'} disagree with the buyer's state`,
      `The buyer's GSTIN begins with a state code that does not match how the bill was taxed. One of the two is wrong: an inter-state supply taxed as CGST+SGST, or the reverse. The store is in state ${homeState}.`,
      wrongStateGstin,
    ))
  }
  if (shortHsn.length > 0) {
    issues.push(issue(
      'HSN_TOO_SHORT', 'warning',
      `${dedupe(shortHsn).length} invoice${dedupe(shortHsn).length === 1 ? '' : 's'} carry an HSN shorter than ${t.hsnDigits} digits`,
      `Table 12 expects ${t.hsnDigits} digits at this shop's turnover band. Nothing here is padded or truncated — the digit requirement depends on turnover, which RxBill does not hold, so this is set in Settings and is worth confirming against the notification.`,
      dedupe(shortHsn),
    ))
  }
  if (missingRule46.length > 0) {
    issues.push(issue(
      'RULE_46_DETAILS_MISSING', 'warning',
      `${missingRule46.length} counter bill${missingRule46.length === 1 ? '' : 's'} above ₹${t.rule46Minimum} name nobody`,
      'Rule 46 wants the recipient\'s name, address and place of supply above this value. The threshold itself is unverified in this build, and a shop holding the details on paper is not in breach because RxBill cannot see them.',
      missingRule46,
    ))
  }
  if (orphanNotes.length > 0) {
    issues.push(issue(
      'CREDIT_NOTE_ORPHANED', 'warning',
      `${orphanNotes.length} credit note${orphanNotes.length === 1 ? '' : 's'} point at no invoice in the book`,
      'A CDNR line is filed against the original invoice number. One that cannot be resolved will not match on the portal and the buyer\'s credit will not reverse.',
      orphanNotes,
    ))
  }
  if (zeroRated.length > 0) {
    issues.push(issue(
      'NIL_RATED_LINES', 'warning',
      `${dedupe(zeroRated).length} invoice${dedupe(zeroRated).length === 1 ? '' : 's'} carry a nil-rated line`,
      'Genuinely nil-rated goods exist and this is not an error — but a line at 0% because a rate was never set looks identical, and only the shop can tell them apart.',
      dedupe(zeroRated),
    ))
  }
  if (posted.length === 0) {
    issues.push(issue(
      'PERIOD_EMPTY', 'warning',
      'There are no posted invoices in this period',
      'A nil return is a real thing and may be exactly right. It is flagged only because an empty period is more often the wrong dates than a month with no trade.',
      [],
    ))
  }

  const ordered = [...issues].sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1) || b.count - a.count)

  return {
    from,
    to,
    gstin: store.gstin,
    generatedAt: inputs.generatedAt,
    issues: ordered,
    series: seriesSummaries(inPeriod, notesInPeriod),
    taxableValue: money(taxable),
    cgst: money(cgst),
    sgst: money(sgst),
    igst: money(igst),
    buckets: [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .map((b) => ({
        key: b.key,
        label: b.label,
        count: b.count,
        taxableValue: money(b.taxableValue),
      })),
    ready: ordered.every((i) => i.severity !== 'blocker'),
    /* Printed, and printed WITH the numbers actually used. A compliance screen
       that applies a threshold without naming it is asking to be believed about
       something it cannot verify. */
    basis: [
      `Outward supplies dated ${from} to ${to}, credit notes on their issue date.`,
      `Voided invoices are excluded from the totals and counted in the document series, which is what Table 13 asks for.`,
      `B2CL threshold used: ₹${t.b2clMinimum}. Sources conflict on this figure (₹1,00,000 vs ₹2,50,000); it is a setting, not a constant, and nothing is filed on it.`,
      `Rule 46 recipient-details threshold used: ₹${t.rule46Minimum}. Unverified — confirm against the notification.`,
      `HSN digits expected: ${t.hsnDigits}. This depends on annual turnover, which RxBill does not hold; nothing is padded or truncated.`,
      `This is a readiness check, not a return. RxBill generates no GSTR-1 JSON and files nothing.`,
    ],
  }
}

const dedupe = (v: readonly string[]): string[] => [...new Set(v)]
