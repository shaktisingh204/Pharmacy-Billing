import type { StoreProfile } from '@contract'

/**
 * Is this shop actually ready to bill?
 *
 * Settings screens fail in a particular way: everything on them is optional, so
 * nothing on them gets done. The fields that decide whether a bill is a LEGAL
 * bill — the GSTIN, the drug licence numbers, the address, the phone — sit in
 * the same grey rows as the ones that decide whether the footer says thank you,
 * and the first time anybody discovers which is which is when an inspector asks
 * or a customer's UPI payment lands in nobody's account.
 *
 * So this screen answers one question at the top before it offers anything to
 * edit: what is still missing, and where. Every check below is a thing a real
 * Indian retail pharmacy is either required to print or will lose money without.
 *
 * Pure, and keyed by section, so the header can both count them and jump to the
 * panel that fixes one.
 */

export type SectionKey =
  | 'store' | 'branches' | 'branding' | 'invoice' | 'pricing' | 'printing' | 'payments' | 'data'

export interface ReadinessCheck {
  id: string
  section: SectionKey
  /** Two or three words, for the chip. */
  label: string
  ready: boolean
  /** One line: what it is for when it is done, what is missing when it is not. */
  detail: string
}

/** A backup older than this is treated as no backup. A week of bills is a week. */
export const BACKUP_STALE_DAYS = 7

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/
const VPA = /^[\w.\-]{2,64}@[A-Za-z]{2,32}$/

const blank = (v: string | null | undefined): boolean => (v ?? '').trim() === ''

export interface ReadinessInput {
  store: StoreProfile
  /** A roll width has been chosen ON THIS MACHINE. Printing is per device. */
  printerConfigured: boolean
  /** ISO stamp of the last export, or null if this machine has never made one. */
  lastBackupAt: string | null
  now: Date
}

export function daysSince(iso: string | null, now: Date): number | null {
  if (iso === null || iso.trim() === '') return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return Math.floor((now.getTime() - at.getTime()) / 86_400_000)
}

export function readiness({ store, printerConfigured, lastBackupAt, now }: ReadinessInput): ReadinessCheck[] {
  const gstin = store.gstin.trim().toUpperCase()
  const gstinValid = GSTIN.test(gstin)
  const stateAgrees = gstinValid && gstin.slice(0, 2) === store.stateCode.trim()
  const licences = store.dlNos.filter((d) => d.trim() !== '')
  const backupAge = daysSince(lastBackupAt, now)

  return [
    {
      id: 'address',
      section: 'store',
      label: 'Shop address',
      ready: !blank(store.name) && !blank(store.addressLine) && !blank(store.city),
      detail: blank(store.addressLine) || blank(store.city)
        ? 'A retail bill has to carry the premises it was issued from.'
        : `${store.addressLine}, ${store.city}`,
    },
    {
      id: 'phone',
      section: 'store',
      label: 'Phone number',
      ready: !blank(store.phone),
      detail: blank(store.phone)
        ? 'Printed on every bill — it is how a customer reaches the shop about a strip they were dispensed.'
        : store.phone,
    },
    {
      id: 'gstin',
      section: 'store',
      label: 'GSTIN',
      ready: gstinValid && stateAgrees,
      detail: !gstinValid
        ? 'Required on every retail bill, and what a return is filed against.'
        : !stateAgrees
          ? `The GSTIN begins ${gstin.slice(0, 2)} but the state code is ${store.stateCode} — bills would be taxed against one state and filed against the other.`
          : gstin,
    },
    {
      id: 'licence',
      section: 'store',
      label: 'Drug licence',
      ready: licences.length > 0,
      detail: licences.length === 0
        ? 'A retail drug bill without a licence number is not a compliant bill.'
        : licences.join(' · '),
    },
    {
      id: 'series',
      section: 'invoice',
      label: 'Invoice series',
      ready: !blank(store.invoicePrefix),
      detail: blank(store.invoicePrefix)
        ? 'Every document number starts with it.'
        : `${store.invoicePrefix} · financial year starts in month ${store.financialYearStartMonth}`,
    },
    {
      id: 'upi',
      section: 'payments',
      label: 'UPI QR',
      ready: !blank(store.upiVpa) && VPA.test((store.upiVpa ?? '').trim()),
      detail: blank(store.upiVpa)
        ? 'Without one, every bill prints without a payment QR and the counter takes UPI by reading a number out loud.'
        : VPA.test((store.upiVpa ?? '').trim())
          ? (store.upiVpa ?? '')
          : 'That UPI ID is not a VPA — the QR on every bill would take the money nowhere.',
    },
    {
      id: 'footer',
      section: 'payments',
      label: 'Receipt footer',
      ready: !blank(store.footerNote),
      detail: blank(store.footerNote)
        ? 'The return policy and the storage line most shops print at the foot of a bill.'
        : store.footerNote.trim(),
    },
    {
      id: 'printer',
      section: 'printing',
      label: 'Thermal printer',
      ready: printerConfigured,
      detail: printerConfigured
        ? 'A roll width has been set on this machine.'
        : 'Bills go through the browser print dialog until a roll width is picked — one dialog per bill, two hundred times a day.',
    },
    {
      id: 'backup',
      section: 'data',
      label: 'Recent backup',
      ready: backupAge !== null && backupAge <= BACKUP_STALE_DAYS,
      detail: backupAge === null
        ? 'Everything is on this machine only. A cleared browser profile takes the whole shop with it.'
        : backupAge <= BACKUP_STALE_DAYS
          ? backupAge === 0 ? 'Taken today.' : `Taken ${backupAge} day${backupAge === 1 ? '' : 's'} ago.`
          : `The last backup is ${backupAge} days old, so ${backupAge} days of bills exist nowhere else.`,
    },
  ]
}

export function outstanding(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((c) => !c.ready)
}

export function readyCount(checks: readonly ReadinessCheck[]): number {
  return checks.filter((c) => c.ready).length
}

/** How many things are still open in one panel — the dot on the section list. */
export function openInSection(checks: readonly ReadinessCheck[], section: SectionKey): number {
  return checks.filter((c) => !c.ready && c.section === section).length
}
