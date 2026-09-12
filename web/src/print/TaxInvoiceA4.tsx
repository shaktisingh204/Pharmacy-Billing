import type { BrandProfile, QuoteLine, SaleInvoice, StoreProfile } from '@contract'
import { formatAmount, formatExpiry, formatPercent, formatQty } from '@/lib/format'
import { documentCredit } from '@/brand/applyBrand'
import { amountInWords, isZeroAmount } from './ThermalReceipt'
import './print.css'

/**
 * The A4 GST tax invoice — the B2B document.
 *
 * A thermal slip is a receipt; this is the instrument the buyer files to claim
 * input credit. Everything on it that looks decorative is a statutory field:
 * the recipient's GSTIN and state code decide whether the credit is claimable
 * at all, and the place of supply decides whether the tax is IGST or CGST+SGST.
 */

interface Column {
  label: string
  /** Percent of the table width. Fixed layout: the columns may not reflow. */
  width: string
  num?: boolean
}

const COLUMNS_INTRA: readonly Column[] = [
  { label: '#', width: '3%', num: true },
  { label: 'Description', width: '17%' },
  { label: 'HSN', width: '6%' },
  { label: 'Batch', width: '8%' },
  { label: 'Exp', width: '5%' },
  { label: 'Qty', width: '5%', num: true },
  { label: 'MRP', width: '7%', num: true },
  { label: 'Rate', width: '7%', num: true },
  { label: 'Disc', width: '6%', num: true },
  { label: 'Taxable', width: '8%', num: true },
  { label: 'GST%', width: '5%', num: true },
  { label: 'CGST', width: '7%', num: true },
  { label: 'SGST', width: '7%', num: true },
  { label: 'Amount', width: '9%', num: true },
]

const COLUMNS_INTER: readonly Column[] = [
  { label: '#', width: '3%', num: true },
  { label: 'Description', width: '20%' },
  { label: 'HSN', width: '6%' },
  { label: 'Batch', width: '9%' },
  { label: 'Exp', width: '5%' },
  { label: 'Qty', width: '5%', num: true },
  { label: 'MRP', width: '8%', num: true },
  { label: 'Rate', width: '8%', num: true },
  { label: 'Disc', width: '6%', num: true },
  { label: 'Taxable', width: '9%', num: true },
  { label: 'GST%', width: '5%', num: true },
  { label: 'IGST', width: '8%', num: true },
  { label: 'Amount', width: '8%', num: true },
]

/** Columns spanned by the "Total" label: everything up to and including Disc. */
const TOTAL_LABEL_SPAN = 9

const DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

function invoiceDate(iso: string): string {
  const at = new Date(`${iso}T00:00:00`)
  return Number.isNaN(at.getTime()) ? iso : DATE.format(at)
}

function description(line: QuoteLine): string {
  const schedule = line.drugSchedule === 'OTC' ? '' : ` [${line.drugSchedule}]`
  return `${line.brandName} ${line.packLabel}${schedule}`.trim()
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="rx-a4__caption">{label}</div>
      <div>{value}</div>
    </div>
  )
}

