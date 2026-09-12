/**
 * Money in words, and money in notes.
 *
 * Both live here rather than in `src/print` because both are read at the
 * COUNTER as well as on paper: the customer display spells the total out loud
 * for a customer who cannot read the small figures, and the change-due pad
 * tells the operator which notes to pull. The receipt imports from here.
 *
 * Everything parses DIGITS in BigInt. The paise of a lakh-rupee bill do not
 * survive a float, and the third decimal (which a discount can produce) has to
 * round half away from zero, which IEEE-754 will not do.
 */

import type { Money } from '@contract'

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

/** Whole paise, half away from zero. `null` when the string is not money. */
function toPaise(amount: Money): { minus: boolean; paise: bigint } | null {
  const parsed = MONEY.exec(amount)
  if (!parsed) return null
  const [, minus, whole = '0', fraction = ''] = parsed
  const roundUp = fraction.charAt(2) >= '5'
  return {
    minus: Boolean(minus),
    paise: BigInt(whole + fraction.padEnd(2, '0').slice(0, 2)) + (roundUp ? 1n : 0n),
  }
}

/**
 * "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy
 * Eight Paise Only" — the line a bank clerk and a GST officer both read.
 */
export function amountInWords(amount: Money): string {
  const parsed = toPaise(amount)
  if (!parsed) return '—'

  const rupees = parsed.paise / 100n
  const remainder = Number(parsed.paise % 100n)

  const rupeeWords = rupees > 0n
    ? `${rupeesInWords(rupees)} ${rupees === 1n ? 'Rupee' : 'Rupees'}`
    : ''
  const paiseWords = remainder > 0
    ? `${under100(remainder)} ${remainder === 1 ? 'Paisa' : 'Paise'}`
    : ''

  if (!rupeeWords && !paiseWords) return 'Zero Rupees Only'
  const sign = parsed.minus ? 'Minus ' : ''
  const body = rupeeWords && paiseWords ? `${rupeeWords} and ${paiseWords}` : rupeeWords || paiseWords
  return `${sign}${body} Only`
}

/**
 * Every note and coin the RBI currently issues, largest first.
 *
 * The ₹2000 note is deliberately absent from the TENDER pad but present here:
 * it was withdrawn from circulation in 2023 and a customer will not hand one
 * over, but a drawer can still hold one and the greedy split below is only ever
 * asked to describe change the shop is giving BACK.
 */
export const CHANGE_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const

/** What the tender pad offers. One tap per note the customer actually hands over. */
export const TENDER_DENOMINATIONS = [500, 200, 100, 50, 20, 10] as const

export interface DenominationCount {
  /** Face value in whole rupees. */
  value: number
  count: number
}

/**
 * The notes to count back, greedily and largest-first — which is how a counter
 * actually pays change and, with this denomination set, also the minimum count.
 *
 * Paise are dropped rather than approximated: a shop with round-off enabled
 * never owes them, and a coin the drawer does not contain is worse than silence.
 */
export function changeBreakdown(amount: Money): DenominationCount[] {
  const parsed = toPaise(amount)
  if (!parsed || parsed.minus) return []
  let rupees = Number(parsed.paise / 100n)
  const out: DenominationCount[] = []
  for (const value of CHANGE_DENOMINATIONS) {
    const count = Math.floor(rupees / value)
    if (count > 0) {
      out.push({ value, count })
      rupees -= count * value
    }
  }
  return out
}
