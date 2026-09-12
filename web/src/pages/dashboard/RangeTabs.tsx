import { DASHBOARD_RANGES } from '@contract'
import type { DashboardRange } from '@contract'
import { cn } from '@/lib/cn'

/**
 * The window every number on this screen is read over.
 *
 * It lives in the URL, so "the last 30 days looked like this" is a link a manager
 * can send rather than a screen they have to describe. Four presets, not a date
 * picker: a free range is a report, and Reports prints the basis it used.
 */
export const RANGE_LABEL: Record<DashboardRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  month: 'This month',
}

/** The LABEL form, for a card title: "Sales mix · the last 30 days". */
export const RANGE_PHRASE: Record<DashboardRange, string> = {
  today: 'today',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  month: 'this month so far',
}

/** The SENTENCE form, which needs its preposition: "trading over the last 30 days". */
export const RANGE_SENTENCE: Record<DashboardRange, string> = {
  today: 'today',
  '7d': 'over the last 7 days',
  '30d': 'over the last 30 days',
  month: 'this month so far',
}

/**
 * The short form of a comparison phrase, for a stat tile.
 *
 * A tile is ~200px wide and six of them sit across the row; "vs previous 30
 * days" truncates in every one, and a truncated comparison is worse than a terse
 * one — the reader cannot tell WHAT it was measured against. Derived from the
 * long phrase rather than mapped from the range, so the two can never disagree.
 * The full wording is stated once above the row and again on the hero.
 */
export function shortenComparison(comparedTo: string): string {
  return comparedTo.replace('previous ', 'prev ').replace(/ days$/, 'd')
}

export function isDashboardRange(v: string | null): v is DashboardRange {
  return v !== null && (DASHBOARD_RANGES as readonly string[]).includes(v)
}

export function RangeTabs({
  value,
  onChange,
}: {
  value: DashboardRange
  onChange: (next: DashboardRange) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Date range"
      className="flex rounded-[var(--radius-md)] border border-border bg-surface p-0.5 shadow-xs"
    >
      {DASHBOARD_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={value === r}
          onClick={() => onChange(r)}
          className={cn(
            'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm whitespace-nowrap',
            'transition-colors duration-[var(--dur-fast)]',
            value === r ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover hover:text-fg',
          )}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  )
}
