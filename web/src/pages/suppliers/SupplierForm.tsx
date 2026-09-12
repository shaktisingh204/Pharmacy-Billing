import { useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useMutation } from '@tanstack/react-query'
import { ArrowRight, Check, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ApiAdapter, InventoryPurchasesApi, Supplier, SupplierInput } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { daysUntil } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * Create and edit one distributor.
 *
 * It follows the customer panel's contract exactly — validate on SUBMIT, never
 * per keystroke; put every objection under the field it belongs to; focus the
 * first invalid field reading down the form — because those rules are what let
 * an operator key a record without looking at it, and a second dialect of them
 * in the same app is worse than a worse one.
 *
 * Three fields carry more than they look like they do:
 *
 *  - DL NUMBER is not decoration. The supplier's drug licence has to appear on
 *    every purchase bill the shop keeps, so a blank one is flagged — as advice,
 *    not as a refusal, since the number often arrives a day after the goods do.
 *  - GSTIN is optional and CHECKED. A wrong one is not discovered until the
 *    quarter's 2B fails to reconcile, and by then the input credit on every
 *    bill from this distributor is in question.
 *  - PAYMENT TERMS is the input to the ageing on every other screen. Zero is a
 *    real answer (cash on delivery), which is why the box may not be left to
 *    mean "unknown".
 */

type FieldName =
  | 'name' | 'phone' | 'gstin' | 'dlNo' | 'dlValidUpto' | 'paymentTermsDays' | 'creditLimit'

/** Reading order. Submit focuses the first invalid field going down the form. */
const FIELD_ORDER: FieldName[] = [
  'name', 'phone', 'gstin', 'dlNo', 'dlValidUpto', 'paymentTermsDays', 'creditLimit',
]

interface Draft {
  name: string
  phone: string
  address: string
  gstin: string
  dlNo: string
  /** ISO `YYYY-MM-DD`, straight off a native date input. */
  dlValidUpto: string
  /** Kept as the typed STRING until submit; a half-typed "3" is not 3 days. */
  paymentTermsDays: string
  /** Money, as the operator typed it. Never parsed into a JS number. */
  creditLimit: string
}

const EMPTY: Draft = {
  name: '', phone: '', address: '', gstin: '', dlNo: '', dlValidUpto: '',
  paymentTermsDays: '', creditLimit: '',
}

function draftFrom(s: Supplier): Draft {
  return {
    name: s.name,
    phone: s.phone,
    address: s.address ?? '',
    gstin: s.gstin ?? '',
    dlNo: s.dlNo ?? '',
    dlValidUpto: s.dlValidUpto ?? '',
    paymentTermsDays: String(s.paymentTermsDays),
    creditLimit: s.creditLimit,
  }
}

// -------------------------------------------------------------- validation ---

const PHONE_LEN = 10
const MONEY_RE = /^\d{1,9}(\.\d{1,2})?$/
const INT_RE = /^\d{1,3}$/
/* 22AAAAA0000A1Z5 — state code, PAN, entity digit, 'Z', checksum. Character for
   character the rule the customer panel applies, so one GSTIN cannot be legal on
   a customer and rejected on a supplier. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/

/* 01-38 are the assigned states and union territories; 97 is "other territory"
   and 99 is the centre. Nothing else has ever been issued, and a transposed
   leading pair is the commonest way a hand-copied GSTIN goes wrong. */
function validStateCode(gstin: string): boolean {
  const code = Number(gstin.slice(0, 2))
  return (code >= 1 && code <= 38) || code === 97 || code === 99
}

const digitsOf = (s: string): string => s.replace(/\D/g, '')

/**
 * '+91 98220 41100', '098220 41100' and '9822041100' are one phone number, and
 * a distributor's letterhead prints whichever it likes. Normalised the same way
 * the customer panel does it, so the two masters agree on what a number is.
 */
