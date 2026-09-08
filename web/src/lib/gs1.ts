/**
 * GS1 element-string parsing, for the 2D code printed on a pharma pack.
 *
 * One payload carries the GTIN, the batch and the expiry, and exactly one rule
 * decides where each ends: FIXED-length AIs are self-delimiting, VARIABLE-length
 * AIs run to an FNC1 separator or to the end of the payload. Read a variable AI
 * as if it were fixed — or, far more commonly, lose the FNC1 on the way in from
 * the keyboard wedge — and the batch silently swallows the expiry behind it.
 * That failure is invisible on screen: the bill shows a plausible batch number
 * and no expiry at all.
 */

/** FNC1, the GS1 field separator. A wedge scanner types it as Ctrl+] — see scanner.ts. */
const FNC1 = '\x1D'

export interface Gs1Data {
  /** AI 01, as encoded: 14 digits. A 13-digit pack barcode appears here as '0' + EAN-13. */
  gtin?: string
  batch?: string
  serial?: string
  /** AI 17, resolved to 'YYYY-MM-DD'. */
  expiry?: string
  /** AI 11, resolved to 'YYYY-MM-DD'. */
  productionDate?: string
  raw: string
  /** Element strings we chose not to interpret, kept whole (AI + value). */
  unparsed: string[]
}

/**
 * How many digits the AI itself occupies, keyed by its first two (GS1 General
 * Specifications, the AI prefix table). Anything absent is a 2-digit AI.
 */
const AI_LENGTH: Record<string, number> = {
  '23': 3, '24': 3, '25': 3,
  '31': 4, '32': 4, '33': 4, '34': 4, '35': 4, '36': 4, '39': 4,
  '40': 3, '41': 3, '42': 3, '43': 4,
  // 71 is the odd one out in this block: 710–716 (the national healthcare
  // reimbursement numbers, which appear on imported pharma packs) are 3-digit.
  '70': 4, '71': 3, '72': 4,
  '80': 4, '81': 4, '82': 4,
}

/** AIs with a fixed value length: these are NOT terminated by an FNC1. */
const FIXED_LENGTH: Record<string, number> = {
  '00': 18, '01': 14, '02': 14,
  '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6,
  '20': 2,
}

/** 31nn–36nn are the measurement AIs; every one of them carries six digits. */
const FIXED_MEASURE = new Set(['31', '32', '33', '34', '35', '36'])

function fixedValueLength(ai: string): number | null {
  const prefix = ai.slice(0, 2)
  if (ai.length === 4 && FIXED_MEASURE.has(prefix)) return 6
  if (ai.length === 3 && prefix === '41') return 13 // 41n is a 13-digit GLN
  return FIXED_LENGTH[ai] ?? null
}

/**
 * YYMMDD → ISO. YY is 2000 + YY unconditionally: every date this app reads off a
 * pack is an expiry or a recent production date, so the GS1 sliding-window rule
 * (which reads 95 as 1995) could only ever yield a date we would reject anyway.
 */
function gs1DateToIso(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const year = 2000 + Number(yymmdd.slice(0, 2))
  const month = Number(yymmdd.slice(2, 4))
  if (month < 1 || month > 12) return null

  const last = lastDayOfMonth(year, month)
  // DD = 00 means "last day of the month" per the spec, and it is also the
  // common case: a printed pharmacy expiry is a month, and this project stores
  // it as the last day of that month ("11/27" → 2027-11-30).
  const day = Number(yymmdd.slice(4, 6))
  const resolved = day === 0 ? last : day
  if (resolved > last) return null
  return `${year}-${pad2(month)}-${pad2(resolved)}`
}

/** Day 0 of the next month is the last day of this one — leap years included. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function assign(out: Gs1Data, ai: string, value: string): void {
  switch (ai) {
    case '01':
      out.gtin = value
      return
    case '10':
      out.batch = value
      return
    case '21':
      out.serial = value
      return
    case '17': {
      const iso = gs1DateToIso(value)
      if (iso) out.expiry = iso
      else out.unparsed.push(ai + value)
      return
    }
    case '11': {
      const iso = gs1DateToIso(value)
      if (iso) out.productionDate = iso
      else out.unparsed.push(ai + value)
      return
    }
    default:
      out.unparsed.push(ai + value)
  }
}

/**
 * Accepts the raw form ("0108901…\x1D17271130"), a payload with leading or
 * doubled separators, and the human-readable bracket form printed under the
 * symbol ("(01)08901…(17)271130"), which some wedges are configured to emit.
 */
export function parseGs1(payload: string): Gs1Data {
  const out: Gs1Data = { raw: payload, unparsed: [] }
  // Anchored on purpose: '(' is a legal CSET 82 character inside a batch number,
  // so a payload that merely CONTAINS one is still the raw form.
  if (/^\(\d{2,4}\)/.test(payload)) return parseBracketForm(payload, out)

  let i = 0
  while (i < payload.length) {
    if (payload.charAt(i) === FNC1) {
      i += 1
      continue
    }
    const prefix = payload.slice(i, i + 2)
    const aiLen = AI_LENGTH[prefix] ?? 2
    const ai = payload.slice(i, i + aiLen)
    // Once an AI does not parse we no longer know where the next one starts, so
    // guessing further would invent element strings. Keep the tail verbatim.
    if (ai.length < aiLen || !/^\d+$/.test(ai)) {
      out.unparsed.push(payload.slice(i))
      break
    }
    i += aiLen

    const fixed = fixedValueLength(ai)
    if (fixed !== null) {
      const value = payload.slice(i, i + fixed)
      i += value.length
      if (value.length < fixed) {
        out.unparsed.push(ai + value)
        break
      }
      assign(out, ai, value)
      continue
    }

    const end = payload.indexOf(FNC1, i)
    const value = end === -1 ? payload.slice(i) : payload.slice(i, end)
    i = end === -1 ? payload.length : end + 1
    assign(out, ai, value)
  }
  return out
}

function parseBracketForm(payload: string, out: Gs1Data): Gs1Data {
  const element = /\((\d{2,4})\)([^(]*)/g
  for (const m of payload.matchAll(element)) {
    const ai = m[1]
    if (ai === undefined) continue
    // A wedge configured for the bracket form still transmits the FNC1 keystroke.
    // The parentheses already delimit, so a separator can only pollute the value,
    // and a batch of "MFL2214\x1D" matches nothing on file.
    assign(out, ai, (m[2] ?? '').split(FNC1).join(''))
  }
  return out
}

/**
 * The check digit of an EAN-13: digits weighted 1,3 from the left, completed to
 * the next multiple of ten. Returns '' for anything that is not 12 digits —
 * these functions validate scanner output, they do not assert programmer error.
 */
export function ean13CheckDigit(first12: string): string {
  if (!/^\d{12}$/.test(first12)) return ''
  let sum = 0
  for (let i = 0; i < 12; i += 1) {
    sum += Number(first12.charAt(i)) * (i % 2 === 0 ? 1 : 3)
  }
  return String((10 - (sum % 10)) % 10)
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false
  return ean13CheckDigit(code.slice(0, 12)) === code.slice(12)
}
