import type { Batch, Medicine, StoreProfile } from '@contract'
import { formatExpiry } from '@/lib/format'

/**
 * Shelf and price labels.
 *
 * THE MRP ON A LABEL BELONGS TO A BATCH, NOT TO A PRODUCT — and that one fact
 * shapes everything here.
 *
 * A shelf legitimately holds the same medicine in two batches at two printed
 * MRPs: the same brand arrives at a revised price and both are on sale until the
 * older one runs out. A "product" label showing one number is then wrong about
 * half the stock behind it, and the customer pays what is printed on the strip
 * in their hand — so the label and the pack disagree in front of them, which is
 * the one place a pharmacy cannot afford to look careless.
 *
 * So a label is issued PER BATCH. It carries the batch number and the expiry
 * alongside the price, which also makes it useful for the job it actually does
 * on the shelf: telling staff which strip to pull first.
 *
 * TWO LANGUAGES, because Indian label printers are split between them:
 *
 *  - TSPL — TSC, TVS and most of the rebadged units sold into Indian retail.
 *  - ZPL — Zebra, and the printers that emulate it.
 *
 * They are not compatible and there is no way to ask a printer which it speaks,
 * so it is a setting with a test label beside it. Both are plain text over the
 * same WebSerial connection the receipt printer uses.
 */

export type LabelLanguage = 'TSPL' | 'ZPL'

export interface LabelOptions {
  language: LabelLanguage
  /** Millimetres. 50x25 is the common pharmacy shelf label. */
  widthMm: number
  heightMm: number
  /** Dots per millimetre. 8 (203dpi) is near-universal; 12 is 300dpi. */
  dpmm: 8 | 12
  copies: number
  /** Print the MRP. Off for a rack label that must not contradict a pack. */
  showPrice: boolean
}

export const DEFAULT_LABEL: LabelOptions = {
  language: 'TSPL',
  widthMm: 50,
  heightMm: 25,
  dpmm: 8,
  copies: 1,
  showPrice: true,
}

export interface LabelData {
  brandName: string
  packLabel: string
  batchNo: string
  expiry: string
  mrp: string
  /** EAN-13 where the product has one, else the internal code. */
  barcode: string | null
  rack: string | null
}

/**
 * What goes on one label, taken from the BATCH.
 *
 * `mrpPerPack` comes off the batch rather than any product-level field for the
 * reason at the top of this file: there is no product-level MRP that is true of
 * every strip on the shelf.
 */
export function labelFor(
  batch: Batch,
  medicine: Medicine,
  barcode: string | null,
): LabelData {
  return {
    brandName: medicine.brandName,
    packLabel: medicine.packLabel,
    batchNo: batch.batchNo,
    expiry: formatExpiry(batch.expiryDate),
    mrp: batch.mrpPerPack,
    barcode,
    rack: medicine.rackLocation,
  }
}

