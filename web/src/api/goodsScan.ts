import type { Medicine } from '@contract'
import { parseGs1 } from '@/lib/gs1'
import type { Gs1Data } from '@/lib/gs1'

/**
 * A scanned carton, turned into a goods-receipt line.
 *
 * Receiving is where the most error-prone typing in the app happens: batch
 * number and expiry, keyed by hand off a carton, forty lines at a time, usually
 * while a delivery driver waits. Both of those fields are load-bearing — they
 * print on the customer's bill and are what a Drug Inspector checks against the
 * strip in somebody's hand — and a mis-keyed expiry also silently poisons FEFO
 * allocation and every near-expiry report for the next two years.
 *
 * A distributor's carton already carries all three in a GS1-128 or DataMatrix:
 * GTIN (AI 01), batch (AI 10), expiry (AI 17). Scanning it is one action instead
 * of three fields, and it cannot mistype.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: fill in a quantity. AI 30 exists and
 * distributors do use it, but it means "units in this carton", which is not the
 * number of packs being billed on the line — and a quantity that arrives from
 * somewhere the operator did not type, on the field that decides what is paid
 * for, is the one thing here that must stay manual.
 */

export type ScanOutcome =
  /** GTIN matched a medicine. Batch and expiry filled where the code carried them. */
  | { kind: 'matched'; medicine: Medicine; batchNo?: string; expiry?: string; gs1: Gs1Data }
  /** A GS1 code whose GTIN is not in the barcode master — offer to link it. */
  | { kind: 'unknownGtin'; gtin: string; batchNo?: string; expiry?: string; gs1: Gs1Data }
  /** A plain product barcode: the medicine, and nothing else. */
  | { kind: 'plainBarcode'; medicine: Medicine }
  /** Scanned, understood as a barcode, matched nothing at all. */
  | { kind: 'unknown'; code: string }

export interface GoodsScanContext {
  /** `barcode -> medicineId`, the barcode master. */
  barcodes: ReadonlyMap<string, number>
  medicineOf: (id: number) => Medicine | undefined
}

/**
 * GS1 encodes every GTIN as 14 digits, so a 13-digit retail barcode appears as
 * `0` + EAN-13. The barcode master holds what was scanned at the counter, which
 * is the 13-digit form — so both spellings are tried rather than requiring the
 * master to have been populated in GS1's padding.
 */
export function gtinVariants(gtin: string): string[] {
  const out = [gtin]
  if (gtin.length === 14 && gtin.startsWith('0')) out.push(gtin.slice(1))
  if (gtin.length === 13) out.push(`0${gtin}`)
  /* A 12-digit UPC-A is an EAN-13 with a leading zero, and Indian distributors
     receive plenty of imported stock carrying one. */
  if (gtin.length === 12) out.push(`0${gtin}`, `00${gtin}`)
  return out
}

function lookup(code: string, ctx: GoodsScanContext): Medicine | undefined {
  for (const variant of gtinVariants(code)) {
    const id = ctx.barcodes.get(variant)
    if (id !== undefined) {
      const medicine = ctx.medicineOf(id)
      if (medicine) return medicine
    }
  }
  return undefined
}

/** `2027-11-30` from AI 17 back to the `MM/YY` the grid and the pack both use. */
export function toPrintedExpiry(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(2, 4)}`
}

export function readGoodsScan(payload: string, ctx: GoodsScanContext): ScanOutcome {
  const code = payload.trim()
  if (code === '') return { kind: 'unknown', code }

  const gs1 = parseGs1(code)

  /* A GS1 code is one that actually yielded structured data. `parseGs1` returns
     a shape for anything, so "did it parse" is not the question — "did it find
     an element string" is. A plain EAN-13 has no AIs and must not be treated as
     a carton code whose batch happens to be missing. */
  const structured = gs1.gtin !== undefined
    || gs1.batch !== undefined
    || gs1.expiry !== undefined

  if (!structured) {
    const medicine = lookup(code, ctx)
    return medicine ? { kind: 'plainBarcode', medicine } : { kind: 'unknown', code }
  }

  const batchNo = gs1.batch
  const expiry = gs1.expiry ? toPrintedExpiry(gs1.expiry) : undefined

  if (gs1.gtin) {
    const medicine = lookup(gs1.gtin, ctx)
    if (medicine) {
      return {
        kind: 'matched',
        medicine,
        ...(batchNo !== undefined ? { batchNo } : {}),
        ...(expiry !== undefined ? { expiry } : {}),
        gs1,
      }
    }
    /* The GTIN is real and simply unknown to this shop — which is the ordinary
       case on the first delivery of a line. The batch and expiry are still good
       and are handed over, so linking the code fills the whole row at once. */
    return {
      kind: 'unknownGtin',
      gtin: gs1.gtin,
      ...(batchNo !== undefined ? { batchNo } : {}),
      ...(expiry !== undefined ? { expiry } : {}),
      gs1,
    }
  }

  /* Structured, but with no GTIN: some cartons carry only 10 and 17. Useless on
     its own — a batch belongs to a product — so it is reported as unknown rather
     than silently applied to whichever row happens to be focused. */
  return { kind: 'unknown', code }
}

/** What the operator is told a scan did. Written so the row it changed is named. */
export function describeScan(outcome: ScanOutcome): string {
  switch (outcome.kind) {
    case 'matched': {
      const filled = [
        outcome.batchNo ? 'batch' : null,
        outcome.expiry ? 'expiry' : null,
      ].filter(Boolean)
      return filled.length > 0
        ? `${outcome.medicine.brandName} — ${filled.join(' and ')} filled from the carton`
        : `${outcome.medicine.brandName} — the code carried no batch or expiry`
    }
    case 'unknownGtin':
      return `Carton code ${outcome.gtin} is not linked to anything yet`
    case 'plainBarcode':
      return `${outcome.medicine.brandName} — a product barcode, so no batch or expiry`
    case 'unknown':
      return 'That code matched nothing in the catalogue'
  }
}
