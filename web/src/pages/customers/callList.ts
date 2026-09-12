import type { IsoDate } from '@contract'
import { csvCell } from '@/pages/reports/exportCsv'
import type { BirthdayDue } from './careFile'
import type { RefillDue } from './profile'

/**
 * The reminders, as something an owner can act on away from the screen.
 *
 * A list that can only be read on a till is a list that gets read once. What a
 * shop actually does with this is phone people, so it leaves in the two shapes
 * that survive the trip: a plain-text block to paste into WhatsApp, and a CSV
 * for anybody who would rather work down a spreadsheet.
 *
 * A REASON TRAVELS WITH EVERY NAME. "Ring Ramesh" is not actionable; "Ramesh,
 * Metformin 500, four days late, he refills every 30" is. The person making the
 * call is usually not the person who read the screen.
 */

export interface CallRow {
  name: string
  phone: string
  reason: string
  on: IsoDate
  /** Negative is overdue; a birthday is never negative. */
  inDays: number
  kind: 'refill' | 'birthday'
}

/** "4 days late", "today", "in 6 days" — the words, never a bare number. */
export function whenWords(inDays: number): string {
  if (inDays < 0) return `${Math.abs(inDays)} day${inDays === -1 ? '' : 's'} late`
  if (inDays === 0) return 'today'
  return `in ${inDays} day${inDays === 1 ? '' : 's'}`
}

export function toCallRows(refills: readonly RefillDue[], birthdays: readonly BirthdayDue[]): CallRow[] {
  const rows: CallRow[] = refills.map((r) => ({
    name: r.name,
    phone: r.phone,
    reason: r.item.cycle
      ? `${r.item.brandName} refill — every ${r.item.cycle.days} days, last collected ${r.item.lastBought}`
      : `${r.item.brandName} refill`,
    on: r.dueOn,
    inDays: r.dueInDays,
    kind: 'refill',
  }))
  for (const b of birthdays) {
    rows.push({
      name: b.name,
      phone: b.phone,
      reason: `Birthday — turning ${b.birthday.turning}`,
      on: b.birthday.on,
      inDays: b.birthday.inDays,
      kind: 'birthday',
    })
  }
  // Overdue first, then soonest. Whoever works this list works it top-down.
  return rows.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name))
}

/** For a phone in one hand. One line per call, no header, nothing to decode. */
export function callListText(rows: readonly CallRow[], today: IsoDate): string {
  if (rows.length === 0) return `No customer reminders as at ${today}.`
  const lines = [`Customer reminders as at ${today}`, '']
  for (const r of rows) {
    lines.push(`${r.name} · ${r.phone || 'no phone'} — ${r.reason} · ${whenWords(r.inDays)}`)
  }
  return lines.join('\n')
}

const BOM = '﻿'
const CRLF = '\r\n'

export function callListCsv(rows: readonly CallRow[], today: IsoDate): string {
  const out = [
    [csvCell('Customer reminders', 'text'), csvCell(`as at ${today}`, 'text')].join(','),
    [csvCell('Rows', 'text'), csvCell(String(rows.length), 'text')].join(','),
    '',
    ['Customer', 'Phone', 'Reminder', 'Reason', 'Due on', 'When'].map((h) => csvCell(h, 'text')).join(','),
  ]
  for (const r of rows) {
    out.push([
      csvCell(r.name, 'text'),
      // A phone number is a code, not a quantity: without the text guard a
      // leading zero is eaten and a ten-digit number goes scientific.
      csvCell(r.phone || null, 'code'),
      csvCell(r.kind === 'refill' ? 'Refill' : 'Birthday', 'text'),
      csvCell(r.reason, 'text'),
      csvCell(r.on, 'text'),
      csvCell(whenWords(r.inDays), 'text'),
    ].join(','))
  }
  return BOM + out.join(CRLF) + CRLF
}

export function downloadCallList(rows: readonly CallRow[], today: IsoDate): void {
  const blob = new Blob([callListCsv(rows, today)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `customer-reminders-${today}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
