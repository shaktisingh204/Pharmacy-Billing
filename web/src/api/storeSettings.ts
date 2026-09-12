import type { FilingThresholds, StoreProfile } from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'

/**
 * Editing the store profile, as pure value logic.
 *
 * Most of these fields are ordinary. Two are not, and they are the reason this
 * file exists rather than a `db.stores.put`:
 *
 *  - THE INVOICE PREFIX AND THE FINANCIAL-YEAR START DECIDE DOCUMENT NUMBERS.
 *    The series is keyed on (store, financial year, terminal) and the prefix is
 *    stamped into every number it issues. Change either one part-way through a
 *    year and the same financial year contains two different series — which is
 *    not a cosmetic problem: GSTR-1 Table 13 reports each series as total,
 *    cancelled and net, and a year that changed prefix half way through cannot
 *    be reported as either one series or two without a gap. Moving the FY start
 *    is worse still: documents already numbered under the old boundary can be
 *    re-issued under the new one, and the uniqueness of an invoice number is the
 *    single assumption everything downstream rests on.
 *
 *    So both are guarded, and both refusals say what would break rather than
 *    just "not allowed".
 *
 *  - THE FILING THRESHOLDS ARE UNVERIFIED LAW. They were shipped as settings
 *    precisely so a notification is an edit rather than a deploy — which was
 *    only half true while nothing could edit them.
 */

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/
/** `name@bank`. Deliberately loose on the handle: banks add new ones constantly
 *  and a strict list would reject a valid VPA a customer is standing in front of. */
const VPA = /^[\w.\-]{2,64}@[A-Za-z]{2,32}$/
const PREFIX = /^[A-Z][A-Z0-9]{0,5}$/
const MONEY = /^\d+(\.\d{1,2})?$/
/* Deliberately loose. An address on a bill is free text in every state's rules,
   and the only thing worth checking is that somebody typed something. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export type StorePatch = Partial<Omit<StoreProfile, 'id' | 'filing'>> & {
  filing?: Partial<FilingThresholds>
}

export interface StoreEditContext {
  /** Documents already issued in the CURRENT financial year, across all series. */
  issuedThisYear: number
}

const invalid = (code: string, message: string, field: string): ApiError =>
  new ApiError({ code, message, details: { field } })

/**
 * Validate a change and return the profile it produces.
 *
 * Pure: the caller writes it. Everything that can be wrong is wrong here, so a
 * screen can run the same function on every keystroke and show the refusal
 * before the button is pressed rather than after.
 */
