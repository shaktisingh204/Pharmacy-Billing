import { useMemo, useState } from 'react'
import {
  ArrowRight, BadgeCheck, Check, CircleCheck, Flag, ShieldCheck, TriangleAlert, Undo2, UserRound,
} from 'lucide-react'
import { OVERRIDE_REASON_LABEL, auditLabel } from '@/api/users'
import {
  approvalTotals, bucketOf, clearReview, markReview, reviewCounts, reviewOf,
} from '@/api/roster'
import type { ApprovalItem, ApprovalStanding, ReviewBucket, ReviewLedger } from '@/api/roster'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, PermissionDenied } from '@/components/states'

/**
 * The signatures, as a queue somebody works through.
 *
 * An override is already in the trail, so a screen that only listed them again
 * would be a filter with a nicer heading. What makes this a queue is the two
 * things the trail cannot do:
 *
 *  1. IT RE-CHECKS. Every recorded approval is put back through `canApprove`
 *     against the roster AS IT STANDS TODAY. A signature is a fact about last
 *     Tuesday; whether the person who gave it could give it now is a fact about
 *     the roster, and the gap between the two is where an owner finds either a
 *     ceiling that was set too generously or a manager who has been signing past
 *     their own. Those float to the top of the list, always.
 *  2. IT REMEMBERS BEING READ. An owner comes in on Monday to four signatures
 *     from the weekend, reads them, accepts three and wants to talk about the
 *     fourth. Marking that is not an event in the shop's history — it is a
 *     bookmark — so it is kept beside the log rather than written into it, and
 *     the trail stays a record of things that happened.
 *
 * Approving here does not un-happen anything. The goods left the shop when the
 * manager signed; this is the review afterwards, and the copy says so rather
 * than offering a button that looks like it could reverse a refund.
 */

const TIME_FMT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })

const STANDING_LABEL: Record<ApprovalStanding, string> = {
  'stands': 'Still stands',
  'self-approved': 'Signed by the person who asked',
  'approver-gone': 'Cannot be re-checked',
  'approver-disabled': 'Approver has left',
  'approver-cannot': 'Past their ceiling today',
}

const BUCKETS: Array<{ id: ReviewBucket | 'all'; label: string }> = [
  { id: 'unread', label: 'Needs reading' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'reviewed', label: 'Read' },
  { id: 'all', label: 'Everything' },
]

