import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  ArrowRight, Ban, BadgeCheck, Banknote, CalendarClock, IndianRupee, ListFilter, PackageMinus,
  Scale, Search, ShieldCheck, Tag, UserRound, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditAction, AuditEntry, AuditFilters, User } from '@contract'
import { ApiError, AUDIT_ACTIONS } from '@contract'
import { useApi } from '@/api'
import {
  AUDIT_ACTION_SPEC, OVERRIDE_REASON_LABEL, ROLE_LABEL, ROLE_SHORT, auditLabel, can, localDay,
} from '@/api/users'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'

/**
 * Who did what, when, and what it looked like before.
 *
 * A trail is only worth keeping if it answers the questions an owner actually
 * asks out loud, and there are three of them:
 *
 *   "WHO VOIDED THIS BILL." Filter by action. The void is the oldest theft at a
 *   till — take the cash, cancel the bill, the goods have already walked — so
 *   it gets its own button rather than living six items down a dropdown.
 *   "WHO CHANGED THIS PRICE." Filter by action, and read the BEFORE. An entry
 *   that says "rate edited" and not "48.00 → 44.00" answers nothing.
 *   "WHO WAS ON THE COUNTER WHEN THE DRAWER WAS SHORT." Filter by actor and by
 *   day, which is why both are first-class controls and not a search box.
 *
 * The filter is in the URL, so each of those is a link somebody can paste into
 * a message rather than a set of instructions for reproducing a view.
 *
 * The whole thing is gated on `reports.audit`. A log everybody can read is a
 * log that gets edited by consensus; this one is for the people who answer for
 * the shop.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })

/** How far back the log is read in one go. A fortnight of a busy shop. */
const WINDOW = 400

const COLS = 'grid-cols-[56px_minmax(110px,1.1fr)_minmax(112px,1fr)_minmax(170px,2.4fr)_96px]'

interface Preset {
  id: string
  label: string
  icon: LucideIcon
  tone?: string
  patch: Partial<UrlFilters>
}

interface UrlFilters {
  actorId: string
  action: string
  from: string
  to: string
  term: string
  overridesOnly: boolean
}

const BLANK: UrlFilters = { actorId: '', action: '', from: '', to: '', term: '', overridesOnly: false }

const PRESETS: Preset[] = [
  { id: 'all', label: 'Everything', icon: ListFilter, patch: BLANK },
  { id: 'voids', label: 'Voided bills', icon: Ban, tone: 'var(--danger-11)', patch: { ...BLANK, action: 'SALE_VOIDED' } },
  { id: 'rates', label: 'Price changes', icon: Tag, tone: 'var(--status-expiry-60)', patch: { ...BLANK, action: 'RATE_EDITED' } },
  { id: 'overrides', label: 'Needed a signature', icon: ShieldCheck, tone: 'var(--warning-11)', patch: { ...BLANK, overridesOnly: true } },
  { id: 'writeoffs', label: 'Stock written off', icon: PackageMinus, tone: 'var(--status-low-stock)', patch: { ...BLANK, action: 'STOCK_ADJUSTED' } },
  { id: 'drawer', label: 'Drawer counts', icon: Banknote, patch: { ...BLANK, action: 'CASH_COUNTED' } },
]

const ACTION_ICON: Partial<Record<AuditAction, LucideIcon>> = {
  SALE_VOIDED: Ban,
  RATE_EDITED: Tag,
  REFUND_ISSUED: IndianRupee,
  DOCUMENT_BACKDATED: CalendarClock,
  STOCK_ADJUSTED: PackageMinus,
  CASH_COUNTED: Banknote,
  CREDIT_LIMIT_CHANGED: Scale,
}