export function applyStorePatch(
  current: StoreProfile,
  patch: StorePatch,
  ctx: StoreEditContext,
): StoreProfile {
  /* NORMALISED BEFORE VALIDATED, not after.
     A GSTIN and an invoice prefix are both upper-case by convention and both are
     typed by hand. Checking the raw text first rejected `27aaccs4471m1zb` and
     `sm` — which are the same values, correctly entered, in the case a keyboard
     is actually in. Validating the normalised form and storing that is the only
     order that accepts what a person types. */
  const next: StoreProfile = {
    ...current,
    ...patch,
    ...(patch.gstin !== undefined ? { gstin: patch.gstin.trim().toUpperCase() } : {}),
    ...(patch.invoicePrefix !== undefined
      ? { invoicePrefix: patch.invoicePrefix.trim().toUpperCase() }
      : {}),
    ...(patch.stateCode !== undefined ? { stateCode: patch.stateCode.trim() } : {}),
    filing: { ...current.filing, ...patch.filing },
  }

  if (patch.name !== undefined && next.name.trim() === '') {
    throw invalid('NAME_REQUIRED', 'The pharmacy needs a name — it prints on every bill', 'name')
  }
  /* The premises and a way to reach them are what makes a printed bill traceable
     to a shop. All three are checked only when they are being EDITED, so a
     profile that predates the check can still have its footer note changed. */
  if (patch.addressLine !== undefined && next.addressLine.trim() === '') {
    throw invalid(
      'ADDRESS_REQUIRED',
      'The address prints at the head of every bill — a bill that does not say where it was issued is not traceable to these premises',
      'addressLine',
    )
  }
  if (patch.city !== undefined && next.city.trim() === '') {
    throw invalid('CITY_REQUIRED', 'The city prints under the address on every bill', 'city')
  }
  if (patch.phone !== undefined && next.phone.trim() === '') {
    throw invalid(
      'PHONE_REQUIRED',
      'The phone number prints on every bill — it is how a customer reaches the shop about what they were dispensed',
      'phone',
    )
  }
  if (patch.email !== undefined && next.email !== null && next.email.trim() !== '') {
    if (!EMAIL.test(next.email.trim())) {
      throw invalid('EMAIL_INVALID', 'That is not an email address. Leave it empty for none.', 'email')
    }
  }

  if (patch.nearExpiryBuckets !== undefined) {
    const buckets = next.nearExpiryBuckets
    if (buckets.length === 0) {
      throw invalid(
        'BUCKETS_REQUIRED',
        'At least one near-expiry window, or the inventory screen has nothing to warn about',
        'nearExpiryBuckets',
      )
    }
    if (buckets.length > 6) {
      throw invalid(
        'BUCKETS_TOO_MANY',
        'At most six windows. Past that the expiry column is a legend rather than a warning.',
        'nearExpiryBuckets',
      )
    }
    if (buckets.some((d) => !Number.isInteger(d) || d < 1 || d > 730)) {
      throw invalid(
        'BUCKET_INVALID',
        'A near-expiry window is a whole number of days, 1 to 730',
        'nearExpiryBuckets',
      )
    }
    if (new Set(buckets).size !== buckets.length) {
      throw invalid(
        'BUCKET_DUPLICATE',
        'Two windows at the same number of days would colour one batch twice',
        'nearExpiryBuckets',
      )
    }
  }
  if (patch.gstin !== undefined && !GSTIN.test(next.gstin.trim())) {
    throw invalid(
      'GSTIN_INVALID',
      'That is not a 15-character GSTIN. It prints on every bill and is what a return is filed against.',
      'gstin',
    )
  }
  if (patch.stateCode !== undefined && !/^\d{2}$/.test(next.stateCode.trim())) {
    throw invalid('STATE_CODE_INVALID', 'The state code is two digits', 'stateCode')
  }
  /* The GSTIN carries the state in its first two characters. Letting the two
     disagree means every bill is taxed against one state and filed against
     another, and neither figure is wrong on its own screen. */
  if (
    (patch.gstin !== undefined || patch.stateCode !== undefined)
    && GSTIN.test(next.gstin.trim())
    && next.gstin.trim().slice(0, 2) !== next.stateCode.trim()
  ) {
    throw invalid(
      'GSTIN_STATE_MISMATCH',
      `The GSTIN begins with ${next.gstin.trim().slice(0, 2)} but the state code is ${next.stateCode}. One of them is wrong, and bills would be taxed against one state and filed against the other.`,
      'stateCode',
    )
  }

  if (patch.dlNos !== undefined && next.dlNos.filter((d) => d.trim() !== '').length === 0) {
    throw invalid(
      'DL_REQUIRED',
      'A retail bill without a drug licence number is not a compliant bill',
      'dlNos',
    )
  }

  // ------------------------------------------------------- the numbering ---

  if (patch.invoicePrefix !== undefined && next.invoicePrefix !== current.invoicePrefix) {
    if (!PREFIX.test(next.invoicePrefix)) {
      throw invalid(
        'PREFIX_INVALID',
        'A prefix is 1–6 characters, starting with a letter — it becomes part of every invoice number',
        'invoicePrefix',
      )
    }
    if (ctx.issuedThisYear > 0) {
      throw invalid(
        'PREFIX_LOCKED_THIS_YEAR',
        `${ctx.issuedThisYear} document${ctx.issuedThisYear === 1 ? ' has' : 's have'} already been issued this financial year. Changing the prefix now would put two different series inside one year, which cannot be reported as either one series or two without a gap. Change it at the year end.`,
        'invoicePrefix',
      )
    }
  }

  if (
    patch.financialYearStartMonth !== undefined
    && patch.financialYearStartMonth !== current.financialYearStartMonth
  ) {
    const m = patch.financialYearStartMonth
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw invalid('FY_MONTH_INVALID', 'The financial year starts in a month from 1 to 12', 'financialYearStartMonth')
    }
    if (ctx.issuedThisYear > 0) {
      throw invalid(
        'FY_LOCKED_THIS_YEAR',
        `${ctx.issuedThisYear} document${ctx.issuedThisYear === 1 ? ' has' : 's have'} already been issued this financial year. Moving the year boundary now can re-issue numbers that have already been given out, and a unique invoice number is the one thing everything downstream assumes.`,
        'financialYearStartMonth',
      )
    }
  }

  // --------------------------------------------------------- the counter ---

  if (patch.expiryGuardDays !== undefined) {
    const d = patch.expiryGuardDays
    if (!Number.isInteger(d) || d < 0 || d > 365) {
      throw invalid('GUARD_INVALID', 'The expiry guard is a whole number of days, 0 to 365', 'expiryGuardDays')
    }
  }

  if (patch.upiVpa !== undefined && next.upiVpa !== null && next.upiVpa.trim() !== '') {
    if (!VPA.test(next.upiVpa.trim())) {
      throw invalid(
        'VPA_INVALID',
        'A UPI ID looks like name@bank. This one goes into the QR on every bill, so a wrong one takes the customer\'s money nowhere.',
        'upiVpa',
      )
    }
  }

  // -------------------------------------------------------- the filing ---

  if (patch.filing) {
    for (const key of ['b2clMinimum', 'rule46Minimum'] as const) {
      const v = patch.filing[key]
      if (v === undefined) continue
      if (!MONEY.test(v)) {
        throw invalid('THRESHOLD_INVALID', 'A threshold is an amount, like 250000.00', key)
      }
      if (D.isNeg(D.dec(v))) {
        throw invalid('THRESHOLD_NEGATIVE', 'A threshold cannot be negative', key)
      }
    }
    if (patch.filing.hsnDigits !== undefined && ![4, 6, 8].includes(patch.filing.hsnDigits)) {
      throw invalid(
        'HSN_DIGITS_INVALID',
        'HSN is reported at 4, 6 or 8 digits depending on turnover',
        'hsnDigits',
      )
    }
  }

  return {
    ...next,
    name: next.name.trim(),
    gstin: next.gstin.trim().toUpperCase(),
    stateCode: next.stateCode.trim(),
    invoicePrefix: next.invoicePrefix.trim().toUpperCase(),
    /* Empty means "no UPI", which is different from the empty string: the
       receipt renderer asks `if (store.upiVpa)` and a blank string would print a
       QR pointing at nothing. */
    upiVpa: next.upiVpa && next.upiVpa.trim() !== '' ? next.upiVpa.trim() : null,
    dlNos: next.dlNos.map((d) => d.trim()).filter((d) => d !== ''),
    /* Stored WIDEST FIRST, because two consumers read position rather than
       value: the dashboard takes the max as its near-expiry horizon and the day
       close takes `.at(-1)` as the warn threshold. A shop that typed its windows
       ascending would get the 180-day figure as its 30-day warning, and nothing
       on any screen would look wrong. */
    nearExpiryBuckets: [...next.nearExpiryBuckets].sort((a, b) => b - a),
  }
}

