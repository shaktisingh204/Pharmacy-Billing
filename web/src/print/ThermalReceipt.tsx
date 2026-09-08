/* oxlint-disable react/only-export-components -- the character grid and the
   number-to-words engine ARE the receipt; this module has nowhere else to put
   them, and the cost is a full reload rather than a hot swap when it is edited. */
import type { CSSProperties, ReactNode } from 'react'
import { toSVG } from 'bwip-js/browser'
import type {
  Money, PaymentMode, QuoteAllocation, QuoteLine, SaleInvoice, StoreProfile,
} from '@contract'
import { formatAmount, formatExpiry, formatMoney, formatPercent, formatQty } from '@/lib/format'
import { cn } from '@/lib/cn'
import './print.css'

/**
 * The 80mm thermal receipt.
 *
 * The whole sheet is laid out on a CHARACTER GRID, not with CSS boxes: every
 * line is padded to exactly `columns` cells and rendered in a monospace face.
 * That is how a thermal receipt has always been built, and it is the only
 * layout that survives the printer driver deciding to fall back to text mode.
 *
 * 42 columns is the safe count for the 203dpi heads on the common Indian 80mm
 * printers, but docs/UNVERIFIED.md still lists 42-vs-48 as unverified until the
 * pilot store's model is known — hence a prop and a CSS custom property rather
 * than a constant baked into the strings.
 */
export const RECEIPT_COLUMNS = 42

/**
 * Right-hand numeric columns of an item's detail line, in character cells.
 * Each is one cell wider than the longest amount a retail line realistically
 * carries, because two right-aligned columns that both fill their width print
 * as one run of digits — "2 1,250.001,28,456.00" is not a price.
 */
const QTY_CELLS = 4
const MRP_CELLS = 10
const AMOUNT_CELLS = 12
const ITEM_INDENT = 2

/**
 * The NET line is set larger than the grid, so it buys fewer cells: 42 cells at
 * 1.3em need 93mm of roll and there are 72. One constant drives the string and
 * the CSS size together, because the two drifting apart wraps the one line on
 * the receipt every customer reads.
 */
const NET_SCALE = 1.3

const PAYMENT_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  CREDIT: 'Credit',
}

/** Constructed once: a formatter per receipt line is a measurable cost. */
const STAMP = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

// ------------------------------------------------------------ the grid ---

/**
 * Pad or truncate to EXACTLY `width` cells — the primitive the whole grid is
 * built from. Truncation is marked, because a silently clipped brand name is
 * how the wrong strength gets dispensed from a bill.
 */
export function fitCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return ''
  if (text.length > width) return width === 1 ? '…' : `${text.slice(0, width - 1)}…`
  return align === 'right' ? text.padStart(width) : text.padEnd(width)
}

/** A label and a right-aligned value on one line: the totals block's workhorse. */
export function gridRow(left: string, right: string, cols = RECEIPT_COLUMNS): string {
  const valueCells = Math.min(right.length, Math.max(0, cols - 1))
  return `${fitCell(left, cols - valueCells - 1)} ${fitCell(right, valueCells, 'right')}`
}

export function ruleLine(cols = RECEIPT_COLUMNS, char = '-'): string {
  return char.repeat(Math.max(0, cols))
}

/** `1 DOLO 650MG TAB 15S` — index, brand, pack, truncated to the roll. */
function itemNameLine(index: number, line: QuoteLine, cols: number): string {
  const name = `${line.brandName} ${line.packLabel}`.trim()
  return `${fitCell(String(index), 2, 'right')} ${fitCell(name, cols - 3)}`
}

/**
 * `  AX2314 11/27       2     30.00       60.00`
 *
 * Batch number and expiry are not metadata: they are the two fields a Drug
 * Inspector checks against the strip in the customer's hand.
 */
function itemDetailLine(alloc: QuoteAllocation, manufacturer: string, cols: number): string {
  const detailCells = cols - ITEM_INDENT - QTY_CELLS - MRP_CELLS - AMOUNT_CELLS
  const batch = `${alloc.batchNo} ${formatExpiry(alloc.expiryDate)}`
  // The maker's name joins them whole or not at all — half of one is worse
  // than none. At 42 columns the batch and expiry already fill the field, so
  // this lands on the 48-column profile, the other candidate in UNVERIFIED.md.
  const detail = manufacturer && batch.length + 1 + manufacturer.length <= detailCells
    ? `${batch} ${manufacturer}`
    : batch

  return [
    ' '.repeat(ITEM_INDENT),
    fitCell(detail, detailCells),
    fitCell(formatQty(alloc.qty), QTY_CELLS, 'right'),
    fitCell(formatAmount(alloc.mrpPerUnit), MRP_CELLS, 'right'),
    fitCell(formatAmount(alloc.lineTotal), AMOUNT_CELLS, 'right'),
  ].join('')
}

