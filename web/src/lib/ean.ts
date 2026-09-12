/**
 * EAN-13 / EAN-8, as bar widths.
 *
 * Drawn here rather than through bwip-js, which is already a dependency but
 * costs about a megabyte and is loaded lazily for printing. A catalogue drawer
 * that renders one symbol next to a code does not justify pulling that chunk
 * onto a counter machine, and the encoding is a lookup table.
 *
 * This produces a PICTURE OF A CODE, for a human comparing the drawer against
 * the pack in their hand. Printed labels go through the print module, which
 * knows about quiet zones, module widths and printer DPI; nothing here should
 * ever be scanned off a screen.
 */

/** Left-hand odd parity. */
const L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
] as const

/** Left-hand even parity. */
const G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
] as const

/** Right-hand, the complement of L. */
const R = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
] as const

/**
 * The thirteenth digit is not printed as bars — it is encoded in the PARITY of
 * the first six. That is why an EAN-13 fits in the same 95 modules as a UPC-A.
 */
const PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
] as const

const GUARD = '101'
const CENTRE = '01010'

function digits(code: string): number[] | null {
  const out: number[] = []
  for (const ch of code) {
    const d = ch.charCodeAt(0) - 48
    if (d < 0 || d > 9) return null
    out.push(d)
  }
  return out
}

/** Positions 1..n-1 weighted 3,1,3,1… from the right. */
export function eanCheckDigit(body: string): number | null {
  const ds = digits(body)
  if (ds === null) return null
  let sum = 0
  for (let i = ds.length - 1; i >= 0; i--) {
    const weight = (ds.length - 1 - i) % 2 === 0 ? 3 : 1
    sum += (ds[i] ?? 0) * weight
  }
  return (10 - (sum % 10)) % 10
}

export interface EanSymbol {
  /** One character per module: '1' is a bar, '0' is a space. */
  modules: string
  /** What is printed under the bars, grouped the way the standard prints it. */
  groups: string[]
  kind: 'EAN-13' | 'EAN-8'
  /** False when the printed check digit does not match the computed one. */
  checkDigitValid: boolean
}

/**
 * Encode a GTIN as bar modules, or null when it is not a drawable symbol.
 *
 * A 12-digit UPC-A and a zero-padded 14-digit GTIN-14 are the SAME article
 * number as the 13-digit form, so both are normalised into it rather than
 * refused — that is exactly how a code scanned off a GS1 DataMatrix reaches
 * this app. Anything else (a shop's own internal code, a 14-digit number that
 * is genuinely a case code) returns null and is shown as digits instead of as a
 * symbol that would not scan.
 */
export function encodeEan(raw: string): EanSymbol | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const normalised =
    trimmed.length === 13 ? trimmed
      : trimmed.length === 12 ? `0${trimmed}`
        : trimmed.length === 14 && trimmed.startsWith('0') ? trimmed.slice(1)
          : trimmed.length === 8 ? trimmed
            : null
  if (normalised === null) return null

  const ds = digits(normalised)
  if (ds === null) return null

  const body = normalised.slice(0, -1)
  const checkDigitValid = eanCheckDigit(body) === ds[ds.length - 1]

  if (normalised.length === 8) {
    const left = ds.slice(0, 4).map((d) => L[d] ?? '').join('')
    const right = ds.slice(4).map((d) => R[d] ?? '').join('')
    return {
      modules: GUARD + left + CENTRE + right + GUARD,
      groups: [normalised.slice(0, 4), normalised.slice(4)],
      kind: 'EAN-8',
      checkDigitValid,
    }
  }

  const parity = PARITY[ds[0] ?? 0] ?? PARITY[0]
  const left = ds.slice(1, 7)
    .map((d, i) => (parity[i] === 'L' ? L[d] : G[d]) ?? '')
    .join('')
  const right = ds.slice(7).map((d) => R[d] ?? '').join('')

  return {
    modules: GUARD + left + CENTRE + right + GUARD,
    // 1 | 6 | 6, which is how the number is printed under a retail symbol.
    groups: [normalised.slice(0, 1), normalised.slice(1, 7), normalised.slice(7)],
    kind: 'EAN-13',
    checkDigitValid,
  }
}

export interface EanBar {
  x: number
  width: number
}

/** Runs of consecutive bars, so the SVG is ~30 rects rather than 95. */
export function barsOf(modules: string): EanBar[] {
  const bars: EanBar[] = []
  let i = 0
  while (i < modules.length) {
    if (modules[i] !== '1') { i++; continue }
    const start = i
    while (i < modules.length && modules[i] === '1') i++
    bars.push({ x: start, width: i - start })
  }
  return bars
}
