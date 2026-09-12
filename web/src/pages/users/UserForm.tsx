import { useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useMutation } from '@tanstack/react-query'
import { Check, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { Role, User, UserInput, UserLimits } from '@contract'
import { ApiError, ROLES } from '@contract'
import { useApi } from '@/api'
import { ROLE_BLURB, ROLE_CEILING, ROLE_LABEL, ROLE_STARTING_LIMITS, prepareLimits } from '@/api/users'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * One account: who they are, what role, and the four numbers that bound them.
 *
 * It follows the supplier form's contract exactly — validate on SUBMIT, never
 * per keystroke; put every objection under the field it belongs to; focus the
 * first invalid field reading down the form — because those rules are what let
 * a record be keyed without looking at it, and a second dialect of them in the
 * same app is worse than a worse one.
 *
 * THERE IS NO PASSWORD FIELD, AND THAT IS DELIBERATE.
 *
 * This is a demo UI over a mock backend that stores its records as JSON in the
 * browser. A password box here could not do the one thing a password box is
 * for: nothing on this side of the wire may hash, salt, store, rotate or
 * transmit a credential, so whatever was typed would sit in IndexedDB in the
 * clear next to the roster. That is security theatre — worse than an absent
 * field, because it teaches an operator that the thing is protected. Phase 5
 * issues credentials server-side, and the screen that does it will be a
 * different screen with a different threat model.
 *
 * Two fields carry more than they look like they do:
 *
 *  - REGISTRATION NUMBER is not a personnel detail. A prescription sale is
 *    dispensed under a named registered pharmacist and that number is printed
 *    on the bill, so it belongs on the person rather than being retyped at the
 *    counter — which is also how a register ends up with four spellings of one
 *    pharmacist.
 *  - THE LIMITS are the actual control. The role says a cashier may discount;
 *    the number says how far, and the gap between the number and the ask is
 *    exactly where a manager's signature lives.
 */

type FieldName =
  | 'name' | 'username' | 'role' | 'pharmacistRegNo'
  | 'maxDiscountPct' | 'maxRefundAmount' | 'backdateDays' | 'canViewCost' | 'isActive'

/** Reading order. Submit focuses the first invalid field going down the form. */
const FIELD_ORDER: FieldName[] = [
  'name', 'username', 'role', 'pharmacistRegNo',
  'maxDiscountPct', 'maxRefundAmount', 'backdateDays', 'canViewCost', 'isActive',
]

interface Draft {
  name: string
  username: string
  role: Role
  pharmacistRegNo: string
  /** Kept as the typed STRINGS until submit; a half-typed "1" is not 1 day. */
  maxDiscountPct: string
  maxRefundAmount: string
  backdateDays: string
  canViewCost: boolean
  isActive: boolean
}

function draftFor(role: Role): Draft {
  const l = ROLE_STARTING_LIMITS[role]
  return {
    name: '',
    username: '',
    role,
    pharmacistRegNo: '',
    maxDiscountPct: l.maxDiscountPct,
    maxRefundAmount: l.maxRefundAmount,
    backdateDays: String(l.backdateDays),
    canViewCost: l.canViewCost,
    isActive: true,
  }
}

function draftFrom(u: User): Draft {
  return {
    name: u.name,
    username: u.username,
    role: u.role,
    pharmacistRegNo: u.pharmacistRegNo ?? '',
    maxDiscountPct: u.limits.maxDiscountPct,
    maxRefundAmount: u.limits.maxRefundAmount,
    backdateDays: String(u.limits.backdateDays),
    canViewCost: u.limits.canViewCost,
    isActive: u.isActive,
  }
}

function limitsOf(d: Draft): UserLimits {
  return {
    maxDiscountPct: d.maxDiscountPct.trim(),
    maxRefundAmount: d.maxRefundAmount.trim(),
    /* NaN rather than 0 on a blank box: `prepareLimits` rejects it, where zero
       would be filed as the real and very different answer "today only". */
    backdateDays: d.backdateDays.trim() === '' ? Number.NaN : Number(d.backdateDays.trim()),
    canViewCost: d.canViewCost,
  }
}

function toInput(d: Draft): UserInput {
  return {
    name: d.name.trim(),
    username: d.username.trim().toLowerCase(),
    role: d.role,
    pharmacistRegNo: d.pharmacistRegNo.trim(),
    limits: limitsOf(d),
    isActive: d.isActive,
  }
}

// -------------------------------------------------------------- validation ---

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,19}$/
const LIMIT_FIELDS = new Set<string>(['maxDiscountPct', 'maxRefundAmount', 'backdateDays', 'canViewCost'])

