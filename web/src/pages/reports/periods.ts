import type { IsoDate } from '@contract'

/**
 * Periods, as values.
 *
 * A report screen has three things that all have to agree about what "this
 * month" means: the preset buttons, a saved view that was stored as a rolling
 * period, and the comparison range. Deriving each of them separately is how a
 * saved "last month" opens on a range the preset row does not light up, so the
 * arithmetic lives here once and nothing else computes a date.
 *
 * Everything is a pure function of an ISO string plus an injected `today`.
 * Nothing here reads the clock: a module that did would disagree with itself at
 * midnight, and the range in the URL would stop matching the range on screen.
 */

const MS_PER_DAY = 86_400_000

const pad2 = (n: number): string => String(n).padStart(2, '0')

export const iso = (d: Date): IsoDate => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** Fixed, not locale-derived. The same range has to read identically on the
 *  counter machine and on the owner's laptop. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (v: string): boolean => ISO_RE.test(v)

/** UTC throughout, so a shift across a DST boundary cannot lose or gain a day. */
const utc = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`)

const fromUtc = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10)

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtc(utc(date) + days * MS_PER_DAY)
}

/** Inclusive, so a single day is one day and not zero. */
export function dayCount(from: IsoDate, to: IsoDate): number {
  const days = Math.round((utc(to) - utc(from)) / MS_PER_DAY) + 1
  return Number.isFinite(days) && days > 0 ? days : 1
}

export interface Range {
  from: IsoDate
  to: IsoDate
}

export interface Preset {
  key: string
  label: string
  range: (today: Date) => Range
}

export const PRESETS: Preset[] = [
  { key: 'today', label: 'Today', range: (t) => ({ from: iso(t), to: iso(t) }) },
  {
    key: 'week',
    label: '7 days',
    range: (t) => ({ from: iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6)), to: iso(t) }),
  },
  {
    key: 'month',
    label: 'This month',
    range: (t) => ({ from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) }),
  },
  {
    key: 'lastMonth',
    label: 'Last month',
    range: (t) => ({
      from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
      to: iso(new Date(t.getFullYear(), t.getMonth(), 0)),
    }),
  },
  {
    key: 'quarter',
    label: '90 days',
    range: (t) => ({ from: iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 89)), to: iso(t) }),
  },
]

/** The default window: month-to-date is where both the daily question and the
 *  monthly filing land, and a wrong default that truncates a filing costs a
 *  return rather than a click. */
export function defaultRange(today: Date): Range {
  return PRESETS[2]?.range(today) ?? { from: iso(today), to: iso(today) }
}

export function rangeOfPreset(key: string, today: Date): Range | null {
  return PRESETS.find((p) => p.key === key)?.range(today) ?? null
}

/** Which preset, if any, produced this range today. Used to light a button and
 *  to store a saved view as ROLLING rather than pinned. */
export function presetKeyFor(range: Range, today: Date): string | null {
  const hit = PRESETS.find((p) => {
    const r = p.range(today)
    return r.from === range.from && r.to === range.to
  })
  return hit?.key ?? null
}

/**
 * The period immediately before this one, of exactly the same length.
 *
 * Equal length is the whole point: comparing a 30-day month against a 31-day one
 * hands back a 3% "decline" that is a calendar artefact. Aligning to calendar
 * months instead would have the opposite problem — a month-to-date compared
 * against a whole month is a comparison nobody can read. So this is always N
 * days against the N days that came before them, and the screen prints both
 * ranges rather than asking to be trusted.
 */
export function previousRange(range: Range): Range {
  const days = dayCount(range.from, range.to)
  const to = addDays(range.from, -1)
  return { from: addDays(to, -(days - 1)), to }
}

/** '1–8 Sep 2026', '28 Aug – 8 Sep 2026', '8 Sep 2026'. */
export function describeRange(range: Range): string {
  if (!isIsoDate(range.from) || !isIsoDate(range.to)) return `${range.from} – ${range.to}`
  const [fy, fm, fd] = range.from.split('-') as [string, string, string]
  const [ty, tm, td] = range.to.split('-') as [string, string, string]
  const fMon = MONTHS[Number(fm) - 1] ?? fm
  const tMon = MONTHS[Number(tm) - 1] ?? tm
  const day = (v: string): string => String(Number(v))

  if (range.from === range.to) return `${day(fd)} ${fMon} ${fy}`
  if (fy === ty && fm === tm) return `${day(fd)}–${day(td)} ${tMon} ${ty}`
  if (fy === ty) return `${day(fd)} ${fMon} – ${day(td)} ${tMon} ${ty}`
  return `${day(fd)} ${fMon} ${fy} – ${day(td)} ${tMon} ${ty}`
}
