import { useMemo, useState } from 'react'
import {
  Check, Lock, Minus, PenLine, RotateCcw, ShieldAlert, SlidersHorizontal, TriangleAlert,
} from 'lucide-react'
import type { Permission, Role, User, UserLimits } from '@contract'
import { ROLES } from '@contract'
import {
  PERMISSION_CATALOGUE, ROLE_BLURB, ROLE_CEILING, ROLE_LABEL, ROLE_STARTING_LIMITS,
  permissionGroups, roleHas,
} from '@/api/users'
import {
  LOCKED_ROLES, changeCount, isChanged, policyChanges, policyGrants, policyWarnings, revertPolicy,
  revertRole, setCell,
} from '@/api/rolePolicy'
import type { RolePolicy } from '@/api/rolePolicy'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'

/**
 * What each role may do, as one grid the shop can edit.
 *
 * Roles are columns and permissions are rows because the question this answers
 * is comparative — "what can a cashier do that a pharmacist cannot" — and a
 * per-role checklist makes that a memory exercise across four screens.
 *
 * IT USED TO BE READ-ONLY, and the argument for that was a good one: a shop that
 * can edit the matrix ends up with a cashier who may edit a rate because
 * somebody needed it once on a Tuesday, and the word stops meaning anything in
 * the trail. What that argument missed is where a refused shop actually goes.
 * It does not accept the four roles; it puts everybody on the owner's login,
 * and then the trail answers nothing at all. So the grid is editable, and the
 * design spends its whole budget on making a change VISIBLE rather than on
 * making it hard:
 *
 *  - Every moved cell keeps a mark and a word, for ever, against the shipped
 *    value it moved from. There is no state in which this shop's matrix looks
 *    like the one out of the box.
 *  - The warnings band names what a change costs in this shop's own numbers —
 *    the guard sentence from the catalogue, and how many live accounts it lands
 *    on — before it costs it.
 *  - The owner's column is a locked door with the key on the inside. Narrowing
 *    it is the one edit that cannot be undone from any screen.
 *
 * SIX ROWS ARE MARKED. They are the ones a cashier must not hold, and each says
 * what goes wrong when they do. Everything else is the ordinary business of a
 * shop and is drawn quietly: a matrix that shouts on every row shouts nowhere.
 */

const COLS = 'grid-cols-[minmax(240px,1fr)_repeat(4,minmax(96px,132px))]'

