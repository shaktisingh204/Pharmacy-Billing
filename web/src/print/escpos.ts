import type { BrandProfile, Money, SaleInvoice, StoreProfile } from '@contract'
import { documentCredit } from '@/brand/applyBrand'
import {
  RECEIPT_COLUMNS, amountInWords, fitCell, gridRow, ruleLine,
} from './ThermalReceipt'
import { formatAmount, formatExpiry } from '@/lib/format'

/**
 * The receipt as BYTES, for a thermal printer spoken to directly.
 *
 * `window.print()` works and stays as the fallback, but it costs a driver
 * install, a print dialog and a page-setup that every Windows update is at
 * liberty to reset. A counter prints two hundred bills a day; a dialog on each
 * one is the difference between a till that flows and one that does not.
 *
 * WebSerial, deliberately, and NOT WebUSB: on Windows the vendor's printer
 * driver claims the device exclusively, so WebUSB cannot open it at all while
 * the driver is installed — which it always is, because that is how the printer
 * was set up in the first place. A serial (or USB-serial) endpoint is shared.
 *
 * THE RUPEE SIGN IS THE THING THAT BREAKS.
 * ₹ is U+20B9, adopted in 2010. It exists in no classic ESC/POS code page —
 * CP437, CP850, CP1252 and the rest all predate it — so sending it produces one
 * garbage glyph on every money line of every bill. Printers sold into India
 * since about 2013 usually carry it somewhere in a vendor-specific page, but
 * *which* page and *which* position differ by vendor, and there is no way to ask
 * the printer. So the default is to transliterate it to `Rs`, and a store that
 * knows its printer can turn that off in Settings. A wrong glyph on every line
 * is a far worse default than two extra characters.
 */

// ------------------------------------------------------------- primitives ---

const ESC = 0x1b
const GS = 0x1d

export const CMD = {
  /** Reset. Sent first on every job — a printer left bold by a crashed job
   *  otherwise prints the next customer's whole bill bold. */
  init: [ESC, 0x40],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  alignLeft: [ESC, 0x61, 0],
  alignCentre: [ESC, 0x61, 1],
  alignRight: [ESC, 0x61, 2],
  /** GS ! n — width in the high nibble, height in the low. */
  sizeNormal: [GS, 0x21, 0x00],
  sizeDoubleHeight: [GS, 0x21, 0x01],
  /** Partial cut, after feeding the paper clear of the head. Without the feed
   *  the cut lands mid-total and the customer gets half a bill. */
  cut: [GS, 0x56, 66, 0x03],
  /** ESC p m t1 t2 — the drawer pulse. m=0 is pin 2, the near-universal wiring;
   *  the two times are in 2ms units. 25/25 is the safe middle: too short and a
   *  stiff solenoid does not throw, too long and it can cook the coil. */
  drawerKick: [ESC, 0x70, 0, 25, 25],
  feed: (lines: number): number[] => [ESC, 0x64, Math.max(0, Math.min(255, lines))],
  /** ESC t n — select the code page the bytes below are in. */
  codePage: (page: number): number[] => [ESC, 0x74, page],
} as const

export interface EscPosOptions {
  columns?: number
  /**
   * Transliterate ₹ to `Rs`.
   *
   * Defaults ON. See the note at the top: U+20B9 is in no classic ESC/POS code
   * page, and a printer that lacks it prints a garbage glyph on every money
   * line. A shop whose printer is known to carry it can turn this off.
   */
  transliterateRupee?: boolean
  /** ESC/POS code page to select. 0 is CP437, which every printer has. */
  codePage?: number
  /** Kick the cash drawer. Only ever on a cash sale — see `receiptBytes`. */
  openDrawer?: boolean
  cut?: boolean
}

/**
 * One line of text into bytes.
 *
 * ONLY WIDTH-PRESERVING substitutions happen here, and that rule is the whole
 * reason there are two of them.
 *
 * `fitCell` truncates a cell to EXACTLY the width the grid allocated, marking
 * the cut with a single `…`. Expanding that to `...` afterwards adds two
 * characters, so every truncated cell on the paper came out two columns too
 * wide — invisible on a short brand name and quietly wrecking the column
 * alignment on every long one. Any substitution that changes length has to
 * happen BEFORE anything is fitted, which is what `transliterate` is for and
 * what `wrapped()` calls.
 *
 * Characters with no substitution become `?` rather than being dropped: a
 * dropped character shortens the line and silently breaks the same alignment,
 * whereas a `?` is visibly wrong in exactly the place the problem is.
 */
export function encodeLine(text: string, opts: EscPosOptions = {}): number[] {
  const rupee = opts.transliterateRupee ?? true
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    if (code <= 0x7f) { out.push(code); continue }
    /* `Rs` is TWO characters and this path may not change width, so a rupee
       sign that reached a grid cell is narrowed to `R`. In practice it never
       does — money is formatted without a symbol and the sign only appears in
       prose, which `wrapped()` has already expanded properly — but a silent
       one-column overflow is not a thing to leave to practice. */
    const narrow = NARROW[ch] ?? (ch === '₹' && rupee ? 'R' : '?')
    out.push(narrow.codePointAt(0) ?? 0x3f)
  }
  out.push(0x0a)
  return out
}