function itemHeaderLine(cols: number): string {
  const detailCells = cols - ITEM_INDENT - QTY_CELLS - MRP_CELLS - AMOUNT_CELLS
  return [
    ' '.repeat(ITEM_INDENT),
    fitCell('BATCH  EXP', detailCells),
    fitCell('QTY', QTY_CELLS, 'right'),
    fitCell('MRP', MRP_CELLS, 'right'),
    fitCell('AMOUNT', AMOUNT_CELLS, 'right'),
  ].join('')
}

/** Rate-wise summary: 5% and 18% on one bill is the norm, not the exception. */
function taxLine(cells: readonly string[], cols: number, interState: boolean): string {
  const [rate = '', taxable = '', cgstOrIgst = '', sgst = ''] = cells
  const rateCells = 6
  const rest = cols - rateCells
  if (interState) {
    return fitCell(rate, rateCells, 'right')
      + fitCell(taxable, Math.ceil(rest / 2), 'right')
      + fitCell(cgstOrIgst, Math.floor(rest / 2), 'right')
  }
  const each = Math.floor(rest / 3)
  return fitCell(rate, cols - each * 3, 'right')
    + fitCell(taxable, each, 'right')
    + fitCell(cgstOrIgst, each, 'right')
    + fitCell(sgst, each, 'right')
}

// ------------------------------------------------------------- in words ---

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
] as const

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
] as const

function under100(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const tens = TENS[Math.floor(n / 10)] ?? ''
  const ones = ONES[n % 10] ?? ''
  return ones ? `${tens} ${ones}` : tens
}

function under1000(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = under100(n % 100)
  if (!hundreds) return rest
  const head = `${ONES[hundreds] ?? ''} Hundred`
  return rest ? `${head} ${rest}` : head
}

/**
 * Indian grouping — crore, lakh, thousand — not the Western short scale.
 * Recursive on the crore group so 1,00,00,00,000 spells "One Hundred Crore".
 */
function rupeesInWords(n: bigint): string {
  if (n === 0n) return 'Zero'
  const words: string[] = []

  const crore = n / 10_000_000n
  if (crore > 0n) words.push(rupeesInWords(crore), 'Crore')

  let rest = n % 10_000_000n
  const lakh = Number(rest / 100_000n)
  if (lakh) words.push(under100(lakh), 'Lakh')

  rest %= 100_000n
  const thousand = Number(rest / 1000n)
  if (thousand) words.push(under100(thousand), 'Thousand')

  const below = Number(rest % 1000n)
  if (below) words.push(under1000(below))

  return words.join(' ')
}

/**
 * Zero tested on the DIGITS: "0", "0.00" and "-0.00" are all zero, and none of
 * them may be answered by parsing money into a float to compare it.
 */
export function isZeroAmount(value: Money): boolean {
  return /^-?0+(?:\.0*)?$/.test(value.trim())
}

const MONEY = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/

/**
 * "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy
 * Eight Paise Only" — the line a bank clerk and a GST officer both read.
 *
 * Parsing is done on the DIGITS, in BigInt: the paise of a lakh-rupee bill do
 * not survive a float, and the third decimal (which a discount can produce)
 * has to round half away from zero, which IEEE-754 will not do.
 */
export function amountInWords(amount: Money): string {
  const parsed = MONEY.exec(amount)
  if (!parsed) return '—'

  const [, minus, whole = '0', fraction = ''] = parsed
  const roundUp = fraction.charAt(2) >= '5'
  const paise = BigInt(whole + fraction.padEnd(2, '0').slice(0, 2)) + (roundUp ? 1n : 0n)

  const rupees = paise / 100n
  const remainder = Number(paise % 100n)

  const rupeeWords = rupees > 0n
    ? `${rupeesInWords(rupees)} ${rupees === 1n ? 'Rupee' : 'Rupees'}`
    : ''
  const paiseWords = remainder > 0
    ? `${under100(remainder)} ${remainder === 1 ? 'Paisa' : 'Paise'}`
    : ''

  if (!rupeeWords && !paiseWords) return 'Zero Rupees Only'
  const sign = minus ? 'Minus ' : ''
  const body = rupeeWords && paiseWords ? `${rupeeWords} and ${paiseWords}` : rupeeWords || paiseWords
  return `${sign}${body} Only`
}

// ----------------------------------------------------------------- UPI ---

