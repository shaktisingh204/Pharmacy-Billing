import { useSyncExternalStore } from 'react'
import type { IsoDate } from '@contract'
import { toIsoDate } from './profile'

/**
 * The care file: what the counter needs to know about a person, and what the
 * contract has no field for.
 *
 * `Customer` carries allergies and nothing else clinical, and there is no
 * `updateCustomer` in the API — so chronic conditions, a date of birth and a
 * counter note are kept HERE, on this device, and the screen says so in as many
 * words wherever it shows them. That is a real limitation stated plainly rather
 * than a second source of truth pretending to be the master.
 *
 * ALLERGIES ARE DELIBERATELY NOT IN THIS FILE. They are the one dispensing
 * control on this screen, they live on the customer master, and splitting them
 * across two stores — one of which does not travel to the second till — is how a
 * pharmacist ends up reading a record that is missing the allergy the other
 * terminal knows about. A note kept on one machine is acceptable for "takes
 * metformin"; it is not acceptable for "penicillin will hurt them".
 *
 * The same localStorage-per-device pattern the printing and label preferences
 * already use, with the same failure rule: storage that will not read or write
 * degrades to an empty file rather than taking the screen down.
 */

const STORAGE_KEY = 'rxbill.customers.care'
const VERSION = 1

export interface CareFile {
  /** Chronic conditions, as words. Free text; the suggestions are a shortcut. */
  conditions: string[]
  /** Full date of birth: the age is as useful at the counter as the birthday. */
  dob: IsoDate | null
  /** Anything the next person on the till needs to know. */
  note: string | null
  updatedAt: string
}

export type CareBook = Readonly<Record<string, CareFile>>

export const EMPTY_CARE: CareFile = { conditions: [], dob: null, note: null, updatedAt: '' }

const EMPTY_BOOK: CareBook = {}

/**
 * The conditions an Indian retail pharmacy actually repeats all day.
 *
 * A shortcut, never a closed list — the free-text box is the primary input and
 * these only save typing on the eleven that come up constantly.
 */
export const CONDITION_SUGGESTIONS: readonly string[] = [
  'Diabetes',
  'Hypertension',
  'Thyroid',
  'Cardiac',
  'Asthma / COPD',
  'Cholesterol',
  'Arthritis',
  'Epilepsy',
  'Kidney (CKD)',
  'Liver',
  'Pregnancy',
]

const MAX_CONDITIONS = 12
const MAX_CONDITION_LEN = 40
const MAX_NOTE_LEN = 400

// ------------------------------------------------------------- the store ---

let cache: CareBook | null = null
const listeners = new Set<() => void>()

function parse(raw: string | null): CareBook {
  if (!raw) return EMPTY_BOOK
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return EMPTY_BOOK
    const book = (data as { byCustomer?: unknown }).byCustomer
    if (typeof book !== 'object' || book === null) return EMPTY_BOOK

    const out: Record<string, CareFile> = {}
    for (const [id, value] of Object.entries(book as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const src = value as Record<string, unknown>
      const conditions = Array.isArray(src['conditions'])
        ? src['conditions'].filter((c): c is string => typeof c === 'string')
        : []
      const dob = typeof src['dob'] === 'string' && isDob(src['dob']) ? src['dob'] : null
      const note = typeof src['note'] === 'string' && src['note'].trim() ? src['note'] : null
      if (conditions.length === 0 && dob === null && note === null) continue
      out[id] = {
        conditions,
        dob,
        note,
        updatedAt: typeof src['updatedAt'] === 'string' ? src['updatedAt'] : '',
      }
    }
    return out
  } catch {
    // A corrupt blob must not take the screen down with it. Everything clinical
    // that matters is on the customer master and stays readable.
    return EMPTY_BOOK
  }
}

export function readCareBook(): CareBook {
  if (cache) return cache
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }
  cache = parse(raw)
  return cache
}

function commit(next: CareBook): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, byCustomer: next }))
  } catch {
    // Quota or a locked-down browser. The edit still stands for this session,
    // which is better than dropping what the pharmacist just typed.
  }
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  /* A second tab is a second till on the same machine. Dropping its write means
     one screen showing conditions the other has already removed. */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return
    cache = null
    onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Re-renders on every write, including one made by another tab. */
export function useCareBook(): CareBook {
  return useSyncExternalStore(subscribe, readCareBook, () => EMPTY_BOOK)
}