/** Strictly one character in, one character out. */
const NARROW: Readonly<Record<string, string>> = {
  '’': "'", '‘': "'", '“': '"', '”': '"',
  '–': '-', '—': '-',
  /* The truncation mark `fitCell` writes. One character in, one out — the point
     of this whole table. */
  '…': '.',
  '·': '*',
  '°': 'o',
}

/**
 * The substitutions that keep a SENTENCE readable on a 7-bit printer.
 *
 * These may change length, so they are applied to prose before it is wrapped and
 * never to a cell that has already been fitted. Every one is a character the app
 * genuinely emits — the rupee sign on every total, and the typographic
 * punctuation the copy is written with. Left alone they each become `?`, and a
 * bill reading `store below 25?C` is worse than one reading `25degC`.
 */
const SUBSTITUTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/₹/g, 'Rs'],
  [/[’‘]/g, "'"],
  [/[“”]/g, '"'],
  [/—/g, '--'],
  [/–/g, '-'],
  [/…/g, '...'],
  [/·/g, '*'],
  [/°/g, 'deg'],
]

export function transliterate(text: string): string {
  let out = text
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement)
  return out
}


/**
 * Free text, wrapped to the roll on word boundaries.
 *
 * The grid helpers handle the columnar lines; this is for the sentences — the
 * store's footer note, the amount in words, the reseller credit. Left unwrapped
 * they overflow, and the printer hard-wraps wherever the character happens to
 * fall: mid-word, and with the centring applied only to the first fragment. A
 * 61-character footer on a 32-column roll came out as two lines, one centred and
 * one not, which reads as a broken printer rather than a long sentence.
 *
 * A word longer than the roll is broken rather than allowed to overflow —
 * nothing else can be done with it, and overflowing is the worse of the two.
 */
export function wrapText(text: string, cols: number): string[] {
  if (cols < 1) return [text]
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let w = word
      while (w.length > cols) {
        if (current !== '') { out.push(current); current = '' }
        out.push(w.slice(0, cols))
        w = w.slice(cols)
      }
      if (current === '') current = w
      else if (current.length + 1 + w.length <= cols) current = `${current} ${w}`
      else { out.push(current); current = w }
    }
    out.push(current)
  }
  return out
}

// ---------------------------------------------------------------- receipt ---

const money = (v: Money): string => formatAmount(v)

/**
 * The whole job: a printable bill, ready to write to the port.
 *
 * Built from the SAME grid helpers the on-screen receipt uses — `gridRow`,
 * `fitCell`, `ruleLine` — so the paper and the preview cannot drift. Two
 * renderers for one document is how a shop discovers on a Drug Inspector's
 * visit that the printed batch column has been truncating for a year.
 */