export function TaxInvoiceA4({ invoice, store, brand, preview = false }: {
  invoice: SaleInvoice
  store: StoreProfile
  /** The reseller's branding. Absent prints no credit line — see ThermalReceipt. */
  brand?: BrandProfile | null
  /** Show the sheet on screen. The attribute has to sit on the sheet's own
      root, so a wrapper cannot supply it — see index.ts. */
  preview?: boolean
}) {
  const { quote } = invoice
  const credit = documentCredit(brand)
  const columns = invoice.interState ? COLUMNS_INTER : COLUMNS_INTRA

  return (
    <div className="rx-print rx-print--a4" data-preview={preview ? 'true' : undefined}>
      <div className="rx-a4__title">TAX INVOICE</div>

      <div className="rx-a4__parties">
        <div className="rx-a4__party">
          <div className="rx-a4__caption">Supplier</div>
          <div className="rx-a4__name">{store.name}</div>
          <div>{store.addressLine}</div>
          <div>{`${store.city}, ${store.state} (${store.stateCode})`}</div>
          <div>{`Ph ${store.phone}${store.email ? ` · ${store.email}` : ''}`}</div>
          <div>{`GSTIN ${store.gstin}`}</div>
          {store.dlNos.length > 0 ? <div>{`DL ${store.dlNos.join(' / ')}`}</div> : null}
        </div>

        {/* The recipient's GSTIN, address and state code are what make this
            document worth having, and SaleInvoice carries none of them — only
            a name and a phone. They print as em dashes until the contract
            grows the fields; flagged to the lead. */}
        <div className="rx-a4__party">
          <div className="rx-a4__caption">Recipient</div>
          <div className="rx-a4__name">{invoice.customerName ?? 'Cash sale'}</div>
          <div>{invoice.customerPhone ? `Ph ${invoice.customerPhone}` : '—'}</div>
          <div>—</div>
          <div>GSTIN —</div>
          <div>State —</div>
        </div>
      </div>

      <div className="rx-a4__meta">
        <Field label="Invoice no" value={invoice.invoiceNo} />
        <Field label="Invoice date" value={invoiceDate(invoice.invoiceDate)} />
        {/* Intra-state supply: the place of supply IS the supplier's state.
            Inter-state, it is the recipient's — which the contract omits. */}
        <Field
          label="Place of supply"
          value={invoice.interState ? '—' : `${store.state} (${store.stateCode})`}
        />
        <Field label="Issued by" value={`${invoice.operatorName} · Till ${invoice.terminalId}`} />
      </div>

      <table className="rx-a4__table">
        <colgroup>
          {columns.map((column) => (
            <col key={column.label} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.label} className={column.num ? 'rx-a4__num' : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {quote.lines.flatMap((line, index) =>
            line.allocations.map((alloc, allocIndex) => (
              <tr key={`${line.lineId}-${alloc.batchId}-${alloc.batchNo}`}>
                {/* One row per BATCH: a cart row that fanned across two batches
                    is two printed rows, because each carries its own expiry. */}
                {allocIndex === 0 ? (
                  <>
                    <td rowSpan={line.allocations.length} className="rx-a4__num">{index + 1}</td>
                    <td rowSpan={line.allocations.length}>{description(line)}</td>
                    <td rowSpan={line.allocations.length}>{line.hsnCode}</td>
                  </>
                ) : null}
                <td>{alloc.batchNo}</td>
                <td>{formatExpiry(alloc.expiryDate)}</td>
                <td className="rx-a4__num">
                  {isZeroAmount(alloc.freeQty)
                    ? formatQty(alloc.qty)
                    : `${formatQty(alloc.qty)} + ${formatQty(alloc.freeQty)}`}
                </td>
                <td className="rx-a4__num">{formatAmount(alloc.mrpPerUnit)}</td>
                <td className="rx-a4__num">{formatAmount(alloc.ratePerUnit)}</td>
                <td className="rx-a4__num">{formatAmount(alloc.discountAmount)}</td>
                <td className="rx-a4__num">{formatAmount(alloc.taxableValue)}</td>
                <td className="rx-a4__num">{formatPercent(alloc.gstRatePct)}</td>
                {invoice.interState ? (
                  <td className="rx-a4__num">{formatAmount(alloc.igst)}</td>
                ) : (
                  <>
                    <td className="rx-a4__num">{formatAmount(alloc.cgst)}</td>
                    <td className="rx-a4__num">{formatAmount(alloc.sgst)}</td>
                  </>
                )}
                <td className="rx-a4__num">{formatAmount(alloc.lineTotal)}</td>
              </tr>
            )),
          )}
        </tbody>
        <tfoot>
          <tr className="rx-a4__foot">
            <td className="rx-a4__num" colSpan={TOTAL_LABEL_SPAN}>Total</td>
            <td className="rx-a4__num">{formatAmount(quote.taxableValue)}</td>
            <td />
            {invoice.interState ? (
              <td className="rx-a4__num">{formatAmount(quote.igst)}</td>
            ) : (
              <>
                <td className="rx-a4__num">{formatAmount(quote.cgst)}</td>
                <td className="rx-a4__num">{formatAmount(quote.sgst)}</td>
              </>
            )}
            <td className="rx-a4__num">{formatAmount(quote.netAmount)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="rx-a4__below">
        <div>
          {/* Rate-wise, because one bill legitimately mixes nil, 5% and 18%. */}
          <table className="rx-a4__summary">
            <thead>
              <tr>
                <th>GST rate</th>
                <th className="rx-a4__num">Taxable</th>
                {invoice.interState ? (
                  <th className="rx-a4__num">IGST</th>
                ) : (
                  <>
                    <th className="rx-a4__num">CGST</th>
                    <th className="rx-a4__num">SGST</th>
                  </>
                )}
                <th className="rx-a4__num">Total</th>
              </tr>
            </thead>
            <tbody>
              {quote.taxBreakup.map((row) => (
                <tr key={row.gstRatePct}>
                  <td>{formatPercent(row.gstRatePct)}</td>
                  <td className="rx-a4__num">{formatAmount(row.taxableValue)}</td>
                  {invoice.interState ? (
                    <td className="rx-a4__num">{formatAmount(row.igst)}</td>
                  ) : (
                    <>
                      <td className="rx-a4__num">{formatAmount(row.cgst)}</td>
                      <td className="rx-a4__num">{formatAmount(row.sgst)}</td>
                    </>
                  )}
                  <td className="rx-a4__num">{formatAmount(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="rx-a4__summary" style={{ marginTop: '3mm' }}>
            <tbody>
              <tr>
                <td>Gross</td>
                <td className="rx-a4__num">{formatAmount(quote.grossAmount)}</td>
              </tr>
              {isZeroAmount(quote.itemDiscount) ? null : (
                <tr>
                  <td>Item discount</td>
                  <td className="rx-a4__num">{formatAmount(quote.itemDiscount)}</td>
                </tr>
              )}
              {isZeroAmount(quote.billDiscount) ? null : (
                <tr>
                  <td>{`Bill discount ${formatPercent(quote.billDiscountPct)}`}</td>
                  <td className="rx-a4__num">{formatAmount(quote.billDiscount)}</td>
                </tr>
              )}
              <tr>
                <td>Round off</td>
                <td className="rx-a4__num">{formatAmount(quote.roundOff)}</td>
              </tr>
              <tr className="rx-a4__foot">
                <td>Net payable</td>
                <td className="rx-a4__num">{formatAmount(quote.netAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="rx-a4__sign">
          <div>{`For ${store.name}`}</div>
          <div>Authorised signatory</div>
        </div>
      </div>

      <div className="rx-a4__words">
        <span className="rx-a4__caption">Amount in words </span>
        {amountInWords(quote.netAmount)}
      </div>

      <div className="rx-a4__declaration">
        Declaration: we declare that this invoice shows the actual price of the goods
        described and that all particulars are true and correct.
        {invoice.status === 'VOIDED' ? ' THIS INVOICE HAS BEEN VOIDED.' : ''}
      </div>

      {/* Below the declaration, never inside it: the declaration is the shop's
          legal statement about its own goods and a software credit has no place
          in that sentence. */}
      {credit ? <div className="rx-a4__credit">{credit}</div> : null}
    </div>
  )
}
