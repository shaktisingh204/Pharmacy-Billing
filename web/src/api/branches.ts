import type { StoreProfile } from '@contract'
import { ApiError } from '@contract'

/**
 * Opening a branch, as pure value logic.
 *
 * A branch is not a row with a different name on it. Three things about it are
 * load-bearing and none of them is obvious from the form:
 *
 *  - THE INVOICE PREFIX MUST BE UNIQUE ACROSS THE CHAIN. The document series is
 *    keyed on (store, financial year, terminal) and stamps the prefix into every
 *    number it issues, so two branches sharing `RX` issue `RX/25-26/T1/000001`
 *    twice — in two shops, on two bills, both valid-looking. Nothing downstream
 *    can tell them apart afterwards, and an invoice number is the one identifier
 *    everything else assumes is unique.
 *
 *  - THE GSTIN DECIDES WHERE THE BILL IS FILED. A branch in another state is a
 *    separate registration; a branch in the same state usually shares the head
 *    office's GSTIN. Both are legitimate, and the difference is the first two
 *    characters — so the state code and the GSTIN are checked against each
 *    other here exactly as they are for the head office.
 *
 *  - A BRANCH NEEDS ITS OWN DRUG LICENCE. The licence is issued against
 *    premises, not against a company, and the numbers print on that shop's
 *    bills. Copying the head office's is the single most common way a chain
 *    ends up printing a licence that does not cover the counter it was sold at,
 *    so it is required rather than inherited.
 *
 * Everything else about a branch — the tax thresholds, the expiry guard, the
 * near-expiry buckets, the round-off policy — IS inherited, because those are
 * chain policy and a per-branch copy of them is a per-branch drift.
 */

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/
const PREFIX = /^[A-Z][A-Z0-9]{0,5}$/
const VPA = /^[\w.\-]{2,64}@[A-Za-z]{2,32}$/

export interface NewBranch {
  name: string
  tagline: string
  addressLine: string
  city: string
  state: string
  stateCode: string
  phone: string
  email: string
  gstin: string
  dlNos: string[]
  invoicePrefix: string
  upiVpa: string
}

const invalid = (code: string, message: string, field: string): ApiError =>
  new ApiError({ code, message, details: { field } })

/** The fields a new branch starts from, taken off the branch it is opened from. */
export function branchTemplate(from: StoreProfile): NewBranch {
  return {
    name: '',
    tagline: '',
    addressLine: '',
    city: '',
    state: from.state,
    stateCode: from.stateCode,
    phone: '',
    email: from.email ?? '',
    /* Same-state branches file under the head office's registration, which is
       the common case; a different state forces a different GSTIN and the
       state-code check below is what catches it. */
    gstin: from.gstin,
    dlNos: [''],
    invoicePrefix: '',
    upiVpa: '',
  }
}

/**
 * Turn a filled-in form into the profile it produces, or refuse it.
 *
 * Pure, so the screen can run it on every keystroke and show the refusal before
 * the button is pressed rather than after. `siblings` is every branch that
 * already exists, which is what makes the prefix check possible at all.
 */