export function receiptBytes(
  invoice: SaleInvoice,
  store: StoreProfile,
  brand: BrandProfile | null | undefined,
  opts: EscPosOptions = {},
): Uint8Array {
  const cols = opts.columns ?? RECEIPT_COLUMNS
  const out: number[] = []
  const push = (...bytes: number[]) => out.push(...bytes)
  const line = (text = '') => push(...encodeLine(text, opts))
  /* Sentences go through the wrapper; columnar lines are already exactly `cols`
     wide by construction and must not be re-flowed. */
  const wrapped = (text: string) => {
    for (const l of wrapText(transliterate(text), cols)) line(l)
  }

  push(...CMD.init)
  push(...CMD.codePage(opts.codePage ?? 0))

  push(...CMD.alignCentre, ...CMD.boldOn)
  wrapped(store.name)
  push(...CMD.boldOff)
  if (store.addressLine) wrapped(store.addressLine)
  wrapped(`${store.city} - ${store.phone}`)
  line(`GSTIN ${store.gstin}`)
  /* The drug licence numbers are not optional decoration: a retail bill without
     them is not a compliant bill, and this is the copy a Drug Inspector picks up. */
  if (store.dlNos.length > 0) wrapped(`DL ${store.dlNos.join(', ')}`)

  push(...CMD.alignLeft)
  line(ruleLine(cols))
  line(gridRow(invoice.invoiceNo, invoice.invoiceDate, cols))
  line(gridRow(`Opr ${invoice.operatorName}`, `Till ${invoice.terminalId}`, cols))
  if (invoice.customerName) {
    line(gridRow(`Cust ${invoice.customerName}`, invoice.customerPhone ?? '', cols))
  }
  line(ruleLine(cols))

  for (const [i, l] of invoice.quote.lines.entries()) {
    line(`${fitCell(String(i + 1), 2, 'right')} ${fitCell(`${l.brandName} ${l.packLabel}`.trim(), cols - 3)}`)
    for (const a of l.allocations) {
      /* Batch and expiry on their own line, indented under the item. These are
         the two fields checked against the strip in the customer's hand, so they
         are never the thing that gets dropped to fit. */
      const left = `   ${a.batchNo} ${formatExpiry(a.expiryDate)}`
      const right = `${a.qty} x ${money(a.mrpPerUnit)}  ${money(a.lineTotal)}`
      line(gridRow(left, right, cols))
    }
    /* The dispensing instruction, indented under its item and wrapped at the
       narrower width the indent leaves — the sentence the patient reads at home
       is the one thing on this receipt that must not come out truncated. */
    if (l.note) {
      for (const w of wrapText(transliterate(`* ${l.note}`), cols - 3)) line(`   ${w}`)
    }
  }

  line(ruleLine(cols))
  const q = invoice.quote
  line(gridRow('Taxable', money(q.taxableValue), cols))
  if (q.igst !== '0.00') line(gridRow('IGST', money(q.igst), cols))
  else {
    line(gridRow('CGST', money(q.cgst), cols))
    line(gridRow('SGST', money(q.sgst), cols))
  }
  if (q.roundOff !== '0.00') line(gridRow('Round off', money(q.roundOff), cols))

  push(...CMD.boldOn, ...CMD.sizeDoubleHeight)
  line(gridRow('TOTAL', money(q.netAmount), Math.floor(cols / 2)))
  push(...CMD.sizeNormal, ...CMD.boldOff)

  for (const p of invoice.payments) line(gridRow(p.mode, money(p.amount), cols))
  if (invoice.changeDue !== '0.00') line(gridRow('Change', money(invoice.changeDue), cols))

  line()
  wrapped(amountInWords(q.netAmount))
  if (invoice.note) wrapped(`Note: ${invoice.note}`)

  if (invoice.status === 'VOIDED') {
    push(...CMD.alignCentre, ...CMD.boldOn)
    line('*** VOIDED ***')
    push(...CMD.boldOff, ...CMD.alignLeft)
  }

  line()
  push(...CMD.alignCentre)
  if (store.footerNote) wrapped(store.footerNote)
  const credit = documentCredit(brand)
  if (credit) wrapped(credit)
  push(...CMD.alignLeft)

  push(...CMD.feed(3))
  /* The drawer is kicked BEFORE the cut, so the till opens while the paper is
     still being cut rather than a second after the customer has taken it. */
  if (opts.openDrawer) push(...CMD.drawerKick)
  if (opts.cut ?? true) push(...CMD.cut)

  return Uint8Array.from(out)
}

/**
 * Does this bill open the drawer?
 *
 * Only when cash actually moved. A UPI or card sale that kicks the till has
 * defeated the point of a till: the drawer should be shut and unremarkable
 * except when money is going into or out of it, and a drawer that opens on every
 * sale is one nobody notices being open.
 */
export function shouldOpenDrawer(invoice: SaleInvoice): boolean {
  return invoice.payments.some((p) => p.mode === 'CASH')
}

/** The drawer on its own, for a paid-out or a float. */
export function drawerBytes(): Uint8Array {
  return Uint8Array.from([...CMD.init, ...CMD.drawerKick])
}

/**
 * A test print that proves the things that actually go wrong.
 *
 * Not "Hello world": the two failures worth catching before a queue forms are
 * the column width being wrong for the roll, and the rupee sign printing as
 * rubbish. Both are visible in one glance here.
 */
export function testPageBytes(store: StoreProfile, opts: EscPosOptions = {}): Uint8Array {
  const cols = opts.columns ?? RECEIPT_COLUMNS
  const out: number[] = []
  const line = (text = '') => out.push(...encodeLine(text, opts))

  out.push(...CMD.init, ...CMD.codePage(opts.codePage ?? 0))
  out.push(...CMD.alignCentre, ...CMD.boldOn)
  line('PRINTER TEST')
  out.push(...CMD.boldOff, ...CMD.alignLeft)
  line(ruleLine(cols))
  for (const l of wrapText(transliterate(store.name), cols)) line(l)
  /* The ruler. If this wraps, the column count is wrong for the roll — and a
     wrong column count is invisible on a short bill and ruins a long one. */
  line('1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols))
  line(gridRow(`${cols} columns`, 'right edge', cols))
  line(ruleLine(cols))
  /* Expanded BEFORE `gridRow` fits it. A rupee sign that reaches a cell has
     already had its width counted, and narrowing it there would be a column
     short — the same class of error the truncation mark was. */
  line(gridRow('Rupee sign', transliterate('₹1,234.50'), cols))
  line(`Reads "Rs" here: ${(opts.transliterateRupee ?? true) ? 'yes' : 'no'}`)
  for (const l of wrapText('If that shows a strange character, leave the Rs setting on.', cols)) {
    line(l)
  }
  out.push(...CMD.feed(3), ...CMD.cut)
  return Uint8Array.from(out)
}
