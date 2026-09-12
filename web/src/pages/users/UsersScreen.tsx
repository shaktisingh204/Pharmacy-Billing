import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BadgeCheck, CalendarClock, CircleSlash, Clock, Plus, ShieldAlert, ShieldCheck, UserRound,
  UserRoundCheck, Users2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditEntry, Permission, User } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { PERMISSION_CATALOGUE, ROLE_LABEL, can, exposure } from '@/api/users'
import type { Holds } from '@/api/users'
import {
  POLICY_STORAGE_KEY, changeCount, holdsUnder, readPolicy, serialisePolicy,
} from '@/api/rolePolicy'
import type { RolePolicy } from '@/api/rolePolicy'
import {
  REVIEW_STORAGE_KEY, activityFor, approvalQueue, moneyPower, readReviews, reviewCounts,
  shiftsFrom,
} from '@/api/roster'
import type { ReviewLedger } from '@/api/roster'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'
import { RoleMatrix } from './RoleMatrix'
import { UserForm } from './UserForm'
import { AuditLog } from './AuditLog'
import { Approvals } from './Approvals'
import { ExposurePanel } from './Exposure'
import { PersonDetail } from './PersonDetail'
import { Shifts } from './Shifts'
import { usePersisted } from './usePersisted'

/**
 * Who works here, what they may do, and what they have done.
 *
 * Shipped as bare CRUD over a roster this screen would answer a question nobody
 * has. The five an owner actually asks are:
 *
 *   1. WHO CAN VOID A BILL. Not "what does the manager role grant" — the names.
 *      The exposure band counts PEOPLE, through the same predicate the counter
 *      is gated on, so a disabled manager and a pharmacist with the cost flag
 *      off are counted the way they actually behave.
 *   2. HOW FAR CAN EACH OF THEM GO ALONE. A number, not a capability, and per
 *      person: two cashiers on the same till hold different discount ceilings
 *      because one of them has been there four years.
 *   3. IS THAT STILL THE POLICY WE WANT. The matrix is editable per role, kept
 *      as a diff against the shipped one, and every change is marked, warned
 *      about in this shop's own headcounts, and reversible.
 *   4. WHO WAS ON THE COUNTER WHEN THE DRAWER WAS SHORT. Shifts, derived from
 *      the trail rather than keyed by anybody, with the closing count against
 *      each one.
 *   5. WHAT DID SOMEBODY SIGN FOR. Every override, re-checked against the
 *      roster as it stands today, as a queue that remembers being read.
 *
 * Five tabs rather than five screens, because the answers are read against each
 * other: the matrix explains a denial in the roster, the roster explains a name
 * in a shift, and a shift explains a signature in the queue. The tab, the
 * selection and the filters are all in the URL, so a view is a link and
 * "everything Akib did on Friday" is a paste rather than a set of instructions.
 */

type Tab = 'people' | 'permissions' | 'approvals' | 'shifts' | 'activity'

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'people', label: 'People', icon: Users2 },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'approvals', label: 'Approvals', icon: BadgeCheck },
  { id: 'shifts', label: 'Shifts', icon: Clock },
  { id: 'activity', label: 'Trail', icon: CalendarClock },
]

const GUARDED = PERMISSION_CATALOGUE.filter((p) => p.guard !== null)
const GUARDED_IDS = new Set<string>(GUARDED.map((p) => p.id))

/** How much of the trail this screen folds into shifts, timelines and the queue. */
const TRAIL_WINDOW = 400

/* The exposure band is read once and then in the way: open, it and the header
   take two thirds of the 640px the design floor leaves for a page. So it folds,
   and the fold is remembered per device rather than reset on every visit. */
const BAND_STORAGE_KEY = 'rxbill.usersExposure'
const readBandOpen = (raw: string | null): boolean => raw !== 'false'

