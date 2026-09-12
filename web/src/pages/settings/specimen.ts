import type { QuoteAllocation, QuoteLine, SaleInvoice, StoreProfile } from '@contract'

/**
 * A bill that never happened, for the branding preview.
 *
 * The white-label panel has to show a reseller what their name, mark, colour and
 * footer look like ON A RECEIPT, and the only honest way to do that is to render
 * the real `ThermalReceipt` on its real 42-column grid rather than a mock-up of
 * one. That component takes a posted `SaleInvoice`, so here is one.
 *
 * The figures FOOT. Every line's tax is computed off an MRP-inclusive rate the
 * way the quote engine does it, the breakup adds to the total, and the round-off
 * and change are consistent — because the first thing a pharmacist does with a
 * sample bill is add the column up, and a preview that does not balance costs
 * the trust of everything else on the panel.
 *
 * Three lines on purpose: two GST rates and a Schedule H item, which is what
 * makes the receipt show its mixed-rate breakup and its H-warning line. A
 * one-line specimen would preview a receipt this app never prints.
 */

function alloc(over: Partial<QuoteAllocation> & Pick<QuoteAllocation,
  'batchId' | 'batchNo' | 'expiryDate' | 'qty' | 'mrpPerUnit' | 'ratePerUnit'
  | 'grossAmount' | 'taxableValue' | 'cgst' | 'sgst' | 'lineTotal' | 'gstRatePct'>): QuoteAllocation {
  return {
    freeQty: '0',
    discountAmount: '0.00',
    igst: '0.00',
    costBasis: '0.00',
    ...over,
  }
}

function line(over: Partial<QuoteLine> & Pick<QuoteLine,
  'lineId' | 'medicineId' | 'brandName' | 'packLabel' | 'hsnCode' | 'drugSchedule'
  | 'requestedQty' | 'allocatedQty' | 'allocations' | 'grossAmount' | 'taxableValue'
  | 'cgst' | 'sgst' | 'lineTotal'>): QuoteLine {
  return {
    shortQty: '0',
    discountPct: '0',
    discountAmount: '0.00',
    igst: '0.00',
    manualBatch: false,
    ...over,
  }
}

/**
 * The specimen, bound to whichever branch is being previewed.
 *
 * The store is a parameter rather than a literal so the preview shows the
 * reseller's OWN shop head — name, address, GSTIN, licence — under their own
 * branding. A specimen with somebody else's pharmacy on it previews nothing.
 */
export function specimenInvoice(store: StoreProfile, at: Date): SaleInvoice {
  const iso = at.toISOString()
  const day = iso.slice(0, 10)

  return {
    id: 0,
    /* Marked, and marked in the number itself. This sheet is rendered on screen
       inside a settings panel; if it ever reaches paper it must not be mistaken
       for a document, and the number is the first thing anybody reads. */
    invoiceNo: `${store.invoicePrefix}/SPECIMEN`,
    storeId: store.id,
    terminalId: 1,
    invoiceDate: day,
    createdAt: iso,
    customerId: null,
    customerName: 'Specimen — not a real bill',
    customerPhone: null,
    interState: false,
    status: 'POSTED',
    prescription: null,
    operatorName: 'Preview',
    payments: [{ mode: 'CASH', amount: '300.00' }],
    amountPaid: '300.00',
    changeDue: '1.00',
    quote: {
      lines: [
        line({
          lineId: 'sp-1',
          medicineId: 0,
          brandName: 'DOLO 650 TAB',
          packLabel: '15 tabs',
          hsnCode: '30049099',
          drugSchedule: 'OTC',
          requestedQty: '10',
          allocatedQty: '10',
          grossAmount: '21.50',
          taxableValue: '19.20',
          cgst: '1.15',
          sgst: '1.15',
          lineTotal: '21.50',
          allocations: [alloc({
            batchId: 0,
            batchNo: 'DL2431',
            expiryDate: '2027-11-30',
            qty: '10',
            mrpPerUnit: '2.15',
            ratePerUnit: '2.15',
            grossAmount: '21.50',
            taxableValue: '19.20',
            cgst: '1.15',
            sgst: '1.15',
            lineTotal: '21.50',
            gstRatePct: '12',
          })],
        }),
        line({
          lineId: 'sp-2',
          medicineId: 0,
          brandName: 'AZITHRAL 500 TAB',
          packLabel: '5 tabs',
          hsnCode: '30042099',
          /* A Schedule H line, so the preview carries the warning the real
             receipt prints. A reseller's sample bill without it would look
             calmer than every bill their customers actually get. */
          drugSchedule: 'H',
          requestedQty: '5',
          allocatedQty: '5',
          grossAmount: '132.00',
          taxableValue: '117.86',
          cgst: '7.07',
          sgst: '7.07',
          lineTotal: '132.00',
          allocations: [alloc({
            batchId: 0,
            batchNo: 'AZ5512',
            expiryDate: '2026-08-31',
            qty: '5',
            mrpPerUnit: '26.40',
            ratePerUnit: '26.40',
            grossAmount: '132.00',
            taxableValue: '117.86',
            cgst: '7.07',
            sgst: '7.07',
            lineTotal: '132.00',
            gstRatePct: '12',
          })],
        }),
        line({
          lineId: 'sp-3',
          medicineId: 0,
          brandName: 'ACCU-CHEK STRIPS',
          packLabel: '25 strips',
          hsnCode: '30021500',
          drugSchedule: 'OTC',
          requestedQty: '1',
          allocatedQty: '1',
          grossAmount: '145.00',
          taxableValue: '138.10',
          cgst: '3.45',
          sgst: '3.45',
          lineTotal: '145.00',
          allocations: [alloc({
            batchId: 0,
            batchNo: 'AC9017',
            expiryDate: '2027-03-31',
            qty: '1',
            mrpPerUnit: '145.00',
            ratePerUnit: '145.00',
            grossAmount: '145.00',
            taxableValue: '138.10',
            cgst: '3.45',
            sgst: '3.45',
            lineTotal: '145.00',
            gstRatePct: '5',
          })],
        }),
      ],
      grossAmount: '298.50',
      itemDiscount: '0.00',
      billDiscountPct: '0',
      billDiscount: '0.00',
      taxableValue: '275.16',
      cgst: '11.67',
      sgst: '11.67',
      igst: '0.00',
      roundOff: store.roundOffEnabled ? '0.50' : '0.00',
      netAmount: store.roundOffEnabled ? '299.00' : '298.50',
      costOfGoods: '0.00',
      taxBreakup: [
        { gstRatePct: '5', taxableValue: '138.10', cgst: '3.45', sgst: '3.45', igst: '0.00', total: '145.00' },
        { gstRatePct: '12', taxableValue: '137.06', cgst: '8.22', sgst: '8.22', igst: '0.00', total: '153.50' },
      ],
      warnings: [],
    },
  }
}
