/**
 * Printing.
 *
 * MOUNTING CONTRACT: a sheet must be rendered as a DIRECT CHILD OF <body> —
 * `createPortal(<ThermalReceipt invoice={…} store={…} />, document.body)` — and
 * then printed with `window.print()`. print.css hides every other body child on
 * paper, which is the only way the app shell is guaranteed gone whatever the
 * billing screen happens to be showing. Pass `preview` to show the same sheet
 * on screen: the attribute print.css keys off has to sit on the sheet's own
 * root, so a wrapper cannot supply it.
 *
 * Both components are pure functions of their props: no hooks, no context, no
 * network. A receipt that needed to fetch something could not be reprinted from
 * a queued offline sale.
 */
export {
  ThermalReceipt,
  RECEIPT_COLUMNS,
  amountInWords,
  fitCell,
  gridRow,
  ruleLine,
  isZeroAmount,
  upiPayUri,
} from './ThermalReceipt'

export { TaxInvoiceA4 } from './TaxInvoiceA4'

export { ReportSheet, MAX_PRINT_ROWS } from './ReportSheet'