const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])
const EMPTY_USERS: readonly User[] = []
const EMPTY_ROWS: readonly AuditEntry[] = []

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`
}

// ----------------------------------------------------------------- screen ---

export function UsersScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const listRef = useRef<HTMLDivElement>(null)

  const today = useMemo(() => isoDay(new Date()), [])
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

  const tabParam = params.get('tab')
  const tab: Tab = TABS.find((t) => t.id === tabParam)?.id ?? 'people'
  const idParam = params.get('id')
  const selectedId = idParam !== null && /^\d+$/.test(idParam) ? Number(idParam) : null
  const holdParam = params.get('hold')
  const hold = holdParam !== null && GUARDED_IDS.has(holdParam) ? (holdParam as Permission) : null

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)

  /* The shop's own matrix and the owner's reading marks. Neither has a table in
     the contract yet, so both live on the device until Phase 5 gives them one —
     and both are read through a parser that cannot throw on a stale file. */
  const [policy, setPolicy] = usePersisted<RolePolicy>(POLICY_STORAGE_KEY, readPolicy, serialisePolicy)
  const [reviews, setReviews] = usePersisted<ReviewLedger>(REVIEW_STORAGE_KEY, readReviews, JSON.stringify)
  const [bandOpen, setBandOpen] = usePersisted<boolean>(BAND_STORAGE_KEY, readBandOpen, String)

  const roster = useQuery({ queryKey: ['users', 'list'], queryFn: () => api.listUsers() })
  const me = useQuery({ queryKey: ['users', 'me'], queryFn: () => api.currentUser() })

  const users = roster.data ?? EMPTY_USERS
  const viewer = me.data ?? null
  const mayReadTrail = viewer !== null && can(viewer, 'reports.audit')

  /* One unfiltered window of the trail, shared by the shifts, the queue and
     every person's timeline. The Trail tab keeps its own filtered query — three
     derived views over one fetch is a fetch worth keeping, and three fetches of
     the same rows is not. */
  const trail = useQuery({
    queryKey: ['audit', { limit: TRAIL_WINDOW }],
    queryFn: () => api.listAudit({ limit: TRAIL_WINDOW }),
    enabled: mayReadTrail,
    placeholderData: keepPreviousData,
  })
  const rows = trail.data?.rows ?? EMPTY_ROWS

  const holds = useMemo(() => holdsUnder(policy), [policy])
  const stats = useMemo(() => exposure(users, holds), [users, holds])
  const power = useMemo(() => moneyPower(users, rows, holds), [users, rows, holds])
  const shifts = useMemo(() => shiftsFrom(rows), [rows])
  const queue = useMemo(
    () => (mayReadTrail ? approvalQueue(rows, users, today, holds) : []),
    [mayReadTrail, rows, users, today, holds],
  )
  const unread = useMemo(() => reviewCounts(queue, reviews).unread, [queue, reviews])
  /* One pass over the window for the whole roster. Asked per row it is the same
     scan seven times, and it grows with both the trail and the payroll. */
  const lastSeen = useMemo(() => {
    const seen = new Map<number, string>()
    for (const row of rows) {
      const held = seen.get(row.actorId)
      if (held === undefined || row.at > held) seen.set(row.actorId, row.at)
    }
    return seen
  }, [rows])
  const changed = changeCount(policy)

  const filtered = useMemo(
    () => (hold === null ? users : users.filter((u) => holds(u, hold))),
    [users, hold, holds],
  )
  const selected = useMemo(
    /* Looked up in the UNFILTERED roster on purpose: pressing a power tile after
       opening somebody must not close the record being read. */
    () => (selectedId === null ? null : users.find((u) => u.id === selectedId) ?? null),
    [users, selectedId],
  )
  const activity = useMemo(
    () => activityFor(rows, shifts, selected?.id ?? -1),
    [rows, shifts, selected],
  )

  // ------------------------------------------------------------ URL as view ---

  const go = useCallback(
    (next: { tab?: Tab; id?: number | null; hold?: Permission | null; who?: number | null }) => {
      setParams((prev) => {
        const out = new URLSearchParams(prev)
        if (next.tab !== undefined) {
          if (next.tab === 'people') out.delete('tab')
          else out.set('tab', next.tab)
        }
        if (next.id !== undefined) {
          if (next.id === null) out.delete('id')
          else out.set('id', String(next.id))
        }
        if (next.hold !== undefined) {
          if (next.hold === null) out.delete('hold')
          else out.set('hold', next.hold)
        }
        /* The trail's own actor filter, written from here so "everything by
           Akib" is one press from his record rather than a second selection. */
        if (next.who !== undefined) {
          if (next.who === null) out.delete('who')
          else out.set('who', String(next.who))
        }
        return out
      }, { replace: next.id !== undefined && next.tab === undefined })
    },
    [setParams],
  )

  const openCreate = useCallback(() => {
    setEditing(null)
    setFormOpen(true)
  }, [])

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => api.setUserActive(id, isActive),
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
      toast.success(u.isActive ? `${u.name} can sign in again` : `${u.name}’s account disabled`, {
        description: u.isActive
          ? undefined
          : 'Their name stays on every bill and trail entry they touched. Accounts are never deleted.',
      })
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'That change could not be saved.')
    },
  })

  // ----------------------------------------------------------------- state ---

  const error = roster.error ?? me.error
  const denied = (error instanceof ApiError && DENIED_CODES.has(error.code))
    || (viewer !== null && !can(viewer, 'settings.users'))
  const status: 'ready' | 'loading' | 'error' | 'offline' | 'denied' = denied
    ? 'denied'
    : !online && !roster.data
      ? 'offline'
      : error
        ? 'error'
        : roster.isPending || me.isPending
          ? 'loading'
          : 'ready'

  const tabCount = (id: Tab): string | null => {
    if (status !== 'ready') return null
    if (id === 'people') return String(stats.active)
    if (id === 'permissions') return changed === 0 ? null : String(changed)
    if (id === 'approvals') return mayReadTrail ? String(unread) : null
    if (id === 'shifts') return mayReadTrail ? String(shifts.length) : null
    return null
  }

  return (
    <div className="flex h-full flex-col">
      <header className="page-header shrink-0" style={{ paddingInline: 'var(--page-px)' }}>
        <div className="flex items-start justify-between gap-6 pt-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-semibold tracking-display text-fg">Users &amp; roles</h1>
            <p className="mt-1 max-w-[68ch] text-base text-fg-muted">
              A role opens the door; the numbers underneath say how far each person goes alone.
              Everything past that takes a second signature, and every signature is here.
            </p>
          </div>

          {status === 'ready' ? (
            <div className="hidden shrink-0 text-right lg:block">
              <span className="micro-label block">Refund authority at the counter</span>
              <span className="display-num block text-4xl text-fg">
                ₹{formatAmount(power.counterAuthority)}
              </span>
              <span className="block text-xs text-fg-muted">
                can go back over the counter today with nobody signing
              </span>
            </div>
          ) : null}

          <Button variant="primary" onClick={openCreate} disabled={status !== 'ready'}>
            <Plus /> New user
          </Button>
        </div>

        {/* Deliberately buttons with `aria-pressed`, not `role="tab"`. The full
            tab pattern owes a reader roving tabindex, arrow-key navigation and a
            labelled panel, and a half-built one announces affordances that are
            not there — worse than a plain pressed button, which is exactly what
            every other segmented control in this app already is. */}
        <div className="mt-3 flex items-center gap-1.5 pb-3" role="group" aria-label="View">
          {TABS.map((t) => {
            const on = tab === t.id
            const count = tabCount(t.id)
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => go({ tab: t.id })}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] border px-3.5 text-sm',
                  'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease)]',
                  on
                    ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                    : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                )}
              >
                <t.icon size={15} aria-hidden />
                {t.label}
                {count !== null ? (
                  <span
                    className={cn(
                      'num rounded-[var(--radius-full)] px-1.5 text-2xs',
                      on ? 'bg-accent-9/15 text-accent-11' : 'bg-inset text-fg-subtle',
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{ padding: 'var(--card-gap) var(--page-px) var(--page-px)', gap: 'var(--card-gap)' }}
      >
        {status === 'loading' ? (
          <div className="card min-h-0 flex-1 overflow-hidden"><SkeletonRows rows={10} cols={5} /></div>
        ) : status === 'denied' ? (
          <div className="card flex min-h-0 flex-1 items-center justify-center">
            <PermissionDenied needs="settings.users" />
          </div>
        ) : status === 'offline' ? (
          <div className="card flex min-h-0 flex-1 items-center justify-center"><OfflineState /></div>
        ) : status === 'error' ? (
          <div className="card flex min-h-0 flex-1 items-center justify-center">
            <ErrorState
              code={error instanceof ApiError ? error.code : 'USERS_FAILED'}
              message={error ? (error as Error).message : undefined}
              onRetry={() => { void roster.refetch(); void me.refetch() }}
            />
          </div>
        ) : tab === 'permissions' ? (
          <RoleMatrix
            users={users}
            policy={policy}
            editable={viewer !== null && can(viewer, 'settings.users')}
            editorName={viewer?.name ?? 'somebody'}
            onPolicy={(next, note) => {
              setPolicy(next)
              /* A widened grant is announced as a WARNING even though it
                 succeeded. The success is not the point — the exposure is. */
              const show = note.tone === 'warn' ? toast.warning : toast.success
              show(note.title, note.detail === undefined ? undefined : { description: note.detail })
            }}
          />
        ) : tab === 'approvals' ? (
          <Approvals
            items={queue}
            mayRead={mayReadTrail}
            reviewer={viewer?.name ?? 'somebody'}
            ledger={reviews}
            onLedger={setReviews}
            onOpenPerson={(id) => go({ tab: 'people', id, hold: null })}
          />
        ) : tab === 'shifts' ? (
          <Shifts
            rows={rows}
            today={today}
            mayRead={mayReadTrail}
            onOpenPerson={(id) => go({ tab: 'people', id, hold: null })}
          />
        ) : tab === 'activity' ? (
          <AuditLog users={users} viewer={viewer} online={online} />
        ) : (
          <>
            <ExposurePanel
              power={power}
              stats={stats}
              hold={hold}
              open={bandOpen}
              onOpen={setBandOpen}
              onHold={(id) => go({ tab: 'people', hold: id === hold ? null : id, id: null })}
            />

            <div className="flex min-h-0 flex-1" style={{ gap: 'var(--card-gap)' }}>
              <div data-density="compact" className="card flex min-w-0 flex-1 flex-col overflow-hidden">
                <HeaderRow />

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
                      if (selectedId !== null) go({ id: null })
                      else if (hold !== null) go({ hold: null })
                    }
                  }}
                >
                  {filtered.length === 0 ? (
                    hold !== null ? (
                      <EmptyState
                        icon={ShieldCheck}
                        title="Nobody holds this"
                        body={`No active account can ${GUARDED.find((g) => g.id === hold)?.label.toLowerCase()}. That is the safe answer, not an empty screen.`}
                        actionLabel="Show everyone"
                        onAction={() => go({ hold: null })}
                      />
                    ) : (
                      <EmptyState
                        icon={UserRound}
                        title="No accounts yet"
                        body="Every bill carries the name of whoever keyed it, so the roster is the first thing a shop sets up. Add the owner, then the counter."
                        actionLabel="New user"
                        onAction={openCreate}
                      />
                    )
                  ) : (
                    filtered.map((u) => (
                      <PersonRow
                        key={u.id}
                        user={u}
                        isViewer={viewer?.id === u.id}
                        selected={u.id === selectedId}
                        holds={holds}
                        lastSeen={lastSeen.get(u.id) ?? null}
                        onOpen={() => go({ id: u.id })}
                      />
                    ))
                  )}
                </div>

                {filtered.length > 0 ? (
                  <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-subtle">
                    <span>
                      {filtered.length === users.length
                        ? `${filtered.length} account${filtered.length === 1 ? '' : 's'}`
                        : `${filtered.length} of ${users.length}`}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>↵</Kbd> open
                    </span>
                  </footer>
                ) : null}
              </div>

              {selected ? (
                <PersonDetail
                  key={selected.id}
                  user={selected}
                  users={users}
                  viewer={viewer}
                  today={today}
                  busy={setActive.isPending}
                  holds={holds}
                  activity={activity}
                  mayReadTrail={mayReadTrail}
                  onClose={() => {
                    const id = selected.id
                    go({ id: null })
                    listRef.current?.querySelector<HTMLButtonElement>(`[data-user-id="${id}"]`)?.focus()
                  }}
                  onEdit={() => { setEditing(selected); setFormOpen(true) }}
                  onToggleActive={() => setActive.mutate({ id: selected.id, isActive: !selected.isActive })}
                  onSeeTrail={() => go({ tab: 'activity', who: selected.id })}
                  onSeeShifts={() => go({ tab: 'shifts' })}
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      <UserForm
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        users={users}
        onSaved={(u, created) => {
          void qc.invalidateQueries({ queryKey: ['users'] })
          void qc.invalidateQueries({ queryKey: ['audit'] })
          toast.success(created ? `${u.name} added` : `${u.name} saved`, {
            description: `${ROLE_LABEL[u.role]} · ${u.limits.maxDiscountPct}% discount · ₹${u.limits.maxRefundAmount} refund without a signature`,
          })
          go({ tab: 'people', id: u.id, hold: null })
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------- rows ---

const COLS = 'grid-cols-[minmax(150px,1.8fr)_104px_minmax(140px,1.3fr)_minmax(120px,1.2fr)_96px_104px]'

function HeaderRow() {
  return (
    <div className={cn('grid shrink-0 items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5', COLS)}>
      <span className="micro-label">Person</span>
      <span className="micro-label">Role</span>
      <span className="micro-label">Without a signature</span>
      <span className="micro-label">Also holds</span>
      <span className="micro-label">Last seen</span>
      <span className="micro-label text-right">Account</span>
    </div>
  )
}

const SEEN_FMT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })

/** "today", "3 days ago", "12 Aug" — the resolution a roster is actually read at. */
function seenLabel(at: string | null): string {
  if (at === null) return 'not in the window'
  const then = new Date(at)
  if (Number.isNaN(then.getTime())) return '—'
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return SEEN_FMT.format(then)
}

function PersonRow({
  user,
  isViewer,
  selected,
  holds,
  lastSeen,
  onOpen,
}: {
  user: User
  isViewer: boolean
  selected: boolean
  holds: Holds
  lastSeen: string | null
  onOpen: () => void
}) {
  const held = GUARDED.filter((spec) => holds(user, spec.id))

  return (
    <button
      type="button"
      data-user-row
      data-user-id={user.id}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      style={{ minHeight: 'var(--row-h)' }}
      className={cn(
        'relative grid w-full items-center gap-3 border-b border-border-subtle px-[var(--cell-px)] py-1.5 text-left',
        COLS,
        selected ? 'bg-accent-3' : 'hover:bg-hover',
        /* A tint, not `opacity`. A disabled account's name, username and role
           are exactly what somebody is reading when they open this row — fading
           the whole thing took them to ~2.4:1. */
        !user.isActive && 'bg-subtle',
      )}
    >
      {selected ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" /> : null}

      <span className="flex min-w-0 flex-col">
        <span className={cn('flex items-center gap-1.5 truncate text-sm font-medium', selected ? 'text-accent-11' : 'text-fg')}>
          {user.name}
          {isViewer ? <Chip tone="var(--accent-11)">You</Chip> : null}
        </span>
        <span className="mono truncate text-2xs text-fg-subtle">
          {user.username}
          {user.pharmacistRegNo ? ` · ${user.pharmacistRegNo}` : ''}
        </span>
      </span>

      <span className="min-w-0">
        <Chip tone={user.role === 'cashier' ? undefined : 'var(--accent-11)'}>{ROLE_LABEL[user.role]}</Chip>
      </span>

      <span className="num min-w-0 truncate text-xs text-fg-muted">
        {user.limits.maxDiscountPct}% · ₹{formatAmount(user.limits.maxRefundAmount)} ·{' '}
        {user.limits.backdateDays === 0 ? 'today only' : `${user.limits.backdateDays}d back`}
      </span>

      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {held.length === 0 ? (
          <span className="text-2xs text-fg-subtle">Nothing guarded</span>
        ) : (
          /* Two, then a count. A third chip wraps the cell onto a third line and
             costs the grid a row of its own on every account that holds one. */
          held.slice(0, 2).map((spec) => (
            <Chip key={spec.id} icon={ShieldAlert} tone="var(--warning-11)">{spec.label}</Chip>
          ))
        )}
        {held.length > 2 ? (
          <span className="text-2xs text-fg-subtle" title={held.map((s) => s.label).join(', ')}>
            +{held.length - 2}
          </span>
        ) : null}
      </span>

      <span className="truncate text-2xs text-fg-subtle">{seenLabel(lastSeen)}</span>

      <span className="flex justify-end">
        {user.isActive
          ? <Chip icon={UserRoundCheck} tone="var(--success-11)">Active</Chip>
          : <Chip icon={CircleSlash} tone="var(--status-out-of-stock)">Disabled</Chip>}
      </span>
    </button>
  )
}

function moveFocus(container: HTMLElement | null, delta: number) {
  if (!container) return
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-user-row]')]
  if (rows.length === 0) return
  const at = rows.findIndex((r) => r === document.activeElement)
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta))]
  next?.focus()
}