export function Approvals({
  items,
  mayRead,
  reviewer,
  ledger,
  onLedger,
  onOpenPerson,
}: {
  /** Already re-checked against today's roster by the screen that owns the trail. */
  items: readonly ApprovalItem[]
  mayRead: boolean
  /** Whose name goes on the bookmark. */
  reviewer: string
  ledger: ReviewLedger
  onLedger: (next: ReviewLedger) => void
  onOpenPerson: (userId: number) => void
}) {
  const [bucket, setBucket] = useState<ReviewBucket | 'all'>('unread')
  const [flagging, setFlagging] = useState<number | null>(null)

  const totals = useMemo(() => approvalTotals(items), [items])
  const counts = useMemo(() => reviewCounts(items, ledger), [items, ledger])

  const shown = useMemo(
    () => (bucket === 'all' ? items : items.filter((i) => bucketOf(ledger, i.entry.id) === bucket)),
    [items, ledger, bucket],
  )

  if (!mayRead) {
    return (
      <div className="card flex min-h-0 flex-1 items-center justify-center">
        <PermissionDenied needs="reports.audit" />
      </div>
    )
  }

  const mark = (item: ApprovalItem, state: 'reviewed' | 'flagged', note: string | null) => {
    onLedger(markReview(ledger, item.entry.id, {
      state, note, by: reviewer, at: new Date().toISOString(),
    }))
    setFlagging(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ gap: 'var(--card-gap)' }}>
      <div className="card shrink-0" style={{ padding: 'var(--card-px)' }}>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="micro-label">Passed on a second signature</div>
            <div className="display-num text-4xl text-fg">₹{formatAmount(totals.atStake)}</div>
            <p className="mt-0.5 text-sm text-fg-muted">
              {totals.count} override{totals.count === 1 ? '' : 's'} in the loaded window ·{' '}
              {counts.unread} still to read
            </p>
          </div>

          <div className="min-w-0 max-w-[46ch]">
            <div className="flex items-center gap-1.5">
              {totals.questionable === 0
                ? <CircleCheck size={15} className="shrink-0 text-success-11" aria-hidden />
                : <TriangleAlert size={15} className="shrink-0 text-danger-9" aria-hidden />}
              <span className={cn('text-sm font-medium', totals.questionable === 0 ? 'text-success-11' : 'text-danger-11')}>
                {totals.questionable === 0
                  ? 'Every signature would still be given today'
                  : `${totals.questionable} would not be given the same way today`}
              </span>
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              Each one is put back through the same approval rules against the roster as it
              stands now. A signature that no longer stands is not a signature that was wrong
              — it is a ceiling, or a person, that has changed since.
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {BUCKETS.map((b) => {
              const n = b.id === 'all' ? items.length : counts[b.id]
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={bucket === b.id}
                  onClick={() => setBucket(b.id)}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm',
                    bucket === b.id
                      ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                      : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                  )}
                >
                  {b.label}
                  <span className="num text-xs">{n}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="scroll-region min-h-0 flex-1">
          {shown.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title={items.length === 0 ? 'Nothing needed a second signature' : bucket === 'unread' ? 'All read' : 'Nothing in here'}
              body={items.length === 0
                ? 'Every action in the loaded window sat inside the person’s own limits. That is what a well-set roster looks like — the ceilings are doing the work, not the manager.'
                : 'Nothing is sitting in this list. Overrides stay in the trail whatever you mark here; this is only the reading.'}
              actionLabel={items.length === 0 ? undefined : 'Show everything'}
              onAction={() => setBucket('all')}
            />
          ) : (
            <ul>
              {shown.map((item) => (
                <ApprovalRow
                  key={item.entry.id}
                  item={item}
                  mark={reviewOf(ledger, item.entry.id)}
                  flagging={flagging === item.entry.id}
                  onFlagStart={() => setFlagging(item.entry.id)}
                  onFlagCancel={() => setFlagging(null)}
                  onFlag={(note) => mark(item, 'flagged', note)}
                  onReviewed={() => mark(item, 'reviewed', null)}
                  onClear={() => { onLedger(clearReview(ledger, item.entry.id)); setFlagging(null) }}
                  onOpenPerson={onOpenPerson}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border-subtle bg-subtle px-[var(--card-px)] text-xs text-fg-subtle">
          <span className="font-medium text-danger-11">An approver is never the requester.</span>
          <span className="truncate">
            The picker leaves the person out of their own list, and Phase 5 keeps them out with a
            constraint rather than a rule anyone can forget.
          </span>
          <span className="num ml-auto shrink-0">{shown.length} shown</span>
        </footer>
      </div>
    </div>
  )
}

function ApprovalRow({
  item,
  mark,
  flagging,
  onFlagStart,
  onFlagCancel,
  onFlag,
  onReviewed,
  onClear,
  onOpenPerson,
}: {
  item: ApprovalItem
  mark: ReturnType<typeof reviewOf>
  flagging: boolean
  onFlagStart: () => void
  onFlagCancel: () => void
  onFlag: (note: string | null) => void
  onReviewed: () => void
  onClear: () => void
  onOpenPerson: (userId: number) => void
}) {
  const [note, setNote] = useState('')
  const { entry, override } = item
  const when = new Date(entry.at)
  const sound = item.standing === 'stands'

  return (
    <li
      className={cn(
        'border-b border-border-subtle px-[var(--card-px)] py-3',
        mark?.state === 'flagged' && 'bg-danger-3/25',
        /* A tint, not `opacity`. Fading a reviewed row took its text with it —
           the signature, the amount and the reason all dropped to ~2.5:1, which
           is the row somebody is reviewing. It still reads as done. */
        mark?.state === 'reviewed' && 'bg-subtle',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
        <div className="min-w-[224px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-fg">
              {OVERRIDE_REASON_LABEL[override.reasonCode]}
            </span>
            <code className="mono text-2xs text-fg-subtle">{override.reasonCode}</code>
            {sound ? (
              <Chip icon={CircleCheck} tone="var(--success-11)">{STANDING_LABEL[item.standing]}</Chip>
            ) : (
              <Chip icon={TriangleAlert} tone="var(--danger-11)">{STANDING_LABEL[item.standing]}</Chip>
            )}
            {mark?.state === 'flagged' ? <Chip icon={Flag} tone="var(--danger-11)">Flagged</Chip> : null}
            {mark?.state === 'reviewed' ? <Chip icon={Check} tone="var(--fg-muted)">Read</Chip> : null}
          </div>

          <p className="mt-1 text-sm text-fg-muted">{entry.summary}</p>
          <p className="mono mt-0.5 text-2xs text-fg-subtle">
            {auditLabel(entry.action)} · {entry.entity} {entry.entityRef}
            {entry.terminalId !== null ? ` · till ${entry.terminalId}` : ''} ·{' '}
            {Number.isNaN(when.getTime()) ? '—' : `${DAY_FMT.format(when)} ${TIME_FMT.format(when)}`}
          </p>
          {item.why ? <p className="mt-1 text-xs text-danger-11">{item.why}</p> : null}
        </div>

        <div className="min-w-[228px]">
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="micro-label block">Asked</span>
              <button
                type="button"
                onClick={() => onOpenPerson(override.requesterId)}
                className="flex items-center gap-1 truncate rounded-[var(--radius-sm)] text-fg hover:text-accent-11 hover:underline"
              >
                <UserRound size={12} className="shrink-0 text-fg-subtle" aria-hidden />
                {override.requesterName}
              </button>
            </span>
            <ArrowRight size={14} className="shrink-0 text-fg-subtle" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="micro-label block">Signed</span>
              <button
                type="button"
                onClick={() => onOpenPerson(override.approverId)}
                className="flex items-center gap-1 truncate rounded-[var(--radius-sm)] font-medium text-fg hover:text-accent-11 hover:underline"
              >
                <BadgeCheck size={12} className="shrink-0 text-warning-11" aria-hidden />
                {override.approverName}
              </button>
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 text-xs">
            <span className="micro-label">Limit</span>
            <span className="num text-fg-muted line-through decoration-fg-subtle/60">{override.limit}</span>
            <ArrowRight size={11} className="text-fg-subtle" aria-hidden />
            <span className="num font-medium text-fg">{override.requested}</span>
          </div>
          {override.note ? (
            <p className="mt-1 text-xs text-fg-muted">“{override.note}”</p>
          ) : (
            <p className="mt-1 text-2xs text-fg-subtle">No note was left with the signature.</p>
          )}
        </div>

        <div className="flex min-w-[168px] shrink-0 flex-col items-end gap-2">
          <div className="text-right">
            <span className="micro-label block">Let through</span>
            {/* A backdate asks for a DATE and a cost view asks for nothing at
                all, so there is no rupee figure to quote. Printing ₹0.00 there
                would report a signature that let nothing through. */}
            {item.atStake === '0.00' ? (
              <span className="text-sm text-fg-subtle" title="This ask was not an amount.">
                not an amount
              </span>
            ) : (
              <span className="num text-lg font-medium text-fg">₹{formatAmount(item.atStake)}</span>
            )}
          </div>
          {mark === null ? (
            <div className="flex gap-1.5">
              <Button size="sm" onClick={onReviewed}><Check /> Read</Button>
              <Button size="sm" onClick={onFlagStart}>
                <Flag className="text-danger-9" /> Flag
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <span className="text-2xs text-fg-subtle">
                {mark.state === 'flagged' ? 'Flagged' : 'Read'} by {mark.by || 'somebody'}
              </span>
              <Button size="sm" variant="ghost" onClick={onClear}><Undo2 /> Undo</Button>
            </div>
          )}
        </div>
      </div>

      {mark?.state === 'flagged' && mark.note ? (
        <p className="mt-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3/60 px-3 py-1.5 text-xs text-danger-11">
          {mark.note}
        </p>
      ) : null}

      {flagging ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="min-w-[240px] flex-1">
            <span className="sr-only">Why this one is flagged</span>
            <input
              value={note}
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onFlag(note) }
                if (e.key === 'Escape') { e.stopPropagation(); onFlagCancel() }
              }}
              placeholder="What do you want to ask about it?"
              className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base placeholder:text-fg-subtle hover:border-border-strong"
            />
          </label>
          <Button size="sm" variant="danger" onClick={() => onFlag(note)}><Flag /> Flag it</Button>
          <Button size="sm" variant="ghost" onClick={onFlagCancel}>Cancel</Button>
        </div>
      ) : null}
    </li>
  )
}
