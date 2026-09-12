import type { ReportId } from '@contract'
import { isIsoDate, rangeOfPreset } from './periods'
import type { Range } from './periods'

/**
 * Saved report views.
 *
 * A report worth running once is worth running every month, and the work was
 * never the report — it is remembering that "supplier outstanding, this month,
 * indexed by supplier" was the combination that answered the question. Nobody
 * writes that down, so it gets re-derived from scratch or, more often, not asked
 * again.
 *
 * A saved view stores the ANSWERED QUESTION: the report, the period, the filter
 * and the index. Two properties are what make it trustworthy rather than a
 * bookmark:
 *
 *  - A ROLLING PERIOD IS STORED AS A PRESET, never as two dates. "This month"
 *    saved in September has to mean October in October; freezing the dates would
 *    turn every saved view into a historical snapshot within a month, which is
 *    the opposite of why it was saved. `preset === null` is the deliberate
 *    other case — a view pinned to a specific window, like a festival week.
 *
 *  - IT RE-RUNS THE REPORT. Nothing here caches a figure, so a saved view can
 *    never show a stale number, which is the failure that makes people stop
 *    trusting saved anything.
 *
 * It lives in this browser profile, and the screen says so: a counter machine's
 * own shortcuts, not the chain's. Sharing them needs a server, and pretending
 * otherwise would lose somebody's work the first time they opened the app
 * somewhere else.
 */

/* Versioned in the key itself. The shape stored here has already changed once,
   and a version suffix means the next change is a new key with an empty list
   rather than a parser that has to understand every shape this ever had. */
export const SAVED_VIEWS_KEY = 'rxbill.reports.saved-views.v1'

/**
 * Above this the list stops being scannable, and a shortcut nobody can find is
 * not a shortcut. The oldest SAVE is dropped rather than the oldest use: a view
 * is cheap to recreate and the alternative — tracking use — writes to storage on
 * every report anybody opens.
 */
export const MAX_SAVED_VIEWS = 20

export interface SavedView {
  id: string
  name: string
  reportId: ReportId
  /** A preset key for a rolling window; null for a view pinned to fixed dates. */
  preset: string | null
  /** The window as saved. Authoritative only when `preset` is null. */
  from: string
  to: string
  term: string
  facet: string
  groupBy: string
  savedAt: string
}

const collapse = (v: string): string => (v ?? '').trim().replace(/\s+/g, ' ')

/**
 * Ids are derived from the save time rather than random.
 *
 * `Math.random` in a module the report screen imports would make every test that
 * touches this file non-deterministic; the caller passes `Date.now()`, so a test
 * passes a fixed number and gets a fixed id.
 */
export function newViewId(now: number): string {
  return `v${now.toString(36)}`
}

/**
 * The window a saved view opens on.
 *
 * A rolling view re-resolves its preset against TODAY, so it moves with the
 * calendar. A pinned one returns exactly what was saved — and falls back to its
 * preset, then to the saved dates, rather than throwing: a stored blob whose
 * preset no longer exists must still open something.
 */
export function resolveRange(view: SavedView, today: Date): Range {
  if (view.preset !== null) {
    const rolled = rangeOfPreset(view.preset, today)
    if (rolled) return rolled
  }
  return { from: view.from, to: view.to }
}

/**
 * Add or replace, newest save first, capped.
 *
 * Replacing by id rather than appending is what makes renaming and re-saving the
 * same view idempotent — otherwise the list fills with near-duplicates that
 * differ only in a filter nobody can see from the name.
 */
export function upsertView(views: readonly SavedView[], view: SavedView): SavedView[] {
  const without = views.filter((v) => v.id !== view.id)
  return [view, ...without]
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_SAVED_VIEWS)
}

export function removeView(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id)
}

/**
 * Rename in place.
 *
 * An empty name leaves the view alone rather than blanking it: the rename field
 * submits on Enter, and a stray Enter on an empty box would otherwise erase the
 * only thing that identifies the view in the list.
 */
export function renameView(views: readonly SavedView[], id: string, name: string): SavedView[] {
  const trimmed = collapse(name)
  if (trimmed === '') return [...views]
  return views.map((v) => (v.id === id ? { ...v, name: trimmed.slice(0, 48) } : v))
}

// ------------------------------------------------------------- persistence ---

function isSavedView(v: unknown): v is SavedView {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r['id'] === 'string'
    && typeof r['name'] === 'string'
    && typeof r['reportId'] === 'string'
    && typeof r['savedAt'] === 'string'
    && (r['preset'] === null || typeof r['preset'] === 'string')
    // A pinned view with an unreadable window would open on nothing at all.
    && (r['preset'] !== null || (isIsoDate(String(r['from'])) && isIsoDate(String(r['to']))))
}

/**
 * Read what is stored, discarding anything that does not parse.
 *
 * A corrupt blob costs the shortcuts and nothing else — every one is
 * reconstructible from the screen in a few clicks — so failing loudly here would
 * take a working Reports page down for a list of conveniences. Rows are filtered
 * individually so one bad entry does not discard the other nineteen.
 */
export function loadSavedViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(SAVED_VIEWS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isSavedView)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, MAX_SAVED_VIEWS)
  } catch {
    return []
  }
}

export function storeSavedViews(views: readonly SavedView[]): void {
  try {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views.slice(0, MAX_SAVED_VIEWS)))
  } catch {
    // Private windows and blocked site data both throw. The views are already in
    // React state, so this session keeps working and only the next one forgets.
  }
}
