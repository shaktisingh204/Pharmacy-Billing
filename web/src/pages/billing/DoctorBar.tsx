import { useEffect, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, ShieldAlert, Stethoscope, X } from 'lucide-react'
import type { Doctor, DoctorInput } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * The prescriber strip, above the entry area.
 *
 * The doctor is a master record and not free text on the bill: Rule 65 wants the
 * name and address, the Schedule H1 register wants the registration number, and
 * retyping is how one physician becomes four spellings that no auditor can
 * reconcile. The popover therefore opens on a FREQUENT list — a shop's bills are
 * written by the same handful of prescribers — and typing is the fallback.
 */
export function DoctorBar({
  doctor,
  onSelect,
  required,
}: {
  doctor: Doctor | null
  onSelect: (d: Doctor | null) => void
  /** True when the cart holds a Schedule H1 line, which makes this mandatory. */
  required: boolean
}) {
  const [open, setOpen] = useState(false)

  useHotkeys('billing', { 'doctor.attach': () => setOpen(true) })
  /* The popover owns a text input, so while it is up the billing scope must not
     see a key at all: otherwise Escape closes this AND steps the bill back a
     stage, and '/' jumps to the medicine search from under it. Claiming the
     exclusive 'modal' scope with no handlers of its own leaves Escape to Radix,
     which dismisses exactly one layer. */
  useHotkeys('modal', {}, { enabled: open })

  const urgent = required && doctor === null

  return (
    /* No surface, no border, no padding of its own. The prescriber now sits in
       the POS page header alongside the bill identity, and a strip that carried
       its own chrome drew a second rule across the header band. */
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 min-w-0 max-w-[60%] items-center gap-2 rounded-[var(--radius-md)] border px-2.5 text-sm',
              doctor
                ? 'border-border bg-surface hover:bg-hover'
                : 'border-dashed border-border text-fg-muted hover:border-border-strong hover:bg-hover hover:text-fg',
              urgent && 'border-solid',
            )}
            style={urgent ? URGENT : undefined}
          >
            {urgent
              ? <ShieldAlert size={15} className="shrink-0" aria-hidden />
              : <Stethoscope size={15} className="shrink-0" aria-hidden />}
            {doctor ? (
              <>
                <span className="truncate font-medium">{withTitle(doctor.name)}</span>
                {doctor.qualification && (
                  <span className="shrink-0 text-xs text-fg-muted">{doctor.qualification}</span>
                )}
                {doctor.registrationNo && (
                  <span className="mono shrink-0 text-xs text-fg-subtle">Reg. {doctor.registrationNo}</span>
                )}
              </>
            ) : (
              <>
                <span className="shrink-0">Add prescriber</span>
                {/* The word carries the meaning; the magenta only reinforces it. */}
                {required && (
                  <span
                    className="shrink-0 rounded-[var(--radius-sm)] px-1.5 text-2xs font-semibold uppercase tracking-[0.04em]"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--schedule-h1) 16%, transparent)' }}
                  >
                    required
                  </span>
                )}
                <Kbd className="shrink-0">Alt+O</Kbd>
              </>
            )}
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-50 w-[380px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
          >
            <Picker
              onPick={(d) => {
                onSelect(d)
                setOpen(false)
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {doctor ? (
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-label="Clear prescriber"
          className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}

      {urgent && (
        <span className="truncate text-xs text-fg-muted">
          A Schedule H1 line needs the prescriber&rsquo;s name and registration number.
        </span>
      )}
    </div>
  )
}

/* The only place the H1 magenta appears outside a schedule chip. A missing
   prescriber on an H1 bill is the same fact as the H1 chip on the line, so it is
   deliberately the same colour — carried by an icon and a word, never alone. */
const URGENT: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--schedule-h1) 45%, transparent)',
  backgroundColor: 'color-mix(in srgb, var(--schedule-h1) 8%, transparent)',
  color: 'var(--schedule-h1)',
}

/** A name that already carries the title must not be printed as "Dr Dr Rao". */
function withTitle(name: string): string {
  const trimmed = name.trim()
  return /^dr\.?\s/i.test(trimmed) ? trimmed : `Dr ${trimmed}`
}