/** Printer languages are 7-bit; ₹ is not in any of their fonts. */
const ascii = (text: string): string =>
  text
    .replace(/₹/g, 'Rs')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    // A quote or backslash inside a command string ends it early on both
    // languages, which produces a label that prints half a name and stops.
    .replace(/["\\]/g, ' ')
    .split('')
    .map((c) => (c.codePointAt(0) ?? 0) <= 0x7f ? c : '?')
    .join('')

/** Truncate to what the label can actually hold at this width. */
const fit = (text: string, chars: number): string =>
  text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1))}.`

/**
 * TSPL — TSC, TVS, and most units sold into Indian pharmacy retail.
 *
 * Sizes are in millimetres and coordinates in dots, which is the trap: a layout
 * written for 203dpi silently prints at two-thirds scale on a 300dpi head, so
 * every coordinate here is derived from `dpmm` rather than hard-coded.
 */
export function tspl(labels: readonly LabelData[], opts: LabelOptions): string {
  const d = opts.dpmm
  const out: string[] = []
  const w = opts.widthMm
  const h = opts.heightMm
  /* Characters that fit across the label in the small font, measured from the
     8-dot font's 12-dot advance. Getting this wrong wraps a brand name onto the
     price line, which is the one line that must stay readable. */
  const chars = Math.floor((w * d) / 12)

  for (const l of labels) {
    out.push(`SIZE ${w} mm,${h} mm`)
    out.push('GAP 2 mm,0 mm')
    out.push('DIRECTION 1')
    out.push('CLS')
    out.push(`TEXT 8,8,"2",0,1,1,"${ascii(fit(`${l.brandName} ${l.packLabel}`.trim(), chars))}"`)
    out.push(`TEXT 8,${8 + d * 4},"1",0,1,1,"${ascii(fit(`B:${l.batchNo}  E:${l.expiry}`, chars))}"`)
    if (opts.showPrice) {
      out.push(`TEXT 8,${8 + d * 7},"3",0,1,1,"MRP Rs${ascii(l.mrp)}"`)
    }
    if (l.rack) {
      out.push(`TEXT ${Math.round(w * d) - 8},${8 + d * 7},"2",0,1,1,"${ascii(l.rack)}"`)
    }
    if (l.barcode) {
      /* EAN13 where the code is one, CODE128 otherwise. A 13-digit code sent as
         CODE128 scans, but not as the retail barcode the counter already knows —
         so the shelf label and the pack would not match at the till. */
      const symbology = /^\d{13}$/.test(l.barcode) ? 'EAN13' : '128'
      out.push(`BARCODE 8,${8 + d * 12},"${symbology}",${d * 6},1,0,2,4,"${l.barcode}"`)
    }
    out.push(`PRINT ${Math.max(1, opts.copies)},1`)
  }
  return `${out.join('\n')}\n`
}

/**
 * ZPL — Zebra and its emulators.
 *
 * Everything is in dots from the origin, and `^PW`/`^LL` have to be set per
 * label or the printer keeps whatever the last job left, which is how one wrong
 * job turns every subsequent label the wrong length until the printer is
 * power-cycled.
 */
export function zpl(labels: readonly LabelData[], opts: LabelOptions): string {
  const d = opts.dpmm
  const w = Math.round(opts.widthMm * d)
  const h = Math.round(opts.heightMm * d)
  const chars = Math.floor(w / 12)
  const out: string[] = []

  for (const l of labels) {
    out.push('^XA')
    out.push(`^PW${w}`)
    out.push(`^LL${h}`)
    out.push('^CI28') // UTF-8 in, which still needs the ASCII fold above.
    out.push(`^FO8,8^A0N,${d * 3},${d * 3}^FD${ascii(fit(`${l.brandName} ${l.packLabel}`.trim(), chars))}^FS`)
    out.push(`^FO8,${8 + d * 4}^A0N,${d * 2},${d * 2}^FDB:${ascii(l.batchNo)}  E:${ascii(l.expiry)}^FS`)
    if (opts.showPrice) {
      out.push(`^FO8,${8 + d * 7}^A0N,${d * 4},${d * 4}^FDMRP Rs${ascii(l.mrp)}^FS`)
    }
    if (l.rack) {
      out.push(`^FO${w - d * 10},${8 + d * 7}^A0N,${d * 3},${d * 3}^FD${ascii(l.rack)}^FS`)
    }
    if (l.barcode) {
      out.push(/^\d{13}$/.test(l.barcode)
        ? `^FO8,${8 + d * 12}^BEN,${d * 6},Y,N^FD${l.barcode}^FS`
        : `^FO8,${8 + d * 12}^BCN,${d * 6},Y,N,N^FD${l.barcode}^FS`)
    }
    out.push(`^PQ${Math.max(1, opts.copies)}`)
    out.push('^XZ')
  }
  return `${out.join('\n')}\n`
}

export function renderLabels(labels: readonly LabelData[], opts: LabelOptions): string {
  return opts.language === 'ZPL' ? zpl(labels, opts) : tspl(labels, opts)
}

/** The bytes to write to the port. Both languages are plain 7-bit text. */
export function labelBytes(labels: readonly LabelData[], opts: LabelOptions): Uint8Array {
  const text = renderLabels(labels, opts)
  return Uint8Array.from([...text].map((c) => c.codePointAt(0) ?? 0x3f))
}

/**
 * A test label that proves what actually goes wrong.
 *
 * Not a placeholder: the two failures worth catching before a roll is wasted are
 * the wrong LANGUAGE — which prints command text as literal characters — and the
 * wrong dpmm, which prints at two-thirds scale and clips.
 */
export function testLabel(store: StoreProfile, opts: LabelOptions): Uint8Array {
  return labelBytes([{
    brandName: store.name,
    packLabel: `${opts.widthMm}x${opts.heightMm}mm`,
    batchNo: 'TEST01',
    expiry: '12/29',
    mrp: '123.45',
    barcode: '8901234567890',
    rack: 'A1',
  }], opts)
}
