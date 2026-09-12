import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeftRight, Plus, Search, ShieldAlert, TriangleAlert, UserPlus, UserRound, X,
} from 'lucide-react'
import type { Customer, CustomerInput, Money, SaleInvoice } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import { cn } from '@/lib/cn'
import * as D from '@/domain/decimal'
import { formatAmount, formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { ErrorState, SkeletonRows } from '@/components/states'

/**
 * The customer column: search, create and the attached record, in one place.
 *
 * Three things drive the design:
 *  - Most bills are walk-ins. The panel says so permanently, because a field that
 *    LOOKS mandatory gets filled with junk ("cash customer", "1111111111") and a
 *    junk master is worse than no master.
 *  - Creating is INLINE, never a modal. The operator is mid-bill; an overlay
 *    covers the cart they are reading the phone number off.
 *  - Allergies are a dispensing control, not a profile detail. Once a customer is
 *    attached the allergen words are on screen, spelled out, above the money.
 *
 * It binds no global shortcut on purpose: Alt+U belongs to the billing screen,
 * and two hooks claiming one key in the same scope fight. The lead points
 * `focusRef` here instead.
 */

interface Draft {
  name: string
  phone: string
  address: string
  gstin: string
  allergies: string[]
  /** Money, kept as the STRING the operator typed. Never parsed into a number. */
  creditLimit: string
}

type FieldName = 'name' | 'phone' | 'gstin' | 'creditLimit'

const EMPTY_DRAFT: Draft = {
  name: '', phone: '', address: '', gstin: '', allergies: [], creditLimit: '',
}

/** Order matters: submit focuses the FIRST invalid field, reading down the form. */
const FIELD_ORDER: FieldName[] = ['name', 'phone', 'gstin', 'creditLimit']

const PHONE_LEN = 10
const MONEY_RE = /^\d{1,9}(\.\d{1,2})?$/
/* 22AAAAA0000A1Z5 — state code, PAN, entity digit, 'Z', checksum. Worth checking
   because a wrong GSTIN on a B2B bill costs the buyer their input credit, and it
   is only ever discovered a quarter later when the return does not reconcile. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

const digitsOf = (s: string): string => s.replace(/\D/g, '')

/**
 * '+91 98220 41100', '098220 41100' and '9822041100' are one phone number, and
 * the operator types whichever the customer reads out. The server normalises the
 * same way; doing it here too means the form never rejects a number the backend
 * would have accepted.
 */
function normalizePhone(raw: string): string {
  const digits = digitsOf(raw)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

/** Digits and separators only. Nobody is named "9876543210". */
function looksLikePhone(term: string): boolean {
  const t = term.trim()
  return /^[+\d][\d\s-]*$/.test(t) && digitsOf(t).length >= 6
}

export function CustomerPanel({
  customer,
  onAttach,
  onClear,
  focusRef,
}: {
  customer: Customer | null
  onAttach: (c: Customer) => void
  onClear: () => void
  /** Opens the create form; the lead binds Alt+U to focus this panel. */
  focusRef?: React.RefObject<HTMLInputElement | null>
}) {
  const api = useApi()
  const qc = useQueryClient()

  const [mode, setMode] = useState<'search' | 'create'>('search')
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)

  /* The draft outlives Esc. An operator who backs out to check a spelling and
     comes straight back must not retype an address they already keyed in. */
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [existing, setExisting] = useState<Customer | null>(null)

  const searchInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const phoneInput = useRef<HTMLInputElement>(null)
  const gstinInput = useRef<HTMLInputElement>(null)
  const creditInput = useRef<HTMLInputElement>(null)

  /* One caller-supplied ref, two possible landing points: whichever entry field
     is on screen is the one Alt+U should reach. Only one is ever mounted. */
  const bindSearch = useCallback((el: HTMLInputElement | null) => {
    searchInput.current = el
    if (focusRef) focusRef.current = el
  }, [focusRef])
  const bindName = useCallback((el: HTMLInputElement | null) => {
    nameInput.current = el
    if (focusRef) focusRef.current = el
  }, [focusRef])

  const trimmed = term.trim()

  const results = useQuery({
    queryKey: qk.customers(trimmed),
    queryFn: () => api.searchCustomers(trimmed),
    enabled: !customer && mode === 'search' && trimmed.length > 0,
    placeholderData: (prev) => prev,
  })

  /* Every customer key hangs off one prefix so a create invalidates search,
     recents and history together — a new record that does not show up in
     "Recent" reads as a failed save and gets entered a second time. */
  const recent = useQuery({
    queryKey: ['customers', 'recent', 6],
    queryFn: () => api.recentCustomers(6),
    enabled: !customer && mode === 'search',
  })

  const list = trimmed ? (results.data ?? []) : (recent.data ?? [])
  const listBusy = trimmed ? results.isPending : recent.isPending
  const listError = trimmed ? results.error : recent.error
  /* placeholderData keeps the previous term's rows on screen so the list never
     blinks. They are not an answer about THIS term, though: reading "nothing on
     file" off them offers to create a customer who is one tick from appearing. */
  const stale = trimmed.length > 0 && results.isPlaceholderData
  const noMatch = trimmed.length > 0 && !listBusy && !stale && !listError && list.length === 0

  /* Adjusted during render, not in an effect: an effect commits the DOM once with
     a stale highlight and then re-renders to correct it, which on a list the
     operator is arrowing through shows as the selection flicking back. */
  const [lastTerm, setLastTerm] = useState(term)
  if (term !== lastTerm) {
    setLastTerm(term)
    setActive(0)
  }

  const openCreate = useCallback(() => {
    setExisting(null)
    setErrors({})
    /* Seed from the search term only when there is nothing to lose. A kept draft
       always wins over the box the operator has since typed something else into. */
    setDraft((d) => {
      if (d !== EMPTY_DRAFT) return d
      const t = trimmed
      if (!t) return d
      return looksLikePhone(t)
        ? { ...EMPTY_DRAFT, phone: normalizePhone(t).slice(0, PHONE_LEN) }
        : { ...EMPTY_DRAFT, name: t }
    })
    setMode('create')
  }, [trimmed])

  const create = useMutation({
    mutationFn: (input: CustomerInput) => api.createCustomer(input),
    onSuccess: (c) => {
      setDraft(EMPTY_DRAFT)
      setErrors({})
      setExisting(null)
      setMode('search')
      setTerm('')
      void qc.invalidateQueries({ queryKey: ['customers'] })
      toast.success(`${c.name} added`, { description: c.phone })
      onAttach(c)
    },
    onError: (err, input) => { void onCreateFailed(err, input.phone) },
  })

  const focusField = useCallback((field: FieldName) => {
    const el = { name: nameInput, phone: phoneInput, gstin: gstinInput, creditLimit: creditInput }[field]
    el.current?.focus()
  }, [])

  /**
   * A duplicate phone is not an error to report; it is the record the operator
   * was reaching for. `code` is the contract, `details` is not — so the payload is
   * read defensively and the phone (which IS the unique key) is the fallback.
   */
  const onCreateFailed = useCallback(async (err: unknown, phone: string) => {
    const code = errorCode(err)
    const message = err instanceof Error ? err.message : undefined

    if (code !== 'CUSTOMER_EXISTS') {
      /* The server holds rules this form does not mirror. When it names the
         field it rejected, the objection belongs under that field — a toast
         leaves the operator hunting for what to retype. */
      const field = code === 'CUSTOMER_INVALID' ? fieldFromDetails(errorDetails(err)) : null
      if (field && message) {
        setErrors((e) => ({ ...e, [field]: message }))
        focusField(field)
        return
      }
      toast.error('Could not save the customer', { description: message })
      return
    }

    const fromPayload = customerFromDetails(errorDetails(err))
    if (fromPayload) { setExisting(fromPayload); return }
    const found = (await api.searchCustomers(phone)).find((c) => normalizePhone(c.phone) === phone)
    if (found) setExisting(found)
    else {
      toast.error('That phone is already on file', {
        description: 'Search for it above and attach the existing customer.',
      })
    }
  }, [api, focusField])

  function onSubmit() {
    // Enter submits even while the button is disabled, and a second POST of the
    // same customer is exactly the duplicate this panel exists to prevent.
    if (create.isPending) return
    const found = validate(draft)
    setErrors(found)
    const firstBad = FIELD_ORDER.find((f) => found[f])
    if (firstBad) {
      focusField(firstBad)
      return
    }
    const gstin = draft.gstin.trim().toUpperCase()
    const address = draft.address.trim()
    create.mutate({
      name: draft.name.trim(),
      phone: normalizePhone(draft.phone),
      ...(address ? { address } : {}),
      ...(gstin ? { gstin } : {}),
      ...(draft.allergies.length ? { allergies: draft.allergies } : {}),
      ...(draft.creditLimit.trim() ? { creditLimit: draft.creditLimit.trim() } : {}),
    })
  }

  const setField = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    /* Not re-validation — the message is simply stale the moment the field moves,
       and a red line under a field the operator has already corrected is noise. */
    setErrors((e) => (key in e ? { ...e, [key]: undefined } : e))
    /* The duplicate offer is about ONE phone number. Once that number changes it
       is somebody else's record, still one click from being attached. */
    if (key === 'phone') setExisting(null)
  }, [])

  /* Both controls in the attached header unmount the button that was clicked,
     and a button that vanishes drops focus on <body> — the next Tab then starts
     again at the top of the document. Landing in the search box keeps the
     operator where the work is, and Esc from there still steps back one level. */
  const returnFocus = useRef(false)
  useEffect(() => {
    if (customer || !returnFocus.current) return
    returnFocus.current = false
    searchInput.current?.focus()
  }, [customer])

  // ------------------------------------------------------------- attached ---
  if (customer) {
    return (
      <AttachedView
        customer={customer}
        onChange={() => { setMode('search'); onClear() }}
        onRemove={onClear}
      />
    )
  }

  // --------------------------------------------------------------- create ---
  if (mode === 'create') {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <Header>
          <span className="micro-label">New customer</span>
          <div className="flex-1" />
          <WalkInChip />
        </Header>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => { e.preventDefault(); onSubmit() }}
          onKeyDown={(e) => {
            // Ctrl+Enter is "go to payment" and Ctrl+S is "save"; a modified key
            // is never this form's business. Escape is, and it must not also
            // reach the billing screen's own step-back handler.
            if (e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === 'Escape') { e.stopPropagation(); setMode('search') }
          }}
        >
          <div className="scroll-region min-h-0 flex-1 space-y-3 p-3">
            {existing && (
              <div
                role="alert"
                className="rounded-[var(--radius-md)] border border-warning-9/25 bg-warning-3 p-3"
              >
                <p className="text-sm text-warning-11">
                  <strong className="font-semibold">{existing.phone}</strong> is already on file as{' '}
                  <strong className="font-semibold">{existing.name}</strong>.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => { setDraft(EMPTY_DRAFT); setExisting(null); setMode('search'); onAttach(existing) }}
                >
                  Attach {existing.name} instead
                </Button>
              </div>
            )}

            <Field
              name="name" label="Name" required inputRef={bindName}
              value={draft.name} onChange={(v) => setField('name', v)} error={errors.name}
            />
            <Field
              name="phone" label="Phone" required inputRef={phoneInput} inputMode="numeric"
              value={draft.phone} onChange={(v) => setField('phone', v)} error={errors.phone}
              hint="10 digits — this is how the bill is found again"
            />
            <Field
              name="address" label="Address"
              value={draft.address} onChange={(v) => setField('address', v)}
            />
            <Field
              name="gstin" label="GSTIN" inputRef={gstinInput} className="mono uppercase"
              value={draft.gstin} onChange={(v) => setField('gstin', v)} error={errors.gstin}
              hint="Only for a business buyer claiming input credit"
            />
            <AllergyInput
              values={draft.allergies}
              onChange={(next) => setField('allergies', next)}
            />
            <Field
              name="creditLimit" label="Credit limit" inputRef={creditInput} inputMode="decimal"
              value={draft.creditLimit} onChange={(v) => setField('creditLimit', v)}
              error={errors.creditLimit} className="num text-left"
              hint="Leave blank for no credit"
            />
          </div>

          <div className="flex shrink-0 gap-2 border-t border-border-subtle bg-subtle p-3">
            <Button type="button" onClick={() => setMode('search')}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={create.isPending}>
              Save &amp; attach <Kbd className="border-transparent bg-white text-accent-11">↵</Kbd>
            </Button>
          </div>
        </form>
      </div>
    )
  }

  // --------------------------------------------------------------- search ---
  function commit(index: number) {
    const picked = list[index]
    if (picked) { onAttach(picked); setTerm(''); return }
    if (noMatch) openCreate()
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(active) }
    else if (e.key === 'Escape' && term) { e.stopPropagation(); setTerm('') }
  }

  const activeId = list[active] ? `customer-opt-${list[active].id}` : undefined

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Header>
        <span className="micro-label">Customer</span>
        <div className="flex-1" />
        <Kbd>Alt+U</Kbd>
      </Header>

      <div className="p-3 pb-2">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            ref={bindSearch}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onSearchKeyDown}
            role="combobox"
            aria-expanded={list.length > 0}
            aria-controls="customer-results"
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="Find customer"
            placeholder="Phone or name…"
            autoFocus={false}
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-3 text-base placeholder:text-fg-subtle hover:border-border-strong"
          />
        </div>
        {/* Pinned, so it survives a scrolled result list. */}
        <p className="mt-2 flex items-center gap-1.5 text-2xs text-fg-muted">
          <Chip icon={UserRound}>Walk-in</Chip>
          No customer is needed to bill.
        </p>
      </div>

      <div id="customer-results" role="listbox" aria-label="Customers" className="scroll-region min-h-0 flex-1 border-t border-border-subtle">
        {listError ? (
          <ErrorState
            code={errorCode(listError) ?? undefined}
            message={listError.message}
            onRetry={() => { void (trimmed ? results.refetch() : recent.refetch()) }}
          />
        ) : listBusy ? (
          <SkeletonRows rows={4} cols={2} />
        ) : (
          <>
            <SectionLabel>{trimmed ? 'Matches' : 'Recent'}</SectionLabel>
            {list.map((c, i) => (
              <CustomerRow
                key={c.id}
                customer={c}
                active={i === active}
                onPick={() => commit(i)}
                onHover={() => setActive(i)}
              />
            ))}
            {noMatch && <CreateAffordance term={trimmed} onCreate={openCreate} />}
            {!trimmed && list.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                No customers billed yet. Type a phone number to add one.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ parts ---

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
      {children}
    </div>
  )
}

function WalkInChip() {
  return <Chip icon={UserRound}>Walk-in still allowed</Chip>
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 border-b border-border-subtle bg-subtle px-3 py-1">
      <span className="micro-label">{children}</span>
    </div>
  )
}