function isoToday(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${String(now.getDate()).padStart(2, '0')}`
}

function readFilters(p: URLSearchParams): UrlFilters {
  const action = p.get('act') ?? ''
  return {
    actorId: /^\d+$/.test(p.get('who') ?? '') ? (p.get('who') ?? '') : '',
    action: AUDIT_ACTIONS.some((a) => a === action) ? action : '',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    term: p.get('q') ?? '',
    overridesOnly: p.get('ov') === '1',
  }
}

function isFiltered(f: UrlFilters): boolean {
  return f.actorId !== '' || f.action !== '' || f.from !== '' || f.to !== ''
    || f.term.trim() !== '' || f.overridesOnly
}

/** Only what the adapter can act on. Blank axes are absent, not empty strings. */
function toQuery(f: UrlFilters): AuditFilters {
  return {
    ...(f.actorId ? { actorId: Number(f.actorId) } : {}),
    ...(f.action ? { action: f.action as AuditAction } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(f.term.trim() ? { term: f.term.trim() } : {}),
    ...(f.overridesOnly ? { onlyOverrides: true } : {}),
    limit: WINDOW,
  }
}

const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

// ----------------------------------------------------------------- the log ---

export function AuditLog({
  users,
  viewer,
  online,
}: {
  users: readonly User[]
  /** Who is reading. The log is gated on their `reports.audit`. */
  viewer: User | null
  online: boolean
}) {
  const api = useApi()
  const [params, setParams] = useSearchParams()
  const listRef = useRef<HTMLDivElement>(null)
  const today = useMemo(() => isoToday(new Date()), [])

  const filters = useMemo(() => readFilters(params), [params])
  const selectedParam = params.get('e')
  const selectedId = selectedParam !== null && /^\d+$/.test(selectedParam) ? Number(selectedParam) : null

  /* Written into the SHARED query string, so the tab and the selected user
     survive a filter change. Only non-default axes are written, and a term-only
     change replaces rather than pushes: one typed word must not leave twenty
     stops in the history. */
  const patch = useCallback(
    (next: Partial<UrlFilters>, opts?: { keepSelection?: boolean }) => {
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams((prev) => {
        const merged = { ...readFilters(prev), ...next }
        const out = new URLSearchParams(prev)
        const put = (key: string, value: string) => {
          if (value) out.set(key, value)
          else out.delete(key)
        }
        put('who', merged.actorId)
        put('act', merged.action)
        put('from', merged.from)
        put('to', merged.to)
        put('q', merged.term.trim())
        put('ov', merged.overridesOnly ? '1' : '')
        // A row that is no longer in the list must not stay open behind it.
        if (!opts?.keepSelection) out.delete('e')
        return out
      }, { replace: termOnly })
    },
    [setParams],
  )

  const select = useCallback(
    (id: number | null) => {
      setParams((prev) => {
        const out = new URLSearchParams(prev)
        if (id === null) out.delete('e')
        else out.set('e', String(id))
        return out
      }, { replace: true })
    },
    [setParams],
  )

  const mayRead = viewer !== null && can(viewer, 'reports.audit')

  const log = useQuery({
    queryKey: ['audit', toQuery(filters)],
    queryFn: () => api.listAudit(toQuery(filters)),
    enabled: mayRead,
    /* The list survives a filter change so the rows do not blink back to a
       skeleton every time a preset is pressed. */
    placeholderData: keepPreviousData,
  })

  const rows = log.data?.rows ?? EMPTY_ROWS
  const selected = useMemo(
    () => (selectedId === null ? null : rows.find((r) => r.id === selectedId) ?? null),
    [rows, selectedId],
  )

  const error = log.error
  const denied = !mayRead || (error instanceof ApiError && DENIED_CODES.has(error.code))
  const status: 'ready' | 'loading' | 'error' | 'offline' | 'denied' = denied
    ? 'denied'
    : !online && !log.data
      ? 'offline'
      : error
        ? 'error'
        : log.isPending
          ? 'loading'
          : 'ready'

  const activePreset = PRESETS.find((p) => matchesPreset(filters, p))?.id
    ?? (isFiltered(filters) ? null : 'all')

  const overrideCount = rows.filter((r) => r.override !== null).length

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ gap: 'var(--card-gap)' }}>
      <Filters
        value={filters}
        users={users}
        today={today}
        activePreset={activePreset}
        onPatch={patch}
      />

      <div className="flex min-h-0 flex-1" style={{ gap: 'var(--card-gap)' }}>
        <div data-density="compact" className="card flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className={cn('grid shrink-0 items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5', COLS)}>
            <span className="micro-label">Time</span>
            <span className="micro-label">Who</span>
            <span className="micro-label">Did what</span>
            <span className="micro-label">To what</span>
            <span className="micro-label text-right">Amount ₹</span>
          </div>

          <div
            ref={listRef}
            className="scroll-region min-h-0 flex-1"
            onKeyDown={(e) => {
              if (e.ctrlKey || e.altKey || e.metaKey) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                moveFocus(listRef.current, e.key === 'ArrowDown' ? 1 : -1)
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                if (selectedId !== null) select(null)
                else if (isFiltered(filters)) patch(BLANK)
              }
            }}
          >
            {status === 'loading' ? (
              <SkeletonRows rows={12} cols={5} />
            ) : status === 'denied' ? (
              <PermissionDenied needs="reports.audit" />
            ) : status === 'offline' ? (
              <OfflineState />
            ) : status === 'error' ? (
              <ErrorState
                code={error instanceof ApiError ? error.code : 'AUDIT_FAILED'}
                message={error ? (error as Error).message : undefined}
                onRetry={() => void log.refetch()}
              />
            ) : rows.length === 0 ? (
              isFiltered(filters) ? (
                <EmptyState
                  icon={Search}
                  title="Nothing matches"
                  body="No entry in the loaded window fits this filter. Widen the dates, or clear it and start from the whole log."
                  actionLabel="Clear filters"
                  onAction={() => patch(BLANK)}
                />
              ) : (
                <EmptyState
                  icon={ShieldCheck}
                  title="Nothing recorded yet"
                  body="The trail fills itself as bills are posted, prices move and stock is adjusted. Nothing to answer for yet."
                />
              )
            ) : (
              <Rows rows={rows} today={today} selectedId={selectedId} onOpen={select} />
            )}
          </div>

          {status === 'ready' && rows.length > 0 ? (
            <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-subtle">
              <span>
                {log.data?.total ?? rows.length} entr{(log.data?.total ?? rows.length) === 1 ? 'y' : 'ies'}
                {log.data?.nextCursor !== null && log.data !== undefined
                  ? ` · showing the newest ${rows.length}`
                  : ''}
                {overrideCount > 0 ? ` · ${overrideCount} needed a signature` : ''}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>Esc</Kbd> back
              </span>
            </footer>
          ) : null}
        </div>

        {selected ? (
          <EntryDetail
            key={selected.id}
            entry={selected}
            onClose={() => {
              const id = selected.id
              select(null)
              listRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${id}"]`)?.focus()
            }}
            onFilterActor={() => patch({ ...BLANK, actorId: String(selected.actorId) })}
            onFilterAction={() => patch({ ...BLANK, action: selected.action })}
          />
        ) : null}
      </div>
    </div>
  )
}