function normalizePhone(raw: string): string {
  const digits = digitsOf(raw)
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

function validate(d: Draft): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {}

  if (d.name.trim() === '') e.name = 'A distributor name is required.'

  const phone = normalizePhone(d.phone)
  if (phone === '') e.phone = 'A phone number is required — this is who gets called when stock runs out.'
  else if (phone.length !== PHONE_LEN) {
    e.phone = `${phone.length} digit${phone.length === 1 ? '' : 's'} — a phone number needs ${PHONE_LEN}.`
  }

  const gstin = d.gstin.trim().toUpperCase()
  if (gstin !== '') {
    if (!GSTIN_RE.test(gstin)) e.gstin = 'That is not a valid 15-character GSTIN.'
    else if (!validStateCode(gstin)) {
      e.gstin = `${gstin.slice(0, 2)} is not a state code — the first two digits are 01–38, 97 or 99.`
    }
  }

  /* Required, and blank is not zero. Left empty it would be filed as 0 credit
     days, which makes every bill from this distributor read as past terms the
     day after it is raised — a false alarm on the payables screen that a buyer
     acts on. "Cash on delivery" is a keystroke; "unknown" must not be one. */
  const terms = d.paymentTermsDays.trim()
  if (terms === '') {
    e.paymentTermsDays = 'Required — the ageing is measured against it. Type 0 for cash on delivery.'
  } else if (!INT_RE.test(terms) || Number(terms) > 365) {
    e.paymentTermsDays = 'Whole days, 0 to 365. Zero means paid on delivery.'
  }

  const limit = d.creditLimit.trim()
  if (limit !== '' && !MONEY_RE.test(limit)) {
    e.creditLimit = 'Amount in rupees, e.g. 50000 or 50000.50.'
  }

  /* A licence expiry that does not survive a round trip through the calendar —
     2027-02-30, say — would sort correctly, render as a date, and silently
     never expire. The renewal alarm this field exists for would not fire. */
  const valid = d.dlValidUpto.trim()
  if (valid !== '' && !isCalendarDate(valid)) {
    e.dlValidUpto = 'Use a real date — the day the licence stops being valid.'
  }

  return e
}