export function careOf(book: CareBook, customerId: number): CareFile {
  return book[String(customerId)] ?? EMPTY_CARE
}

export function hasCare(file: CareFile): boolean {
  return file.conditions.length > 0 || file.dob !== null || file.note !== null
}

// -------------------------------------------------------------- the edits ---

/** Deduplicated case-insensitively: "Thyroid" and "thyroid" are one condition. */
function normaliseConditions(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of raw) {
    const text = value.trim().replace(/\s+/g, ' ').slice(0, MAX_CONDITION_LEN)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_CONDITIONS) break
  }
  return out
}

const DOB_RE = /^\d{4}-\d{2}-\d{2}$/

/** A date of birth is a past date within a human lifetime. Anything else is a
 *  typo, and a typo silently accepted becomes a birthday reminder in 1907. */
export function isDob(value: string, today: Date = new Date()): boolean {
  if (!DOB_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return false
  // Round-tripped, so 2026-02-31 is rejected instead of rolling into March.
  if (toIsoDate(d) !== value) return false
  if (d.getTime() > today.getTime()) return false
  return today.getFullYear() - d.getFullYear() <= 120
}

export function writeCare(customerId: number, patch: Partial<CareFile>, now = new Date()): void {
  const book = readCareBook()
  const key = String(customerId)
  const current = book[key] ?? EMPTY_CARE

  const conditions = patch.conditions ? normaliseConditions(patch.conditions) : current.conditions
  const dob = patch.dob === undefined
    ? current.dob
    : patch.dob && isDob(patch.dob, now) ? patch.dob : null
  const noteRaw = patch.note === undefined ? current.note : patch.note
  const note = noteRaw ? noteRaw.trim().slice(0, MAX_NOTE_LEN) || null : null

  const next: Record<string, CareFile> = { ...book }
  if (conditions.length === 0 && dob === null && note === null) delete next[key]
  else next[key] = { conditions, dob, note, updatedAt: now.toISOString() }
  commit(next)
}

export function clearCare(customerId: number): void {
  const next: Record<string, CareFile> = { ...readCareBook() }
  delete next[String(customerId)]
  commit(next)
}

// ------------------------------------------------------------ birthdays ---

export function ageOn(dob: IsoDate | null, today: Date): number | null {
  if (!dob || !isDob(dob, today)) return null
  const d = new Date(`${dob}T00:00:00`)
  let age = today.getFullYear() - d.getFullYear()
  const before = today.getMonth() < d.getMonth()
    || (today.getMonth() === d.getMonth() && today.getDate() < d.getDate())
  if (before) age -= 1
  return age
}

export interface Birthday {
  on: IsoDate
  /** 0 is today. */
  inDays: number
  turning: number
}

/**
 * The next one, counted from today.
 *
 * A 29 February birth date rolls to 1 March in a common year, which is what the
 * platform's Date does and what most Indian records assume anyway. It is
 * stated here rather than special-cased into a silent 28 February.
 */
export function nextBirthday(dob: IsoDate | null, today: Date): Birthday | null {
  if (!dob || !isDob(dob, today)) return null
  const born = new Date(`${dob}T00:00:00`)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  let on = new Date(base.getFullYear(), born.getMonth(), born.getDate())
  if (on.getTime() < base.getTime()) {
    on = new Date(base.getFullYear() + 1, born.getMonth(), born.getDate())
  }
  const inDays = Math.round((on.getTime() - base.getTime()) / 86_400_000)
  return { on: toIsoDate(on), inDays, turning: on.getFullYear() - born.getFullYear() }
}

export interface BirthdayDue {
  customerId: number
  name: string
  phone: string
  birthday: Birthday
}

export function birthdaysDue(
  customers: ReadonlyArray<{ id: number; name: string; phone: string }>,
  book: CareBook,
  today: Date,
  aheadDays: number,
): BirthdayDue[] {
  const out: BirthdayDue[] = []
  for (const c of customers) {
    const birthday = nextBirthday(careOf(book, c.id).dob, today)
    if (!birthday || birthday.inDays > aheadDays) continue
    out.push({ customerId: c.id, name: c.name, phone: c.phone, birthday })
  }
  return out.sort((a, b) => a.birthday.inDays - b.birthday.inDays || a.name.localeCompare(b.name))
}