const EMPTY_ROWS: readonly AuditEntry[] = []

function matchesPreset(f: UrlFilters, p: Preset): boolean {
  const want = { ...BLANK, ...p.patch }
  return f.actorId === want.actorId && f.action === want.action && f.from === want.from
    && f.to === want.to && f.term === want.term && f.overridesOnly === want.overridesOnly
}

// ---------------------------------------------------------------- filtering ---

function Filters({
  value,
  users,
  today,
  activePreset,
  onPatch,
}: {
  value: UrlFilters
  users: readonly User[]
  today: string
  activePreset: string | null
  onPatch: (next: Partial<UrlFilters>) => void
}) {
  /* The box is local and the URL is written behind it. A search param per
     keystroke gives the back button twenty stops inside one word. */
  const [box, setBox] = useState(value.term)
  const [lastTerm, setLastTerm] = useState(value.term)
  if (value.term !== lastTerm) {
    setLastTerm(value.term)
    setBox(value.term)
  }

  const commit = () => { if (box !== value.term) onPatch({ term: box }) }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-[260px]">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          value={box}
          onChange={(e) => setBox(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape' && box) { e.stopPropagation(); setBox(''); onPatch({ term: '' }) }
          }}
          aria-label="Search the trail"
          placeholder="Bill number, batch, a value…"
          autoComplete="off"
          spellCheck={false}
          className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-8 pr-8 text-base placeholder:text-fg-subtle hover:border-border-strong"
        />
        {box ? (
          <button
            type="button"
            onClick={() => { setBox(''); onPatch({ term: '' }) }}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = activePreset === p.id
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPatch(p.patch)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm',
                on
                  ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                  : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
              )}
            >
              <p.icon size={13} aria-hidden style={on ? undefined : { color: p.tone }} />
              {p.label}
            </button>
          )
        })}
      </div>

      <label className="ml-auto flex items-center gap-1.5 text-sm text-fg-muted">
        <UserRound size={15} aria-hidden />
        <span className="sr-only">Filter by person</span>
        <select
          value={value.actorId}
          onChange={(e) => onPatch({ actorId: e.target.value })}
          className="h-9 max-w-[168px] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
        >
          <option value="">Anyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-sm text-fg-muted">
        <span className="sr-only">From date</span>
        <input
          type="date"
          value={value.from}
          max={value.to || today}
          onChange={(e) => onPatch({ from: e.target.value })}
          className="h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
        />
        <span aria-hidden>–</span>
        <span className="sr-only">To date</span>
        <input
          type="date"
          value={value.to}
          min={value.from}
          max={today}
          onChange={(e) => onPatch({ to: e.target.value })}
          className="h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
        />
      </label>
    </div>
  )
}