function CustomerRow({ customer, active, onPick, onHover }: {
  customer: Customer
  active: boolean
  onPick: () => void
  onHover: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const owes = isPositive(customer.outstanding)

  return (
    <div
      ref={ref}
      id={`customer-opt-${customer.id}`}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => { e.preventDefault(); onPick() }}
      onMouseEnter={onHover}
      className={cn(
        'relative flex cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2',
        active ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-base font-medium', active && 'text-accent-11')}>
          {customer.name}
        </div>
        <div className="mono text-xs text-fg-muted">{customer.phone}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {owes && <span className="num text-sm text-warning-11">{formatAmount(customer.outstanding)}</span>}
        {customer.allergies.length > 0 && (
          <Chip icon={ShieldAlert} tone="var(--danger-11)">
            {customer.allergies.length} allerg{customer.allergies.length === 1 ? 'y' : 'ies'}
          </Chip>
        )}
      </div>
    </div>
  )
}

/**
 * The counter is holding a phone number that matched nothing. That is the whole
 * reason to create a record, so the affordance carries the number itself and
 * takes the primary weight — a phone-shaped term is never a typo worth hiding.
 */
function CreateAffordance({ term, onCreate }: { term: string; onCreate: () => void }) {
  const phone = looksLikePhone(term)
  return (
    <div className="p-3">
      <p className="mb-2 text-sm text-fg-muted">
        Nothing on file for “<span className={phone ? 'mono' : undefined}>{term}</span>”.
      </p>
      <Button
        variant={phone ? 'primary' : 'secondary'}
        className="w-full"
        onClick={onCreate}
      >
        {phone ? <UserPlus /> : <Plus />} Create {term}
      </Button>
    </div>
  )
}

function Field({
  name, label, value, onChange, error, hint, required, inputRef, inputMode, className,
}: {
  name: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string | undefined
  hint?: string
  required?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  inputMode?: 'numeric' | 'decimal'
  className?: string
}) {
  const id = `customer-${name}`
  return (
    <div>
      <label htmlFor={id} className="micro-label mb-1 block">
        {label}{required && <span className="text-danger-9"> *</span>}
      </label>
      <input
        id={id}
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(
          'h-9 w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-base',
          error ? 'border-danger-9' : 'border-border hover:border-border-strong',
          className,
        )}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger-11">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-2xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * Allergens are typed as words, not picked from a list — the counter hears
 * "sulpha drugs" and must be able to write exactly that.
 */
function AllergyInput({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState('')

  function add() {
    const v = text.trim()
    if (!v) return
    setText('')
    // "penicillin" and "Penicillin" are one allergy; two chips would read as two.
    if (values.some((a) => a.toLowerCase() === v.toLowerCase())) return
    onChange([...values, v])
  }

  return (
    <div>
      <label htmlFor="customer-allergies" className="micro-label mb-1 block">Allergies</label>
      <div className="flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-1 focus-within:border-border-strong">
        {values.map((a) => (
          <span
            key={a}
            className="inline-flex h-6 items-center gap-1 rounded-[var(--radius-sm)] bg-danger-3 pl-2 pr-1 text-xs text-danger-11"
          >
            {a}
            <button
              type="button"
              aria-label={`Remove ${a}`}
              onClick={() => onChange(values.filter((x) => x !== a))}
              className="text-danger-11 hover:text-danger-11"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          id="customer-allergies"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === ',') { e.preventDefault(); add() }
            // An empty field lets Enter through to submit the form; only a
            // half-typed allergen claims the key.
            else if (e.key === 'Enter' && text.trim()) { e.preventDefault(); add() }
            else if (e.key === 'Backspace' && text === '' && values.length > 0) {
              e.preventDefault()
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={() => { add() }}
          placeholder={values.length === 0 ? 'Penicillin, sulpha…' : ''}
          autoComplete="off"
          className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-base placeholder:text-fg-subtle"
        />
      </div>
      <p className="mt-1 text-2xs text-fg-subtle">Enter or comma adds one · Backspace removes the last</p>
    </div>
  )
}

// --------------------------------------------------------------- attached ---

function AttachedView({ customer, onChange, onRemove }: {
  customer: Customer
  onChange: () => void
  onRemove: () => void
}) {
  const api = useApi()
  const meter = useMemo(
    () => creditMeter(customer.outstanding, customer.creditLimit),
    [customer.outstanding, customer.creditLimit],
  )

  const bills = useQuery({
    queryKey: ['customers', 'history', customer.id, 5],
    queryFn: () => api.customerHistory(customer.id, 5),
  })

  const owes = isPositive(customer.outstanding)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Header>
        <span className="micro-label">Customer</span>
        <div className="flex-1" />
        {/* Two verbs, not one: "change" is on the way to someone else and hands
            focus back to the search box; "remove" means this bill is a walk-in. */}
        <Button size="sm" variant="ghost" onClick={onChange}>
          <ArrowLeftRight /> Change
        </Button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove customer"
          className="text-fg-subtle hover:text-fg"
        >
          <X size={15} aria-hidden />
        </button>
      </Header>

      <div className="scroll-region min-h-0 flex-1">
        <div className="p-3">
          <div className="text-lg font-medium leading-tight">{customer.name}</div>
          <div className="mono mt-0.5 text-sm text-fg-muted">{customer.phone}</div>
          {customer.gstin && (
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="micro-label">GSTIN</span>
              <span className="mono text-xs">{customer.gstin}</span>
            </div>
          )}
        </div>

        {/* Above the money, never below it: this is the one thing on the panel
            that can hurt somebody. */}
        {customer.allergies.length > 0 && (
          <div
            role="note"
            data-testid="allergy-strip"
            className="mx-3 mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-2.5 py-2"
          >
            <ShieldAlert size={16} className="mt-px shrink-0 text-danger-9" aria-hidden />
            <div className="text-sm text-danger-11">
              <div className="font-semibold">Allergic to</div>
              <div>{customer.allergies.join(', ')}</div>
            </div>
          </div>
        )}

        <div className="mx-3 mb-3 rounded-[var(--radius-md)] border border-border-subtle p-2.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-fg-muted">Outstanding</span>
            <span className={cn('num font-medium', owes ? toneText(meter?.tone ?? 'near') : 'text-fg')}>
              {formatMoney(customer.outstanding)}
            </span>
          </div>

          {meter ? (
            <div className="mt-2">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-fg-muted">Credit limit</span>
                <span className="num">{formatAmount(customer.creditLimit)}</span>
              </div>
              <div
                role="meter"
                aria-label="Credit used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={meter.valueNow}
                aria-valuetext={meter.word}
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-[var(--radius-full)]"
                style={{ backgroundColor: meter.track }}
              >
                <div
                  className="h-full rounded-[var(--radius-full)]"
                  style={{ width: `${meter.width}%`, backgroundColor: meter.fill }}
                />
              </div>
              {/* The bar carries severity; the word carries the meaning. Colour
                  alone would be invisible to a red-blind pharmacist at an angle. */}
              <p className={cn('mt-1 flex items-center gap-1 text-2xs', toneText(meter.tone))}>
                {meter.tone === 'over' && <TriangleAlert size={11} aria-hidden />}
                {meter.word}
              </p>
            </div>
          ) : (
            <p className="mt-1.5 text-2xs text-fg-subtle">No credit limit set — cash or UPI only.</p>
          )}
        </div>

        <SectionLabel>Recent purchases</SectionLabel>
        {bills.error ? (
          <ErrorState
            code={errorCode(bills.error) ?? undefined}
            message={bills.error.message}
            onRetry={() => { void bills.refetch() }}
          />
        ) : bills.isPending ? (
          <SkeletonRows rows={3} cols={3} />
        ) : bills.data.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-fg-muted">
            First purchase on this account.
          </p>
        ) : (
          bills.data.map((inv) => <HistoryRow key={inv.id} invoice={inv} />)
        )}
      </div>
    </div>
  )
}

function HistoryRow({ invoice }: { invoice: SaleInvoice }) {
  const items = invoice.quote.lines.length
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="mono truncate text-xs">{invoice.invoiceNo}</div>
        <div className="text-2xs text-fg-subtle">
          {formatBillDate(invoice.invoiceDate)} · {items} item{items === 1 ? '' : 's'}
        </div>
      </div>
      <span className="num text-sm font-medium">{formatAmount(invoice.quote.netAmount)}</span>
    </div>
  )
}

// ---------------------------------------------------------------- helpers ---

function formatBillDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

/* `dec` throws on anything that is not a decimal string, which is the right
   behaviour for arithmetic and the wrong one for a panel that must still render
   when a record is half-migrated. */
function parseMoney(v: string): D.Decimal | null {
  try {
    return D.dec(v)
  } catch {
    return null
  }
}

function isPositive(v: Money): boolean {
  const d = parseMoney(v)
  return d !== null && D.gt(d, D.ZERO)
}

type Tone = 'ok' | 'near' | 'over'

function toneText(tone: Tone): string {
  return tone === 'over' ? 'text-danger-11' : tone === 'near' ? 'text-warning-11' : 'text-fg-muted'
}

interface Meter {
  tone: Tone
  word: string
  width: number
  valueNow: number
  fill: string
  track: string
}

/**
 * Credit used against the limit.
 *
 * The fill is the severity step of a ramp and the track is the light step of the
 * SAME ramp, so the bar reads as one object rather than two competing colours.
 * A missing or zero limit gets no meter at all: a bar with no maximum is a lie.
 */
function creditMeter(outstanding: Money, limit: Money): Meter | null {
  const used = parseMoney(outstanding)
  const cap = parseMoney(limit)
  if (!used || !cap || !D.gt(cap, D.ZERO)) return null

  const pct = D.toNumber(D.div(D.mul(used, D.HUNDRED), cap))
  const valueNow = Math.max(0, Math.round(pct))
  const width = Math.min(100, Math.max(0, pct))

  if (D.gt(used, cap)) {
    return {
      tone: 'over', width: 100, valueNow,
      word: `Over limit by ${formatMoney(D.toStr(D.sub(used, cap)))}`,
      fill: 'var(--danger-9)', track: 'var(--danger-3)',
    }
  }
  if (pct >= 75) {
    return {
      tone: 'near', width, valueNow,
      word: `Close to limit · ${valueNow}% used`,
      fill: 'var(--warning-9)', track: 'var(--warning-3)',
    }
  }
  return {
    tone: 'ok', width, valueNow,
    word: `${valueNow}% of limit used`,
    fill: 'var(--success-9)', track: 'var(--success-3)',
  }
}

function validate(draft: Draft): Partial<Record<FieldName, string>> {
  const found: Partial<Record<FieldName, string>> = {}
  if (draft.name.trim() === '') found.name = 'A name is required.'

  const phone = normalizePhone(draft.phone)
  if (phone === '') found.phone = 'A phone number is required.'
  else if (phone.length !== PHONE_LEN) {
    found.phone = `${phone.length} digit${phone.length === 1 ? '' : 's'} — a phone number needs ${PHONE_LEN}.`
  }

  const gstin = draft.gstin.trim().toUpperCase()
  if (gstin !== '' && !GSTIN_RE.test(gstin)) found.gstin = 'That is not a valid 15-character GSTIN.'

  const credit = draft.creditLimit.trim()
  if (credit !== '' && !MONEY_RE.test(credit)) found.creditLimit = 'Amount in rupees, e.g. 5000 or 5000.50.'

  return found
}

function errorCode(err: unknown): string | null {
  if (err instanceof ApiError) return err.code
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/** `details: { field: 'phone' }` — the server pointing at the box to fix. */
function fieldFromDetails(details: unknown): FieldName | null {
  if (typeof details !== 'object' || details === null || !('field' in details)) return null
  const field = (details as { field: unknown }).field
  return typeof field === 'string' && (FIELD_ORDER as string[]).includes(field)
    ? (field as FieldName)
    : null
}

function errorDetails(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && 'details' in err) {
    return (err as { details: unknown }).details
  }
  return null
}

/**
 * Read a customer out of an error payload.
 *
 * Everything absent is defaulted rather than trusted: a missing `allergies`
 * array would crash the very strip that exists to stop a dispensing mistake.
 */
function customerFromDetails(details: unknown): Customer | null {
  if (typeof details !== 'object' || details === null) return null
  const bag = details as Record<string, unknown>
  const inner = bag.customer
  const src = (typeof inner === 'object' && inner !== null ? inner : bag) as Record<string, unknown>

  const id = src.id
  const name = src.name
  const phone = src.phone
  if (typeof id !== 'number' || typeof name !== 'string' || typeof phone !== 'string') return null

  return {
    id,
    storeId: typeof src.storeId === 'number' ? src.storeId : 0,
    name,
    phone,
    address: typeof src.address === 'string' ? src.address : null,
    gstin: typeof src.gstin === 'string' ? src.gstin : null,
    allergies: Array.isArray(src.allergies)
      ? src.allergies.filter((a): a is string => typeof a === 'string')
      : [],
    creditLimit: typeof src.creditLimit === 'string' ? src.creditLimit : '0.00',
    outstanding: typeof src.outstanding === 'string' ? src.outstanding : '0.00',
  }
}