/**
 * The identity checks are restated here; the LIMITS are not.
 *
 * Emptiness and shape are cheap to mirror and worth mirroring, because the
 * operator should see all of them at once rather than one per round trip. The
 * ceilings are not mirrored: `prepareLimits` is the single definition of what a
 * role may be tuned to, and a second copy of "a cashier may not exceed 10%"
 * would be one copy that drifts. It is called directly instead, in the same
 * shape the adapter calls it.
 */
function validate(d: Draft, others: readonly User[]): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {}

  if (d.name.trim() === '') e.name = 'A name is required — it is what the audit trail prints.'

  const username = d.username.trim().toLowerCase()
  if (username === '') e.username = 'Required. This is what the trail is keyed on.'
  else if (!USERNAME_RE.test(username)) {
    e.username = '3–20 characters: lowercase letters, digits, dot, dash or underscore.'
  } else {
    const clash = others.find((u) => u.username === username)
    if (clash) e.username = `${clash.name} already signs in as ${username}.`
  }

  if (d.role === 'pharmacist' && d.pharmacistRegNo.trim() === '') {
    e.pharmacistRegNo = 'A pharmacist dispenses under their registration number, and it goes on the bill.'
  }

  try {
    prepareLimits(limitsOf(d), d.role)
  } catch (err) {
    if (err instanceof ApiError) {
      const field = fieldFrom(err.details)
      if (field && LIMIT_FIELDS.has(field)) e[field] = err.message
      else e.maxDiscountPct = err.message
    }
  }

  return e
}

/** Shown, never blocking: the save would succeed, and cost something later. */
function advice(d: Draft): Partial<Record<FieldName, string>> {
  const a: Partial<Record<FieldName, string>> = {}
  if (d.role !== 'pharmacist' && d.pharmacistRegNo.trim() === '') {
    a.pharmacistRegNo = 'Optional here. Fill it in if this person is themselves registered — owners usually are.'
  }
  if (d.role === 'admin') {
    a.role = 'An admin can change everybody’s limits, including their own. Give it to as few people as the shop can run on.'
  }
  return a
}

const FIELD_NAMES = new Set<string>(FIELD_ORDER)

/** `details: { field: 'username' }` — the backend pointing at the box to fix. */
function fieldFrom(details: unknown): FieldName | null {
  if (typeof details !== 'object' || details === null) return null
  const raw = (details as { field?: unknown }).field
  return typeof raw === 'string' && FIELD_NAMES.has(raw) ? (raw as FieldName) : null
}

// -------------------------------------------------------------------- form ---