/**
 * What a change would do, said BEFORE it is made.
 *
 * Separate from the refusals: these are edits that are allowed and still worth
 * a sentence, because the consequence lands somewhere other than this screen.
 */
export function warningsFor(current: StoreProfile, patch: StorePatch): string[] {
  const out: string[] = []
  if (patch.roundOffEnabled === false && current.roundOffEnabled) {
    out.push('Turning round-off off means bills settle in paise. A counter that cannot make 40 paise of change will be short on every bill.')
  }
  if (patch.allowNegativeStock === true && !current.allowNegativeStock) {
    out.push('Allowing negative stock lets a sale complete when the shelf says empty. Use it only if the shelf is routinely ahead of the data — it removes the guard that catches a mis-keyed receipt.')
  }
  if (patch.filing?.hsnDigits !== undefined && patch.filing.hsnDigits !== current.filing.hsnDigits) {
    out.push('The HSN digit requirement depends on annual turnover, which this app does not hold. Nothing is padded or truncated — this only changes what the filing check warns about.')
  }
  if (patch.upiVpa !== undefined && (patch.upiVpa ?? '') === '' && current.upiVpa) {
    out.push('Clearing the UPI ID removes the payment QR from every printed bill.')
  }
  if (
    patch.gstin !== undefined
    && patch.gstin.trim().toUpperCase() !== current.gstin.trim().toUpperCase()
  ) {
    out.push('Bills already issued keep the old GSTIN — it is snapshotted onto each document, not looked up when one is reprinted. Only bills from now on carry the new one.')
  }
  if (
    patch.nearExpiryBuckets !== undefined
    && patch.nearExpiryBuckets.join(',') !== current.nearExpiryBuckets.join(',')
  ) {
    out.push('The expiry columns on Inventory and Medicines re-bucket immediately, and the dashboard\'s near-expiry figure follows the widest window. No stock moves and nothing is written.')
  }
  return out
}