/**
 * The UPI intent the QR encodes. `tr` carries the invoice number, which is what
 * makes the owner's bank statement reconcile against the day book without a
 * human matching amounts by eye. PSPs reject punctuation in `tr`, so the
 * separators come out and the digits — the part that identifies the bill —
 * stay.
 */
export function upiPayUri(invoice: SaleInvoice, store: StoreProfile): string | null {
  if (!store.upiVpa) return null
  const params: Array<[string, string]> = [
    ['pa', store.upiVpa],
    ['pn', store.name],
    ['am', invoice.quote.netAmount],
    ['cu', 'INR'],
    ['tn', `Bill ${invoice.invoiceNo}`],
    ['tr', invoice.invoiceNo.replace(/[^A-Za-z0-9]/g, '')],
  ]
  // encodeURIComponent, not URLSearchParams: the latter encodes a space as '+'
  // and several UPI apps show the payee name with the plus signs still in it.
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}

/** bwip-js renders synchronously, so the component stays pure — no effect, no state. */
function qrMarkup(text: string): string | null {
  try {
    return toSVG({ bcid: 'qrcode', text, scale: 3, padding: 0 })
  } catch {
    // A receipt that fails to print because a QR could not be encoded is a
    // worse outcome than a receipt with no QR on it.
    return null
  }
}

// ----------------------------------------------------------- the sheet ---

function Line({ children, centre, className }: {
  children: ReactNode
  centre?: boolean
  className?: string
}) {
  return (
    <div className={cn('rx-print__line', centre && 'rx-print__centre', className)}>
      {children}
    </div>
  )
}

/**
 * The contract's QuoteLine carries no manufacturer today. It is read
 * structurally so the name prints the day the field lands on the wire —
 * flagged to the lead, because a Drug Inspector checks it.
 */
function manufacturerOf(line: QuoteLine): string {
  const value = (line as QuoteLine & { manufacturer?: string | null }).manufacturer
  return typeof value === 'string' ? value : ''
}

function stampOf(invoice: SaleInvoice): string {
  const at = new Date(invoice.createdAt)
  return Number.isNaN(at.getTime())
    ? invoice.invoiceDate
    : STAMP.format(at).replace(', ', ' ')
}