export function newBranchProfile(
  input: NewBranch,
  inheritFrom: StoreProfile,
  siblings: readonly StoreProfile[],
): StoreProfile {
  const name = input.name.trim()
  const prefix = input.invoicePrefix.trim().toUpperCase()
  const gstin = input.gstin.trim().toUpperCase()
  const stateCode = input.stateCode.trim()
  const dlNos = input.dlNos.map((d) => d.trim()).filter((d) => d !== '')
  const upiVpa = input.upiVpa.trim()

  if (name === '') {
    throw invalid('NAME_REQUIRED', 'The branch needs a name — it prints on every bill it issues', 'name')
  }
  if (siblings.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
    throw invalid(
      'NAME_TAKEN',
      `${name} is already a branch. Two branches with one name make the register, the day close and the transfer screen unreadable.`,
      'name',
    )
  }
  if (input.addressLine.trim() === '' || input.city.trim() === '') {
    throw invalid(
      'ADDRESS_REQUIRED',
      'A branch needs its own address — it is what prints at the head of that shop\'s bills',
      'addressLine',
    )
  }
  if (input.phone.trim() === '') {
    throw invalid('PHONE_REQUIRED', 'A branch needs a phone number on its bills', 'phone')
  }
  if (!/^\d{2}$/.test(stateCode)) {
    throw invalid('STATE_CODE_INVALID', 'The state code is two digits', 'stateCode')
  }
  if (!GSTIN.test(gstin)) {
    throw invalid(
      'GSTIN_INVALID',
      'That is not a 15-character GSTIN. It prints on every bill this branch issues.',
      'gstin',
    )
  }
  if (gstin.slice(0, 2) !== stateCode) {
    throw invalid(
      'GSTIN_STATE_MISMATCH',
      `The GSTIN begins with ${gstin.slice(0, 2)} but the state code is ${stateCode}. A branch in another state needs that state's own registration.`,
      'stateCode',
    )
  }
  if (dlNos.length === 0) {
    throw invalid(
      'DL_REQUIRED',
      'A drug licence is issued against premises, not against a company. This branch needs its own number — the head office\'s does not cover its counter.',
      'dlNos',
    )
  }
  if (!PREFIX.test(prefix)) {
    throw invalid(
      'PREFIX_INVALID',
      'A prefix is 1–6 characters, starting with a letter — it becomes part of every invoice number this branch issues',
      'invoicePrefix',
    )
  }
  const clash = siblings.find((s) => s.invoicePrefix.trim().toUpperCase() === prefix)
  if (clash) {
    throw invalid(
      'PREFIX_TAKEN',
      `${clash.name} already issues the ${prefix} series. Two branches on one prefix issue the same invoice number twice, in two shops, and nothing downstream can tell the bills apart.`,
      'invoicePrefix',
    )
  }
  if (upiVpa !== '' && !VPA.test(upiVpa)) {
    throw invalid(
      'VPA_INVALID',
      'A UPI ID looks like name@bank. This one goes into the QR on this branch\'s bills, so a wrong one takes the customer\'s money nowhere.',
      'upiVpa',
    )
  }

  return {
    ...inheritFrom,
    id: nextBranchId(siblings),
    name,
    tagline: input.tagline.trim() === '' ? null : input.tagline.trim(),
    addressLine: input.addressLine.trim(),
    city: input.city.trim(),
    state: input.state.trim() === '' ? inheritFrom.state : input.state.trim(),
    stateCode,
    phone: input.phone.trim(),
    email: input.email.trim() === '' ? null : input.email.trim(),
    gstin,
    dlNos,
    invoicePrefix: prefix,
    /* Empty means "no UPI", which is not the empty string: the receipt asks
       `if (store.upiVpa)` and a blank would print a QR pointing at nothing. */
    upiVpa: upiVpa === '' ? null : upiVpa,
  }
}

/**
 * Ids are allocated here rather than by the store, deliberately.
 *
 * `stores` is the one table keyed on an explicit id — every transactional row in
 * the schema carries `storeId` and the active branch is remembered in
 * localStorage by number — so a branch that reused an id would silently inherit
 * another shop's stock, bills and day close.
 */
export function nextBranchId(siblings: readonly StoreProfile[]): number {
  return siblings.reduce((max, s) => Math.max(max, s.id), 0) + 1
}

/**
 * What opening this branch will and will not carry across, said before it is
 * opened. None of these is a refusal; all of them are surprises otherwise.
 */
export function branchConsequences(input: NewBranch, inheritFrom: StoreProfile): string[] {
  const out: string[] = [
    'The medicine master is shared across the chain, so the new branch opens with the same catalogue and no stock. Move stock in with a transfer, or receive it against a purchase.',
  ]
  if (input.gstin.trim().toUpperCase() === inheritFrom.gstin.trim().toUpperCase()) {
    out.push(
      `This branch files under the same GSTIN as ${inheritFrom.name}. That is right for a second shop in the same state, and wrong for one in another state — a different state is a separate registration.`,
    )
  }
  if (input.upiVpa.trim() === '') {
    out.push('With no UPI ID, this branch\'s bills print without a payment QR. It can be added later.')
  }
  return out
}