// -------------------------------------------------------------------- rows ---

/**
 * Grouped by day, newest first.
 *
 * The day headers are not decoration: every question this log answers is
 * anchored to one — "the night the drawer was short", "before the stock take" —
 * and a flat list of timestamps makes the reader do that grouping in their head
 * while scrolling.
 */
function Rows({
  rows,
  today,
  selectedId,
  onOpen,
}: {
  rows: readonly AuditEntry[]
  today: string
  selectedId: number | null
  onOpen: (id: number) => void
}) {
  const out: React.ReactNode[] = []
  let lastDay = ''

  for (const row of rows) {
    const day = localDay(row.at)
    if (day !== lastDay) {
      lastDay = day
      out.push(
        <div
          key={`day-${day}`}
          className="sticky top-0 z-10 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1 text-2xs font-medium text-fg-muted"
        >
          {dayLabel(day, today)}
        </div>,
      )
    }
    out.push(
      <Row key={row.id} row={row} selected={row.id === selectedId} onOpen={() => onOpen(row.id)} />,
    )
  }

  return <>{out}</>
}

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  const t = new Date(`${today}T00:00:00`)
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Yesterday'
  return DAY_FMT.format(d)
}

function Row({ row, selected, onOpen }: { row: AuditEntry; selected: boolean; onOpen: () => void }) {
  const spec = AUDIT_ACTION_SPEC[row.action]
  const Icon = ACTION_ICON[row.action]
  const negative = row.amount !== null && row.amount.startsWith('-')

  return (
    <button
      type="button"
      data-entry-row
      data-entry-id={row.id}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative grid w-full items-center gap-3 border-b border-border-subtle px-[var(--cell-px)] py-1.5 text-left',
        COLS,
        selected ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      {selected ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" /> : null}

      <span className="num text-2xs text-fg-muted">{TIME_FMT.format(new Date(row.at))}</span>

      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-fg">{row.actorName}</span>
        <span className="truncate text-2xs text-fg-subtle">{ROLE_SHORT[row.actorRole]}</span>
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        {Icon ? (
          <Icon
            size={13}
            aria-hidden
            className={cn('shrink-0', spec?.loss ? 'text-danger-9' : 'text-fg-subtle')}
          />
        ) : null}
        <span className={cn('truncate text-sm', spec?.loss ? 'font-medium text-fg' : 'text-fg-muted')}>
          {auditLabel(row.action)}
        </span>
      </span>

      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-fg">{row.summary}</span>
        <span className="mono truncate text-2xs text-fg-subtle">
          {row.entity} · {row.entityRef}
          {row.terminalId !== null ? ` · till ${row.terminalId}` : ''}
        </span>
      </span>

      <span className="flex items-center justify-end gap-1.5">
        {row.override ? <Chip icon={BadgeCheck} tone="var(--warning-11)">Signed</Chip> : null}
        {row.amount !== null ? (
          <span className={cn('num text-sm', negative ? 'font-medium text-danger-11' : 'text-fg')}>
            {formatMoney(row.amount)}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** Arrow keys down real buttons; the DOM stays the one source of "where am I". */
function moveFocus(container: HTMLElement | null, delta: number) {
  if (!container) return
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-entry-row]')]
  if (rows.length === 0) return
  const at = rows.findIndex((r) => r === document.activeElement)
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta))]
  next?.focus()
}

// ------------------------------------------------------------------ detail ---

function EntryDetail({
  entry,
  onClose,
  onFilterActor,
  onFilterAction,
}: {
  entry: AuditEntry
  onClose: () => void
  onFilterActor: () => void
  onFilterAction: () => void
}) {
  const when = new Date(entry.at)

  return (
    <aside
      className="card flex w-[372px] shrink-0 flex-col overflow-hidden"
      aria-label={`${auditLabel(entry.action)} — ${entry.entityRef}`}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xl font-semibold tracking-tight text-fg">{auditLabel(entry.action)}</h3>
          <p className="mono truncate text-xs text-fg-subtle">
            {entry.entity} · {entry.entityRef}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="scroll-region min-h-0 flex-1 px-[var(--card-px)] py-3">
        <p className="text-base text-fg">{entry.summary}</p>

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="micro-label self-center">Who</dt>
          <dd className="flex items-center gap-1.5">
            <span className="text-fg">{entry.actorName}</span>
            {/* The full label here — the detail panel has the room the column does not. */}
            <Chip>{ROLE_LABEL[entry.actorRole]}</Chip>
          </dd>
          <dt className="micro-label self-center">When</dt>
          <dd className="num text-fg">
            {Number.isNaN(when.getTime())
              ? '—'
              : `${DAY_FMT.format(when)} · ${TIME_FMT.format(when)}`}
          </dd>
          {entry.terminalId !== null ? (
            <>
              <dt className="micro-label self-center">Terminal</dt>
              <dd className="text-fg">Till {entry.terminalId}</dd>
            </>
          ) : null}
          {entry.amount !== null ? (
            <>
              <dt className="micro-label self-center">Amount</dt>
              <dd className="num text-fg">{formatMoney(entry.amount)}</dd>
            </>
          ) : null}
        </dl>

        {entry.changes.length > 0 ? (
          <section className="mt-3.5">
            <h4 className="micro-label mb-1.5">What changed</h4>
            <ul className="flex flex-col gap-1.5">
              {entry.changes.map((c) => (
                <li key={c.field} className="rounded-[var(--radius-md)] border border-border-subtle px-2 py-1.5">
                  <div className="text-2xs text-fg-subtle">{c.field}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-sm">
                    <span className="num truncate text-fg-muted line-through decoration-fg-subtle/60">
                      {c.before ?? '—'}
                    </span>
                    <ArrowRight size={12} className="shrink-0 text-fg-subtle" aria-hidden />
                    <span className="num truncate font-medium text-fg">{c.after ?? '—'}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {entry.override ? <OverrideCard override={entry.override} /> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={onFilterActor}>
            <UserRound /> Everything by {firstName(entry.actorName)}
          </Button>
          <Button size="sm" onClick={onFilterAction}>
            <ListFilter /> All “{auditLabel(entry.action).toLowerCase()}”
          </Button>
        </div>
      </div>
    </aside>
  )
}

const firstName = (name: string): string => name.split(' ')[0] ?? name

/**
 * The signature, as it is stored.
 *
 * Both identities, the reason code, what was asked for and the ceiling it went
 * past. An override row carrying only "approved" answers nothing at a month
 * end, and one carrying only the approver cannot show who asked.
 */
function OverrideCard({ override }: { override: NonNullable<AuditEntry['override']> }) {
  return (
    <section className="mt-3.5 rounded-[var(--radius-md)] border border-warning-9/40 bg-warning-3 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-warning-11">
        <ShieldCheck size={13} aria-hidden />
        {OVERRIDE_REASON_LABEL[override.reasonCode]}
        <code className="mono ml-auto text-2xs text-fg-muted">{override.reasonCode}</code>
      </h4>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1">
          <span className="micro-label block">Asked</span>
          <span className="truncate text-fg">{override.requesterName}</span>
        </span>
        <ArrowRight size={13} className="shrink-0 text-warning-11" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="micro-label block">Approved</span>
          <span className="truncate font-medium text-fg">{override.approverName}</span>
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-2 text-xs">
        <span className="micro-label">Limit</span>
        <span className="num text-fg-muted line-through decoration-fg-subtle/60">{override.limit}</span>
        <ArrowRight size={11} className="text-fg-subtle" aria-hidden />
        <span className="num font-medium text-fg">{override.requested}</span>
      </div>

      {override.note ? (
        <p className="mt-2 border-t border-warning-9/25 pt-2 text-2xs text-warning-11">
          “{override.note}”
        </p>
      ) : null}

      {/* Stated on the record itself, not only in the policy above it: the two
          ids differ here, and Phase 5 keeps it that way with a CHECK. */}
      <p className="mt-2 text-2xs text-fg-subtle">
        Approver #{override.approverId} · requester #{override.requesterId} — never the same person.
      </p>
    </section>
  )
}