function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00`)
  if (Number.isNaN(d.getTime())) return false
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return back === v
}

/** Shown, never blocking: true today, and a problem only later. */
function advice(d: Draft): Partial<Record<FieldName, string>> {
  const a: Partial<Record<FieldName, string>> = {}
  if (d.dlNo.trim() === '') {
    a.dlNo = 'Every purchase bill has to carry it. Add it before the first goods receipt.'
  }
  if (d.gstin.trim() === '') {
    a.gstin = 'Without one there is no input credit on anything bought here — the GST is cost.'
  }
  /* The half of the licence every supplier master leaves out. A wholesale
     licence runs five years and the renewal is what gets missed, so a number
     with no date beside it cannot warn anybody about anything. */
  if (d.dlNo.trim() !== '' && d.dlValidUpto.trim() === '') {
    a.dlValidUpto = 'Record it — a lapsed licence on a purchase bill puts your own stock in question.'
  } else if (d.dlValidUpto.trim() !== '' && isCalendarDate(d.dlValidUpto.trim())) {
    const days = daysUntil(d.dlValidUpto.trim(), new Date())
    if (days < 0) a.dlValidUpto = `Already lapsed, ${-days} days ago. Ask for the renewed certificate.`
    else if (days <= 60) a.dlValidUpto = `Lapses in ${days} days — get the renewed copy before the next delivery.`
  }
  return a
}

/**
 * A draft becomes an input.
 *
 * On an EDIT every optional key is sent, blank included, because
 * `updateSupplier` takes a `Partial` and an absent key means "unchanged" — omit
 * the empty ones and a GSTIN could be added but never taken off again. On a
 * CREATE the empties are dropped so the record is born with nulls rather than
 * empty strings. `paymentTermsDays` and `creditLimit` are non-null on the
 * `Supplier` row, so blank resolves to the real zero on both paths.
 */
function toInput(d: Draft, editing: boolean): SupplierInput {
  const address = d.address.trim()
  const gstin = d.gstin.trim().toUpperCase()
  const dlNo = d.dlNo.trim()
  const dlValidUpto = d.dlValidUpto.trim()
  const terms = d.paymentTermsDays.trim()
  const limit = d.creditLimit.trim()

  return {
    name: d.name.trim(),
    phone: normalizePhone(d.phone),
    ...(editing || address ? { address } : {}),
    ...(editing || gstin ? { gstin } : {}),
    ...(editing || dlNo ? { dlNo } : {}),
    ...(editing || dlValidUpto ? { dlValidUpto } : {}),
    paymentTermsDays: terms === '' ? 0 : Number(terms),
    creditLimit: limit === '' ? '0' : limit,
  }
}

// ------------------------------------------------------------------ errors ---

interface Conflict {
  id: number | null
  name: string
  phone: string
}

const FIELD_NAMES = new Set<string>(FIELD_ORDER)

/** `details: { field: 'gstin' }` — the server pointing at the box to fix. */
function fieldFrom(details: unknown): FieldName | null {
  if (typeof details !== 'object' || details === null) return null
  const raw = (details as { field?: unknown }).field
  return typeof raw === 'string' && FIELD_NAMES.has(raw) ? (raw as FieldName) : null
}

/**
 * `code` is the contract; `details` is not.
 *
 * A duplicate is not a failure to report, it is the record the operator was
 * reaching for — so the payload is read defensively enough to offer to OPEN it,
 * and degrades to a plain message when a later backend sends only an id.
 */
function conflictFrom(details: unknown): Conflict {
  const bag = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}
  const inner = bag.supplier
  const src = (typeof inner === 'object' && inner !== null ? inner : bag) as Record<string, unknown>
  return {
    id: typeof src.id === 'number' ? src.id : typeof src.supplierId === 'number' ? src.supplierId : null,
    name: typeof src.name === 'string' ? src.name : '',
    phone: typeof src.phone === 'string' ? src.phone : '',
  }
}

// -------------------------------------------------------------------- form ---

export function SupplierForm({
  open,
  onOpenChange,
  editing,
  onSaved,
  onOpenExisting,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** null creates; a supplier edits it. */
  editing: Supplier | null
  onSaved: (s: Supplier, created: boolean) => void
  onOpenExisting: (id: number) => void
}) {
  /* Suppliers live in `InventoryPurchasesApi`, which the contract declares but
     has not folded into `ApiAdapter` yet — an interface the local adapter could
     not satisfy would fail the build for everyone. The widening is a downcast to
     the shape the contract already promises, and it disappears with no other
     edit the day the two interfaces meet. */
  const api = useApi() as ApiAdapter & InventoryPurchasesApi
  useHotkeys('modal', {}, { enabled: open })

  const [draft, setDraft] = useState<Draft>(editing ? draftFrom(editing) : EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [conflict, setConflict] = useState<Conflict | null>(null)

  /* Seeded from whichever record the dialog was opened on, adjusted during
     render rather than in an effect so the first paint is already right. `open`
     is in the identity so a second "New supplier" starts empty rather than
     resuming a create somebody abandoned an hour ago. */
  const identity = `${String(open)}:${editing ? `edit-${editing.id}` : 'create'}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    if (open) {
      setDraft(editing ? draftFrom(editing) : EMPTY)
      setErrors({})
      setConflict(null)
    }
  }

  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const gstinRef = useRef<HTMLInputElement>(null)
  const dlRef = useRef<HTMLInputElement>(null)
  const dlValidRef = useRef<HTMLInputElement>(null)
  const termsRef = useRef<HTMLInputElement>(null)
  const limitRef = useRef<HTMLInputElement>(null)

  function focusFirstError(found: Partial<Record<FieldName, string>>) {
    const byField: Record<FieldName, { current: HTMLInputElement | null }> = {
      name: nameRef,
      phone: phoneRef,
      gstin: gstinRef,
      dlNo: dlRef,
      dlValidUpto: dlValidRef,
      paymentTermsDays: termsRef,
      creditLimit: limitRef,
    }
    const first = FIELD_ORDER.find((f) => found[f])
    if (first) byField[first].current?.focus()
  }

  const save = useMutation({
    mutationFn: async (input: SupplierInput): Promise<{ supplier: Supplier; created: boolean }> => {
      if (editing) return { supplier: await api.updateSupplier(editing.id, input), created: false }
      return { supplier: await api.createSupplier(input), created: true }
    },
    onSuccess: ({ supplier, created }) => {
      onSaved(supplier, created)
      onOpenChange(false)
    },
    onError: (err) => {
      setConflict(null)
      if (!(err instanceof ApiError)) return
      if (err.code === 'SUPPLIER_EXISTS') {
        setConflict(conflictFrom(err.details))
        return
      }
      /* The backend validates the same record again and its answer is
         per-field. Dropping that into a banner would leave the operator hunting
         for which box it meant. */
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
    // same distributor is exactly the duplicate this check exists to prevent.
    if (save.isPending) return
    const found = validate(draft)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      focusFirstError(found)
      return
    }
    save.mutate(toInput(draft, editing !== null))
  }

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    /* Not re-validation — the message is simply stale the moment the field
       moves, and a red line under a box already corrected is noise. */
    setErrors((prev) => {
      const keys = Object.keys(patch) as Array<keyof Draft>
      if (!keys.some((k) => k in prev)) return prev
      const next = { ...prev }
      for (const k of keys) delete next[k as FieldName]
      return next
    })
  }

  const hints = advice(draft)
  /* Read out of state before the JSX: narrowing a property does not survive
     into a callback, and both of these are only ever used inside one. */
  const conflictId = conflict?.id ?? null
  const conflictName = conflict?.name ?? ''

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 620 }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">
              {editing ? `Edit ${editing.name}` : 'New supplier'}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              {editing
                ? 'Payment terms drive the ageing on every screen that shows what this shop owes. The rest is contact and compliance.'
                : 'The distributor a goods receipt is booked against. Licence and GSTIN can follow, but the bill needs them.'}
            </Dialog.Description>
          </div>

          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="scroll-region min-h-0 flex-1 p-4">
              {conflict ? (
                <Banner tone="warning" icon={TriangleAlert}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      {conflictName
                        ? <><span className="font-medium">{conflictName}</span> is already on file{conflict.phone ? <> on <span className="mono">{conflict.phone}</span></> : null}.</>
                        : 'A supplier with these details is already on file.'}
                    </span>
                    {conflictId !== null ? (
                      <Button size="sm" onClick={() => { onOpenExisting(conflictId); onOpenChange(false) }}>
                        Open it <ArrowRight />
                      </Button>
                    ) : null}
                  </span>
                </Banner>
              ) : null}

              {save.error && !conflict ? (
                <Banner tone="danger" icon={TriangleAlert}>
                  {(save.error as Error).message}
                  {save.error instanceof ApiError ? (
                    <span className="mono ml-2 text-2xs">{save.error.code}</span>
                  ) : null}
                </Banner>
              ) : null}

              <Group title="Identity">
                <Field label="Name" required error={errors.name} className="col-span-2">
                  <input
                    ref={nameRef}
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="Ashirwad Pharma Distributors"
                    className={inputCls(errors.name)}
                    autoFocus
                    autoComplete="off"
                  />
                </Field>
                <Field label="Phone" required error={errors.phone} hint="10 digits">
                  <input
                    ref={phoneRef}
                    value={draft.phone}
                    onChange={(e) => set({ phone: e.target.value })}
                    inputMode="numeric"
                    className={cn(inputCls(errors.phone), 'mono')}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Address" className="col-span-3" hint="Goes on the purchase register">
                  <input
                    value={draft.address}
                    onChange={(e) => set({ address: e.target.value })}
                    className={inputCls()}
                    autoComplete="off"
                  />
                </Field>
              </Group>

              <Group title="Compliance" note="The licence and the GSTIN appear on every purchase bill">
                <Field
                  label="Drug licence no."
                  error={errors.dlNo}
                  advice={hints.dlNo}
                  hint="As printed on his letterhead"
                  className="col-span-2"
                >
                  <input
                    ref={dlRef}
                    value={draft.dlNo}
                    onChange={(e) => set({ dlNo: e.target.value })}
                    placeholder="MH-MUM-20B-123456"
                    className={cn(inputCls(errors.dlNo), 'mono uppercase')}
                    autoComplete="off"
                  />
                </Field>
                {/* The date is the half that actually warns anybody. A licence
                    number never changes and so never raises an alarm; the expiry
                    is what a renewal is missed against. */}
                <Field
                  label="Licence valid to"
                  error={errors.dlValidUpto}
                  advice={hints.dlValidUpto}
                  hint="Renewed every 5 years"
                >
                  <input
                    ref={dlValidRef}
                    type="date"
                    value={draft.dlValidUpto}
                    onChange={(e) => set({ dlValidUpto: e.target.value })}
                    className={cn(inputCls(errors.dlValidUpto), 'num text-left')}
                  />
                </Field>
                <Field label="GSTIN" error={errors.gstin} advice={hints.gstin} className="col-span-2">
                  <input
                    ref={gstinRef}
                    value={draft.gstin}
                    onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
                    placeholder="27AAAAA0000A1Z5"
                    maxLength={15}
                    className={cn(inputCls(errors.gstin), 'mono uppercase')}
                    autoComplete="off"
                  />
                </Field>
              </Group>

              <Group title="Trade">
                <Field
                  label="Payment terms"
                  required
                  error={errors.paymentTermsDays}
                  hint="Days from bill date · 0 = on delivery"
                >
                  <input
                    ref={termsRef}
                    value={draft.paymentTermsDays}
                    onChange={(e) => set({ paymentTermsDays: e.target.value })}
                    inputMode="numeric"
                    placeholder="30"
                    className={cn(inputCls(errors.paymentTermsDays), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Credit limit"
                  error={errors.creditLimit}
                  hint="Blank or 0 means none agreed"
                >
                  <input
                    ref={limitRef}
                    value={draft.creditLimit}
                    onChange={(e) => set({ creditLimit: e.target.value })}
                    inputMode="decimal"
                    className={cn(inputCls(errors.creditLimit), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>
              </Group>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-4 py-3">
              <span className="text-2xs text-fg-subtle">
                <Kbd>↵</Kbd> saves · <Kbd>Esc</Kbd> closes
              </span>
              <span className="ml-auto flex gap-2">
                <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={save.isPending}>
                  <Check /> {editing ? 'Save changes' : 'Create supplier'}
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

function inputCls(error?: string): string {
  return cn(
    'h-[var(--control-h)] w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-base',
    error ? 'border-danger-9' : 'border-border hover:border-border-strong',
  )
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
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
  /** Shown, never blocking: the save would succeed, but it will cost later. */
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

function Banner({
  tone, icon: Icon, children,
}: {
  tone: 'warning' | 'danger'
  icon: LucideIcon
  children: React.ReactNode
}) {
  const cls = tone === 'warning'
    ? 'border-warning-9/40 bg-warning-3 text-warning-11'
    : 'border-danger-9/30 bg-danger-3 text-danger-11'
  return (
    <div className={cn('mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-sm', cls)}>
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