function Picker({ onPick }: { onPick: (d: Doctor) => void }) {
  const api = useApi()
  const [term, setTerm] = useState('')
  const [creating, setCreating] = useState(false)
  const [active, setActive] = useState(0)
  const trimmed = term.trim()

  const { data: matches = [] } = useQuery({
    queryKey: ['doctors', 'search', trimmed],
    queryFn: () => api.searchDoctors(trimmed),
    enabled: trimmed.length > 0,
    placeholderData: (prev) => prev,
  })
  const { data: frequent = [] } = useQuery({
    queryKey: ['doctors', 'recent'],
    queryFn: () => api.recentDoctors(6),
  })

  const rows = trimmed === '' ? frequent : matches
  useEffect(() => { setActive(0) }, [trimmed])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // A MODIFIED Enter belongs to the bill, not to this list: Ctrl+Enter is "go
    // to payment" and Ctrl+S is "save". Escape is left to Radix, which closes
    // this layer and nothing behind it.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = rows[active]
      if (picked) onPick(picked)
    }
  }

  if (creating) {
    return <NewPrescriber initialName={trimmed} onCreated={onPick} onCancel={() => setCreating(false)} />
  }

  return (
    <>
      <div className="relative p-2">
        <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="doctor-results"
          aria-autocomplete="list"
          aria-activedescendant={rows[active] ? `doctor-${rows[active].id}` : undefined}
          aria-label="Prescriber search"
          placeholder="Name, clinic or registration no.…"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-8 pr-2.5 text-base hover:border-border-strong"
        />
      </div>

      <div className="flex items-center gap-2 border-y border-border-subtle bg-subtle px-3 py-1">
        <span className="micro-label">{trimmed === '' ? 'Frequent' : 'Matches'}</span>
      </div>

      <div id="doctor-results" role="listbox" aria-label="Prescribers" className="scroll-region max-h-[260px]">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-fg-muted">
            {trimmed === ''
              ? 'No prescriber has been billed from this counter yet.'
              : `No prescriber matches “${trimmed}”.`}
          </p>
        ) : (
          rows.map((d, i) => (
            <Row key={d.id} doctor={d} active={i === active} onPick={() => onPick(d)} onHover={() => setActive(i)} />
          ))
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-subtle px-2 py-2">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New prescriber
        </Button>
        <span className="flex items-center gap-1 text-2xs text-fg-subtle">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>↵</Kbd> pick · <Kbd>Esc</Kbd> close
        </span>
      </div>
    </>
  )
}

function Row({ doctor: d, active, onPick, onHover }: {
  doctor: Doctor
  active: boolean
  onPick: () => void
  onHover: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }) }, [active])

  return (
    <div
      ref={ref}
      id={`doctor-${d.id}`}
      role="option"
      aria-selected={active}
      /* Picking must not pull focus out of the search box; the operator may keep
         typing straight after a mistaken click. */
      onMouseDown={(e) => { e.preventDefault(); onPick() }}
      onMouseEnter={onHover}
      className={cn(
        'relative flex cursor-pointer flex-col gap-0.5 border-b border-border-subtle px-3 py-2',
        active ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}
      <div className="flex items-baseline gap-2">
        <span className={cn('truncate text-base font-medium', active && 'text-accent-11')}>{withTitle(d.name)}</span>
        {d.qualification && <span className="shrink-0 text-xs text-fg-muted">{d.qualification}</span>}
        {d.prescriptionCount > 0 && (
          <span className="num ml-auto shrink-0 text-2xs text-fg-subtle">{d.prescriptionCount} bills</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="mono shrink-0">{d.registrationNo ?? 'Reg. no. not recorded'}</span>
        {d.clinicName && (
          <>
            <span className="shrink-0 text-fg-subtle">·</span>
            <span className="truncate">{d.clinicName}</span>
          </>
        )}
      </div>
    </div>
  )
}

const BLANK = { name: '', registrationNo: '', qualification: '', clinicName: '', phone: '' }

function NewPrescriber({ initialName, onCreated, onCancel }: {
  /** What the operator had already typed. Retyping it is the fastest way to lose them. */
  initialName: string
  onCreated: (d: Doctor) => void
  onCancel: () => void
}) {
  const api = useApi()
  const qc = useQueryClient()
  const [draft, setDraft] = useState({ ...BLANK, name: initialName })
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const create = useMutation({
    mutationFn: (input: DoctorInput) => api.createDoctor(input),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['doctors'] })
      onCreated(d)
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const name = draft.name.trim()
    if (name === '') {
      /* A disabled button would hide WHY it is disabled. The name is the one
         field the prescription register cannot do without, so it is refused out
         loud and the caret is put back where the fix is. */
      setError('A prescriber needs a name — it is printed on the bill.')
      nameRef.current?.focus()
      return
    }
    const reg = draft.registrationNo.trim()
    const qual = draft.qualification.trim()
    const clinic = draft.clinicName.trim()
    const phone = draft.phone.trim()
    create.mutate({
      name,
      ...(reg ? { registrationNo: reg } : {}),
      ...(qual ? { qualification: qual } : {}),
      ...(clinic ? { clinicName: clinic } : {}),
      ...(phone ? { phone } : {}),
    })
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="space-y-2.5 p-3">
        <Field
          ref={nameRef}
          label="Name"
          required
          autoFocus
          value={draft.name}
          onChange={(v) => { setDraft({ ...draft, name: v }); setError(null) }}
        />
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Registration no." value={draft.registrationNo} onChange={(v) => setDraft({ ...draft, registrationNo: v })} />
          <Field label="Qualification" value={draft.qualification} onChange={(v) => setDraft({ ...draft, qualification: v })} />
        </div>
        <Field label="Clinic" value={draft.clinicName} onChange={(v) => setDraft({ ...draft, clinicName: v })} />
        <Field label="Phone" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
        {error && <p role="alert" className="text-xs text-danger-11">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-subtle px-3 py-2">
        <Button size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" disabled={create.isPending}>
          Save prescriber
        </Button>
      </div>
    </form>
  )
}

function Field({ label, value, onChange, required, autoFocus, ref }: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  autoFocus?: boolean
  ref?: React.Ref<HTMLInputElement>
}) {
  return (
    <label className="block">
      <span className="micro-label mb-1 block">
        {label}{required && <span className="text-danger-9"> *</span>}
      </span>
      <input
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base hover:border-border-strong"
      />
    </label>
  )
}
