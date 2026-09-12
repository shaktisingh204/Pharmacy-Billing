import type { BrandProfile, SaleInvoice, StoreProfile } from '@contract'
import { receiptBytes, shouldOpenDrawer } from './escpos'
import { printBytes } from './serial'

/**
 * Print a bill by whichever route is available, and SAY WHICH.
 *
 * One entry point for every screen that prints, so the drawer rule, the roll
 * width and the fallback cannot differ between billing and the sales register —
 * which is exactly the drift that produces "printing works from the counter but
 * not from Sales".
 *
 * The preferences are read from the same `localStorage` key the Printing panel
 * writes. Threading them through React would mean every print path taking two
 * more props and one of them eventually not getting them.
 */

const STORAGE_KEY = 'rxbill.printer'

interface Prefs {
  columns: number
  transliterateRupee: boolean
}

const DEFAULTS: Prefs = { columns: 42, transliterateRupee: true }

function prefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

/**
 * Has anybody set this machine's printer up at all?
 *
 * Read from the same key rather than exported from the panel, so asking the
 * question does not drag a settings screen into the bundle. Absent, every bill
 * goes through the browser print dialog — which works, and costs a dialog on
 * each of two hundred bills a day.
 */
export function printerConfigured(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export interface PrintResult {
  route: 'serial' | 'browser'
  drawerOpened: boolean
}

export async function printInvoice(
  invoice: SaleInvoice,
  store: StoreProfile,
  brand: BrandProfile | null | undefined,
): Promise<PrintResult> {
  const p = prefs()
  /* The drawer opens only when cash moved, and only on the FIRST print. A
     reprint an hour later must not throw the till open — the money is long since
     in the drawer and an unexplained open till is what a shrinkage investigation
     starts from. */
  const drawer = shouldOpenDrawer(invoice) && invoice.status === 'POSTED'
  const bytes = receiptBytes(invoice, store, brand, {
    columns: p.columns,
    transliterateRupee: p.transliterateRupee,
    openDrawer: drawer,
  })
  const route = await printBytes(bytes, () => window.print())
  return { route, drawerOpened: drawer && route === 'serial' }
}

/** A reprint: the same paper, never the drawer. */
export async function reprintInvoice(
  invoice: SaleInvoice,
  store: StoreProfile,
  brand: BrandProfile | null | undefined,
): Promise<PrintResult> {
  const p = prefs()
  const bytes = receiptBytes(invoice, store, brand, {
    columns: p.columns,
    transliterateRupee: p.transliterateRupee,
    openDrawer: false,
  })
  const route = await printBytes(bytes, () => window.print())
  return { route, drawerOpened: false }
}