export function UserForm({
  open,
  onOpenChange,
  editing,
  users,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** null creates; a user edits it. */
  editing: User | null
  /** The whole roster — the username check needs it before the round trip. */
  users: readonly User[]
  onSaved: (u: User, created: boolean) => void
}) {
  const api = useApi()
  useHotkeys('modal', {}, { enabled: open })

  const [draft, setDraft] = useState<Draft>(editing ? draftFrom(editing) : draftFor('cashier'))
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})

  /* Seeded from whichever record the dialog was opened on, adjusted during
     render rather than in an effect so the first paint is already right. `open`
     is in the identity so a second "New user" starts empty rather than resuming
     a create somebody abandoned an hour ago. */
  const identity = `${String(open)}:${editing ? `edit-${editing.id}` : 'create'}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    if (open) {
      setDraft(editing ? draftFrom(editing) : draftFor('cashier'))
      setErrors({})
    }
  }

  const nameRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const roleRef = useRef<HTMLSelectElement>(null)
  const regRef = useRef<HTMLInputElement>(null)
  const discountRef = useRef<HTMLInputElement>(null)
  const refundRef = useRef<HTMLInputElement>(null)
  const backdateRef = useRef<HTMLInputElement>(null)
  const costRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLInputElement>(null)

  const others = editing ? users.filter((u) => u.id !== editing.id) : users

  function focusFirstError(found: Partial<Record<FieldName, string>>) {
    const byField: Record<FieldName, { current: HTMLElement | null }> = {
      name: nameRef,
      username: usernameRef,
      role: roleRef,
      pharmacistRegNo: regRef,
      maxDiscountPct: discountRef,
      maxRefundAmount: refundRef,
      backdateDays: backdateRef,
      canViewCost: costRef,
      isActive: activeRef,
    }
    const first = FIELD_ORDER.find((f) => found[f])
    if (first) byField[first].current?.focus()
  }

  const save = useMutation({
    mutationFn: async (input: UserInput): Promise<{ user: User; created: boolean }> => {
      if (editing) return { user: await api.updateUser(editing.id, input), created: false }
      return { user: await api.createUser(input), created: true }
    },
    onSuccess: ({ user, created }) => {
      onSaved(user, created)
      onOpenChange(false)
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return
      /* The backend validates the same record again and its answer is
         per-field. Dropping that into a banner would leave the operator
         hunting for which box it meant. */
      const field = fieldFrom(err.details)
      if (field) {
        setErrors((prev) => ({ ...prev, [field]: err.message }))
        focusFirstError({ [field]: err.message })
      }
    },
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Enter submits even while the button is disabled, and a second POST of the
    // same person is exactly the duplicate this check exists to prevent.
    if (save.isPending) return
    const found = validate(draft, others)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      focusFirstError(found)
      return
    }
    save.mutate(toInput(draft))
  }

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    /* Not re-validation — the message is simply stale the moment the field
       moves, and a red line under a box already corrected is noise. */
    setErrors((prev) => {
      const keys = Object.keys(patch) as FieldName[]
      if (!keys.some((k) => k in prev)) return prev
      const next = { ...prev }
      for (const k of keys) delete next[k]
      return next
    })
  }

  /**
   * A role change re-seeds the four numbers.
   *
   * The alternative is the demotion hole: move a manager to the cashier's till
   * and their 20% ceiling follows them there, because neither field is wrong on
   * its own. The adapter does the same thing on its side, so what is shown here
   * is what will be saved rather than a friendly approximation of it.
   */
  const changeRole = (role: Role) => {
    const l = ROLE_STARTING_LIMITS[role]
    set({
      role,
      maxDiscountPct: l.maxDiscountPct,
      maxRefundAmount: l.maxRefundAmount,
      backdateDays: String(l.backdateDays),
      canViewCost: l.canViewCost,
    })
  }

  const hints = advice(draft)
  const ceiling = ROLE_CEILING[draft.role]

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 660 }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">
              {editing ? `Edit ${editing.name}` : 'New user'}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              The role decides what this person can reach. The four numbers below decide
              how far they can go before somebody else has to sign.
            </Dialog.Description>
          </div>

          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="scroll-region min-h-0 flex-1 p-4">
              {save.error && !(save.error instanceof ApiError && fieldFrom(save.error.details)) ? (
                <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/30 bg-danger-3 px-3 py-2 text-sm text-danger-11">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    {(save.error as Error).message}
                    {save.error instanceof ApiError ? (
                      <span className="mono ml-2 text-2xs">{save.error.code}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <Group title="Identity">
                <Field label="Name" required error={errors.name} className="col-span-2">
                  <input
                    ref={nameRef}
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="Rekha Pawar"
                    className={inputCls(errors.name)}
                    autoFocus
                    autoComplete="off"
                  />
                </Field>
                <Field label="Username" required error={errors.username} hint="Lowercase, no spaces">
                  <input
                    ref={usernameRef}
                    value={draft.username}
                    onChange={(e) => set({ username: e.target.value.toLowerCase() })}
                    placeholder="rekha"
                    className={cn(inputCls(errors.username), 'mono')}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <Field label="Role" required error={errors.role} advice={hints.role}>
                  <select
                    ref={roleRef}
                    value={draft.role}
                    onChange={(e) => changeRole(e.target.value as Role)}
                    className={inputCls(errors.role)}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </Field>
                <Field
                  label="Pharmacist reg. no."
                  required={draft.role === 'pharmacist'}
                  error={errors.pharmacistRegNo}
                  advice={hints.pharmacistRegNo}
                  hint="Printed on prescription bills"
                  className="col-span-2"
                >
                  <input
                    ref={regRef}
                    value={draft.pharmacistRegNo}
                    onChange={(e) => set({ pharmacistRegNo: e.target.value })}
                    placeholder="MSPC/2020/044120"
                    className={cn(inputCls(errors.pharmacistRegNo), 'mono')}
                    autoComplete="off"
                  />
                </Field>

                <p className="col-span-3 -mt-1 text-2xs text-fg-subtle">{ROLE_BLURB[draft.role]}</p>
              </Group>

              <Group
                title="Limits"
                note={`Ceilings for a ${ROLE_LABEL[draft.role].toLowerCase()} in brackets`}
              >
                <Field
                  label="Max discount"
                  required
                  error={errors.maxDiscountPct}
                  hint={`% · up to ${ceiling.maxDiscountPct}`}
                >
                  <input
                    ref={discountRef}
                    value={draft.maxDiscountPct}
                    onChange={(e) => set({ maxDiscountPct: e.target.value })}
                    inputMode="decimal"
                    className={cn(inputCls(errors.maxDiscountPct), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Max refund"
                  required
                  error={errors.maxRefundAmount}
                  hint={`₹ · up to ${formatAmount(ceiling.maxRefundAmount)}`}
                >
                  <input
                    ref={refundRef}
                    value={draft.maxRefundAmount}
                    onChange={(e) => set({ maxRefundAmount: e.target.value })}
                    inputMode="decimal"
                    className={cn(inputCls(errors.maxRefundAmount), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Backdate"
                  required
                  error={errors.backdateDays}
                  hint={ceiling.backdateDays === 0 ? 'Days · today only' : `Days · up to ${ceiling.backdateDays}`}
                >
                  <input
                    ref={backdateRef}
                    value={draft.backdateDays}
                    onChange={(e) => set({ backdateDays: e.target.value })}
                    inputMode="numeric"
                    className={cn(inputCls(errors.backdateDays), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>

                <Toggle
                  ref={costRef}
                  label="Sees landed cost, purchase rates and margin"
                  checked={draft.canViewCost}
                  disabled={!ceiling.canViewCost}
                  onChange={(v) => set({ canViewCost: v })}
                  note={ceiling.canViewCost
                    ? 'A second gate on top of the role. Switch it off for a new joiner and the margin report goes with it.'
                    : `Not available to a ${ROLE_LABEL[draft.role].toLowerCase()} at any setting.`}
                  error={errors.canViewCost}
                />

                <Toggle
                  ref={activeRef}
                  label="Account is active"
                  checked={draft.isActive}
                  onChange={(v) => set({ isActive: v })}
                  note="Disabling keeps the person on every bill and every trail entry they touched. Accounts are never deleted."
                  error={errors.isActive}
                />
              </Group>

              <NoPasswordNote />
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-4 py-3">
              <span className="text-2xs text-fg-subtle">
                <Kbd>↵</Kbd> saves · <Kbd>Esc</Kbd> closes
              </span>
              <span className="ml-auto flex gap-2">
                <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={save.isPending}>
                  <Check /> {editing ? 'Save changes' : 'Create user'}
                </Button>
              </span>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ------------------------------------------------------------------ pieces ---

/** Says out loud what is missing and why, rather than leaving a hole. */
function NoPasswordNote() {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-3 py-2">
      <KeyRound size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
      <p className="text-2xs text-fg-muted">
        <span className="font-medium text-fg">No password is set here.</span>{' '}
        This build stores its records in the browser, so anything typed into a password
        box would sit beside the roster in the clear — a lock drawn on the door rather
        than fitted to it. Credentials are issued server-side, on a screen that can
        actually hash and rotate one.
      </p>
    </div>
  )
}

function inputCls(error?: string): string {
  return cn(
    'h-[var(--control-h)] w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-base',
    error ? 'border-danger-9' : 'border-border hover:border-border-strong',
  )
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <header className="mb-2 flex items-baseline gap-2 border-b border-border-subtle pb-1">
        <h3 className="micro-label">{title}</h3>
        {note ? <span className="text-2xs text-fg-subtle">{note}</span> : null}
      </header>
      <div className="grid grid-cols-3 gap-3">{children}</div>
    </section>
  )
}

function Field({
  label, required, hint, error, advice: adviceText, className, children,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  advice?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label className="block">
        <span className="mb-1 flex items-baseline gap-1.5">
          <span className="micro-label">
            {label}{required ? <span className="text-danger-9"> *</span> : null}
          </span>
          {hint && !error ? <span className="text-2xs text-fg-subtle">{hint}</span> : null}
        </span>
        {children}
      </label>
      {error ? <span className="mt-1 block text-2xs text-danger-11">{error}</span> : null}
      {!error && adviceText ? <span className="mt-1 block text-2xs text-warning-11">{adviceText}</span> : null}
    </div>
  )
}

function Toggle({
  ref, label, note, checked, disabled, onChange, error,
}: {
  ref: React.RefObject<HTMLInputElement | null>
  label: string
  note: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  error?: string
}) {
  return (
    <div className="col-span-3">
      <label className={cn('flex items-start gap-2', disabled && 'opacity-60')}>
        <input
          ref={ref}
          type="checkbox"
          checked={checked && !disabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--accent-9)]"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm text-fg">
            {label}
            {disabled ? <ShieldAlert size={12} className="text-fg-subtle" aria-hidden /> : null}
          </span>
          <span className="mt-0.5 block text-2xs text-fg-subtle">{note}</span>
        </span>
      </label>
      {error ? <span className="mt-1 block text-2xs text-danger-11">{error}</span> : null}
    </div>
  )
}