export function RoleMatrix({
  users,
  policy,
  editable,
  editorName,
  onPolicy,
}: {
  users: readonly User[]
  policy: RolePolicy
  /** False when the reader may not manage users. They still see the grid. */
  editable: boolean
  editorName: string
  onPolicy: (next: RolePolicy, note: { title: string; detail?: string; tone: 'ok' | 'warn' }) => void
}) {
  const groups = useMemo(() => permissionGroups(), [])

  /* Headcount per role, ACTIVE only. A column with nobody behind it is a policy
     nobody is currently subject to, and saying so is the difference between
     reading the matrix and reading the shop. */
  const headcount = useMemo(() => {
    const counts: Record<Role, number> = { admin: 0, manager: 0, pharmacist: 0, cashier: 0 }
    for (const u of users) if (u.isActive) counts[u.role] += 1
    return counts
  }, [users])

  const changes = useMemo(() => policyChanges(policy, users), [policy, users])
  const warnings = useMemo(() => policyWarnings(policy, users), [policy, users])
  const guardedCount = PERMISSION_CATALOGUE.filter((p) => p.guard !== null).length

  const toggle = (role: Role, permission: Permission, spec: { label: string }) => {
    const now = policyGrants(policy, role, permission)
    const result = setCell(policy, role, permission, !now, {
      name: editorName,
      at: new Date().toISOString(),
    })
    if (!result.ok) {
      onPolicy(policy, { title: 'Not editable', detail: result.why ?? undefined, tone: 'warn' })
      return
    }
    const heads = headcount[role]
    onPolicy(result.policy, {
      title: now
        ? `${ROLE_LABEL[role]} can no longer ${spec.label.toLowerCase()}`
        : `${ROLE_LABEL[role]} can now ${spec.label.toLowerCase()}`,
      detail: heads === 0
        ? 'Nobody is in this role today.'
        : `${heads} active account${heads === 1 ? '' : 's'} in this role.`,
      tone: now ? 'ok' : 'warn',
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ gap: 'var(--card-gap)' }}>
      <PolicyBand
        policy={policy}
        changes={changes}
        warnings={warnings}
        editable={editable}
        onRevertAll={() => onPolicy(revertPolicy(), {
          title: 'Back to the shipped matrix',
          detail: 'Every cell this shop had moved is now what it was out of the box.',
          tone: 'ok',
        })}
      />

      <div data-density="compact" className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={cn('grid shrink-0 items-end gap-2 border-b border-border bg-subtle px-[var(--cell-px)] py-2', COLS)}>
          <div>
            <div className="micro-label">Permission</div>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              {PERMISSION_CATALOGUE.length} gated actions · {guardedCount} marked
            </p>
          </div>
          {ROLES.map((role) => (
            <div key={role} className="text-center">
              <div className="flex items-center justify-center gap-1 truncate text-xs font-medium text-fg" title={ROLE_BLURB[role]}>
                {LOCKED_ROLES.has(role) ? <Lock size={11} className="text-fg-subtle" aria-hidden /> : null}
                {ROLE_LABEL[role]}
              </div>
              <div className="text-2xs text-fg-subtle">{headcount[role]} active</div>
              {editable && !LOCKED_ROLES.has(role) && changes.some((c) => c.role === role) ? (
                <button
                  type="button"
                  onClick={() => onPolicy(
                    revertRole(policy, role, { name: editorName, at: new Date().toISOString() }),
                    { title: `${ROLE_LABEL[role]} back to shipped`, tone: 'ok' },
                  )}
                  className="mt-0.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1 text-2xs text-accent-11 hover:bg-accent-2"
                >
                  <RotateCcw size={10} aria-hidden />
                  reset
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="scroll-region min-h-0 flex-1">
          {groups.map((group) => (
            <section key={group.area}>
              <h3 className={cn('grid items-center gap-2 border-b border-border-subtle bg-subtle/60 px-[var(--cell-px)] py-1', COLS)}>
                <span className="micro-label">{group.area}</span>
              </h3>

              {group.permissions.map((spec) => (
                <div
                  key={spec.id}
                  className={cn(
                    'grid items-start gap-2 border-b border-border-subtle px-[var(--cell-px)] py-1.5',
                    spec.guard ? 'bg-danger-3/25' : 'hover:bg-hover',
                    COLS,
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {spec.guard ? (
                        <ShieldAlert size={13} className="shrink-0 text-danger-9" aria-hidden />
                      ) : null}
                      <span className="truncate text-sm text-fg" title={spec.detail}>{spec.label}</span>
                      {spec.bounded ? <Chip icon={SlidersHorizontal}>Limited</Chip> : null}
                    </div>
                    <p className={cn('mt-0.5 text-2xs', spec.guard ? 'text-danger-11' : 'text-fg-subtle')}>
                      {spec.guard ?? spec.detail}
                    </p>
                    <code className="mono mt-0.5 block text-2xs text-fg-subtle">{spec.id}</code>
                  </div>

                  {ROLES.map((role) => (
                    <Cell
                      key={role}
                      granted={policyGrants(policy, role, spec.id)}
                      shipped={roleHas(role, spec.id)}
                      changed={isChanged(policy, role, spec.id)}
                      guarded={spec.guard !== null}
                      locked={LOCKED_ROLES.has(role)}
                      editable={editable}
                      label={`${ROLE_LABEL[role]}: ${spec.label}`}
                      onToggle={() => toggle(role, spec.id, spec)}
                    />
                  ))}
                </div>
              ))}
            </section>
          ))}

          <LimitsBand />
        </div>
      </div>
    </div>
  )
}

/**
 * Granted or not, with a WORD behind the mark and a mark behind the change.
 *
 * Meaning is never carried by colour alone: the tick and the dash are different
 * shapes, `aria-pressed` states it for a screen reader, and the sr-only text
 * spells out the whole pair so a cell read out of context still says which role
 * and which permission — and, when it has been moved, what it was before.
 */
function Cell({
  granted,
  shipped,
  changed,
  guarded,
  locked,
  editable,
  label,
  onToggle,
}: {
  granted: boolean
  shipped: boolean
  changed: boolean
  guarded: boolean
  locked: boolean
  editable: boolean
  label: string
  onToggle: () => void
}) {
  const word = granted ? 'granted' : 'denied'
  const moved = changed ? `, changed from ${shipped ? 'granted' : 'denied'}` : ''

  const mark = (
    <>
      {granted ? (
        <Check size={15} strokeWidth={2.5} aria-hidden className={guarded ? 'text-warning-11' : 'text-accent-9'} />
      ) : (
        <Minus size={13} aria-hidden className="text-fg-disabled" />
      )}
      {changed ? (
        <PenLine size={10} aria-hidden className="absolute right-1 top-1 text-accent-9" />
      ) : null}
    </>
  )

  if (!editable || locked) {
    return (
      <div
        className={cn(
          'relative flex h-7 items-center justify-center rounded-[var(--radius-sm)]',
          changed && 'bg-accent-2 ring-1 ring-accent-6',
        )}
        title={locked ? 'The owner’s column is not editable.' : undefined}
      >
        {mark}
        <span className="sr-only">{label}: {word}{moved}{locked ? ', not editable' : ''}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={granted}
      onClick={onToggle}
      className={cn(
        'relative flex h-7 items-center justify-center rounded-[var(--radius-sm)] border border-transparent',
        'hover:border-border-strong hover:bg-hover',
        changed && 'border-accent-6 bg-accent-2',
      )}
    >
      {mark}
      <span className="sr-only">
        {label}: {word}{moved}. Press to {granted ? 'revoke' : 'grant'}.
      </span>
    </button>
  )
}

// ------------------------------------------------------------- the changes ---

/**
 * What this shop has changed, and what it will cost.
 *
 * Sits above the grid unconditionally, because "we are running the shipped
 * matrix" is itself the answer to a question an owner asks, and a band that only
 * appears once something is wrong teaches the reader that its absence means
 * nothing was checked.
 */
function PolicyBand({
  policy,
  changes,
  warnings,
  editable,
  onRevertAll,
}: {
  policy: RolePolicy
  changes: ReturnType<typeof policyChanges>
  warnings: ReturnType<typeof policyWarnings>
  editable: boolean
  onRevertAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const n = changeCount(policy)
  const danger = warnings.filter((w) => w.severity === 'danger').length

  return (
    <div className="card shrink-0" style={{ padding: 'var(--card-px)' }}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {n === 0
              ? <Check size={16} className="shrink-0 text-success-11" aria-hidden />
              : <PenLine size={16} className="shrink-0 text-accent-9" aria-hidden />}
            <h2 className="text-lg font-semibold text-fg">
              {n === 0 ? 'Running the shipped matrix' : `${n} cell${n === 1 ? '' : 's'} moved from shipped`}
            </h2>
          </div>
          <p className="mt-1 max-w-[80ch] text-sm text-fg-muted">
            {n === 0
              ? 'Nothing has been changed. Press any cell outside the owner’s column to move it — a role grants the capability, and the numbers underneath bound how far each person may take it.'
              : `Last edited by ${policy.updatedBy ?? 'somebody'}${policy.updatedAt ? ` · ${new Date(policy.updatedAt).toLocaleString('en-IN')}` : ''}. Every moved cell keeps its mark against the value it moved from.`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {warnings.length > 0 ? (
            <Chip icon={TriangleAlert} tone={danger > 0 ? 'var(--danger-11)' : 'var(--warning-11)'}>
              {warnings.length} to read
            </Chip>
          ) : null}
          {n > 0 ? (
            <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? 'Hide changes' : 'Show changes'}
            </Button>
          ) : null}
          {n > 0 && editable ? (
            <Button size="sm" variant="danger" onClick={onRevertAll}>
              <RotateCcw /> Back to shipped
            </Button>
          ) : null}
        </div>
      </div>

      {warnings.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {warnings.map((w) => (
            <li
              key={w.id}
              className={cn(
                'flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2',
                w.severity === 'danger'
                  ? 'border-danger-9/30 bg-danger-3/50'
                  : 'border-warning-9/30 bg-warning-3/50',
              )}
            >
              <TriangleAlert
                size={14}
                aria-hidden
                className={cn('mt-0.5 shrink-0', w.severity === 'danger' ? 'text-danger-9' : 'text-warning-9')}
              />
              <div className="min-w-0">
                <div className={cn('text-sm font-medium', w.severity === 'danger' ? 'text-danger-11' : 'text-warning-11')}>
                  {w.severity === 'danger' ? 'Costs money' : 'Gets in the way'} — {w.title}
                </div>
                <p className="text-xs text-fg-muted">{w.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {open && changes.length > 0 ? (
        <ul className="mt-3 grid gap-1.5 md:grid-cols-2">
          {changes.map((c) => (
            <li
              key={`${c.role}:${c.permission}`}
              className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-3 py-2"
            >
              {c.granted
                ? <Check size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-accent-9" aria-hidden />
                : <Minus size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />}
              <div className="min-w-0 text-xs">
                <span className="font-medium text-fg">{ROLE_LABEL[c.role]}</span>
                <span className="text-fg-muted">
                  {' '}{c.granted ? 'may now' : 'may no longer'} {c.spec.label.toLowerCase()}
                </span>
                <div className="text-2xs text-fg-subtle">
                  shipped: {c.shipped ? 'granted' : 'denied'} · {c.affected} active
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------- the limits ---

const LIMIT_ROWS: Array<{
  key: keyof UserLimits
  label: string
  note: string
  render: (l: UserLimits) => string
}> = [
  {
    key: 'maxDiscountPct',
    label: 'Discount without a signature',
    note: 'Past it, a manager approves the line and the approval is recorded.',
    render: (l) => `${l.maxDiscountPct}%`,
  },
  {
    key: 'maxRefundAmount',
    label: 'Refund without a signature',
    note: 'Cash back over the counter is the least reversible thing a till does.',
    render: (l) => `₹${formatAmount(l.maxRefundAmount)}`,
  },
  {
    key: 'backdateDays',
    label: 'Backdating',
    note: 'Zero means today only. A filed return is not a thing to edit quietly.',
    render: (l) => (l.backdateDays === 0 ? 'Today only' : `${l.backdateDays} day${l.backdateDays === 1 ? '' : 's'}`),
  },
  {
    key: 'canViewCost',
    label: 'Landed cost and margin',
    note: 'A second gate on top of the row above — the role can grant it and this can still say no.',
    render: (l) => (l.canViewCost ? 'Visible' : 'Hidden'),
  },
]

/**
 * The four numbers, per role.
 *
 * Shown as STARTING values with the hard ceiling beside them, because they are
 * two different promises and collapsing them into one column is how a screen
 * ends up lying: the first is what a new account is born with and may be tuned
 * down from, the second is the wall the form refuses to let anybody past.
 *
 * These are NOT editable here, and unlike the grid above that is not a position
 * anybody has to argue for: they are per person, and the person is where they
 * are edited.
 */
function LimitsBand() {
  return (
    <section className="border-t-2 border-border">
      <h3 className={cn('grid items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5', COLS)}>
        <span className="micro-label">Limits · new account starts at, ceiling in brackets</span>
        {ROLES.map((role) => (
          <span key={role} className="text-center text-2xs text-fg-subtle">{ROLE_LABEL[role]}</span>
        ))}
      </h3>

      {LIMIT_ROWS.map((row) => (
        <div key={row.key} className={cn('grid items-start gap-2 border-b border-border-subtle px-[var(--cell-px)] py-1.5', COLS)}>
          <div className="min-w-0">
            <span className="text-sm text-fg">{row.label}</span>
            <p className="mt-0.5 text-2xs text-fg-subtle">{row.note}</p>
          </div>
          {ROLES.map((role) => {
            const start = row.render(ROLE_STARTING_LIMITS[role])
            const ceiling = row.render(ROLE_CEILING[role])
            return (
              <div key={role} className="text-center">
                <div className="num text-sm text-fg">{start}</div>
                {ceiling === start ? null : (
                  <div className="num text-2xs text-fg-subtle">({ceiling})</div>
                )}
              </div>
            )
          })}
        </div>
      ))}

      <div className="px-[var(--cell-px)] py-2.5">
        <p className="max-w-[100ch] text-2xs text-fg-subtle">
          The four role NAMES are fixed even though their grants are not, because the trail
          is keyed on them: a shop that renamed “cashier” would have a register full of a
          word that no longer means what it meant last year. What a role grants is this
          shop’s business; what it is called is the record’s.
        </p>
        {/* Said plainly, because a grid of ticks is read as a set of locks. Two
            of these ids are consulted in this build; the rest are the policy the
            server will gate its routes on, and pretending otherwise is how an
            owner comes to believe a counter is fenced off when it is not. */}
        <p className="mt-1.5 max-w-[100ch] text-2xs text-fg-subtle">
          <span className="font-medium text-warning-11">This build has no sign-in.</span>{' '}
          Two of these ids are enforced here — <code className="mono">settings.users</code>{' '}
          hides this page and <code className="mono">reports.audit</code> hides the trail.
          The others are the policy each route is gated on once accounts are real; today
          they describe what a role means, not what a browser is stopped from doing. The
          edits above are kept on this device and travel to the server with the roster.
        </p>
      </div>
    </section>
  )
}