export function ThermalReceipt({
  invoice, store, columns = RECEIPT_COLUMNS, preview = false,
}: {
  invoice: SaleInvoice
  store: StoreProfile
  columns?: number
  /** Show the sheet on screen. The attribute has to sit on the sheet's own
      root, so a wrapper cannot supply it — see index.ts. */
  preview?: boolean
}) {
  const { quote } = invoice
  const cols = columns
  const hasScheduleH1 = quote.lines.some((line) => line.drugSchedule === 'H1')
  const upi = upiPayUri(invoice, store)
  // A voided bill is a reprint of something that was cancelled; a payable QR on
  // it collects money against an invoice that no longer exists.
  const qr = upi && invoice.status !== 'VOIDED' ? qrMarkup(upi) : null

  return (
    <div
      className="rx-print rx-print--thermal"
      data-cols={cols}
      data-preview={preview ? 'true' : undefined}
      style={{ '--rx-print-cols': cols, '--rx-print-net-scale': NET_SCALE } as CSSProperties}
    >
      <div className="rx-print__title">{store.name}</div>
      {store.tagline ? <Line centre>{store.tagline}</Line> : null}
      <Line centre>{store.addressLine}</Line>
      <Line centre>{`${store.city}, ${store.state}`}</Line>
      <Line centre>{`Ph ${store.phone}`}</Line>

      {/* Both lines are a legal requirement on a retail drug bill, not a footer
          nicety: GSTIN under the GST Act, the licence numbers under the drug
          rules. A bill without them is not a valid bill. */}
      <Line centre>{`GSTIN ${store.gstin}`}</Line>
      {store.dlNos.length > 0 ? <Line centre>{`DL ${store.dlNos.join(' / ')}`}</Line> : null}

      <Line>{ruleLine(cols, '=')}</Line>
      <Line>{gridRow(invoice.invoiceNo, stampOf(invoice), cols)}</Line>
      <Line>{gridRow(`Opr ${invoice.operatorName}`, `Till ${invoice.terminalId}`, cols)}</Line>
      {invoice.customerName ? (
        <Line>{gridRow(`Cust ${invoice.customerName}`, invoice.customerPhone ?? '', cols)}</Line>
      ) : null}
      {invoice.prescription ? (
        <Line>{gridRow(`Rx ${invoice.prescription.prescriberName}`, invoice.prescription.patientName, cols)}</Line>
      ) : null}

      <Line>{ruleLine(cols)}</Line>
      <Line>{itemHeaderLine(cols)}</Line>
      <Line>{ruleLine(cols)}</Line>

      {quote.lines.map((line, index) => (
        <div className="rx-print__item" key={line.lineId}>
          <Line>{itemNameLine(index + 1, line, cols)}</Line>
          {line.allocations.map((alloc) => (
            <Line key={`${alloc.batchId}-${alloc.batchNo}`}>
              {itemDetailLine(alloc, manufacturerOf(line), cols)}
            </Line>
          ))}
        </div>
      ))}

      <Line>{ruleLine(cols)}</Line>
      <Line>
        {taxLine(
          invoice.interState ? ['GST%', 'TAXABLE', 'IGST'] : ['GST%', 'TAXABLE', 'CGST', 'SGST'],
          cols,
          invoice.interState,
        )}
      </Line>
      {quote.taxBreakup.map((row) => (
        <Line key={row.gstRatePct}>
          {taxLine(
            invoice.interState
              ? [formatPercent(row.gstRatePct), formatAmount(row.taxableValue), formatAmount(row.igst)]
              : [
                  formatPercent(row.gstRatePct), formatAmount(row.taxableValue),
                  formatAmount(row.cgst), formatAmount(row.sgst),
                ],
            cols,
            invoice.interState,
          )}
        </Line>
      ))}

      <Line>{ruleLine(cols)}</Line>
      <Line>{gridRow('Gross', formatAmount(quote.grossAmount), cols)}</Line>
      {/* Two discount lines, never one: the item discount is the pharmacist's,
          the bill discount is the owner's, and summing them here would need
          money arithmetic in a view. */}
      {isZeroAmount(quote.itemDiscount) ? null : (
        <Line>{gridRow('Item discount', formatAmount(quote.itemDiscount), cols)}</Line>
      )}
      {isZeroAmount(quote.billDiscount) ? null : (
        <Line>
          {gridRow(
            `Bill discount ${formatPercent(quote.billDiscountPct)}`,
            formatAmount(quote.billDiscount),
            cols,
          )}
        </Line>
      )}
      <Line>{gridRow('Taxable', formatAmount(quote.taxableValue), cols)}</Line>
      {invoice.interState ? (
        <Line>{gridRow('IGST', formatAmount(quote.igst), cols)}</Line>
      ) : (
        <>
          <Line>{gridRow('CGST', formatAmount(quote.cgst), cols)}</Line>
          <Line>{gridRow('SGST', formatAmount(quote.sgst), cols)}</Line>
        </>
      )}
      {/* Always printed, even at zero: the round off is the difference between
          the arithmetic and the cash drawer, and a customer who cannot see it
          assumes it was pocketed. */}
      <Line>{gridRow('Round off', formatAmount(quote.roundOff), cols)}</Line>
      <Line className="rx-print__net">
        {gridRow('NET', formatMoney(quote.netAmount), Math.floor(cols / NET_SCALE))}
      </Line>

      <Line>{ruleLine(cols)}</Line>
      {invoice.payments.map((payment, index) => (
        <Line key={`${payment.mode}-${index}`}>
          {gridRow(
            payment.reference
              ? `${PAYMENT_LABEL[payment.mode]} ${payment.reference}`
              : PAYMENT_LABEL[payment.mode],
            formatAmount(payment.amount),
            cols,
          )}
        </Line>
      ))}
      <Line>{gridRow('Paid', formatAmount(invoice.amountPaid), cols)}</Line>
      <Line>{gridRow('Change due', formatAmount(invoice.changeDue), cols)}</Line>

      <div className="rx-print__gap" />
      <Line className="rx-print__words">{amountInWords(quote.netAmount)}</Line>

      {qr && upi ? (
        <div className="rx-print__qr">
          {/* bwip-js emits an SVG string; React has no other way to mount it.
              The payload is barcode geometry, never the store's text. */}
          <div dangerouslySetInnerHTML={{ __html: qr }} />
          <Line centre>Scan to pay · {store.upiVpa}</Line>
          <Line centre>{`Ref ${invoice.invoiceNo}`}</Line>
        </div>
      ) : null}

      <div className="rx-print__gap" />
      {hasScheduleH1 ? (
        <Line centre>
          Schedule H1 drug supplied against prescription. Entry made in the H1 register.
        </Line>
      ) : null}
      <Line centre>{store.footerNote}</Line>
      {invoice.status === 'VOIDED' ? (
        <Line centre className="rx-print__bold">*** VOIDED ***</Line>
      ) : null}
    </div>
  )
}
