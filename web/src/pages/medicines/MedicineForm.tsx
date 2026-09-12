import { useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useMutation } from '@tanstack/react-query'
import { ArrowRight, Check, Info, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BaseUom, DosageForm, DrugSchedule, Medicine, MedicineInput } from '@contract'
import { ApiError, BASE_UOMS, DOSAGE_FORMS, DRUG_SCHEDULES } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * Create and edit one item of the master.
 *
 * Three decisions carry this form:
 *
 *  - PACK IS PARSED, AND THE PARSE IS SHOWN. "10x10" is the single most
 *    under-specified string in Indian pharmacy software; Marg ships both a
 *    "Conversion Box" and a "Conv. Case" field and its own manual contradicts
 *    its own examples for which is which. So we read the label, state the
 *    reading in words, and leave every derived number editable.
 *  - SCHEDULE IS MANDATORY, with OTC as the explicit "not scheduled" answer.
 *    Marg hides the Narcotic/H/H1 fields until a Control Room switch is thrown,
 *    so a store runs for years with the column blank and finds out at inspection.
 *    Here, "unset" cannot exist.
 *  - HSN IS CHECKED FOR SHAPE, to the same rule the adapter enforces: the tariff
 *    has 4-, 6- and 8-digit codes and nothing between, and GSTR-1 Table 12 takes
 *    exactly those. A five-digit code caught here costs a keystroke; caught at
 *    filing it costs a quarter.
 */

type FieldName =
  | 'brandName' | 'compositionText' | 'manufacturer' | 'packLabel'
  | 'unitsPerPack' | 'saleStep' | 'hsnCode' | 'drugSchedule' | 'reorderLevel'

/** Reading order. Submit focuses the first invalid field going down the form. */
const FIELD_ORDER: FieldName[] = [
  'brandName', 'compositionText', 'manufacturer', 'packLabel',
  'unitsPerPack', 'saleStep', 'hsnCode', 'drugSchedule', 'reorderLevel',
]

interface Draft {
  brandName: string
  genericName: string
  compositionText: string
  manufacturer: string
  form: DosageForm
  strengthText: string
  packLabel: string
  /** Kept as the typed STRING until submit; a half-typed "1" must not become 1. */
  unitsPerPack: string
  baseUom: BaseUom
  allowLooseSale: boolean
  saleStep: string
  hsnCode: string
  /** '' is impossible to save — the operator has to choose, OTC included. */
  drugSchedule: DrugSchedule | ''
  rackLocation: string
  reorderLevel: string
}

const EMPTY: Draft = {
  brandName: '', genericName: '', compositionText: '', manufacturer: '',
  form: 'Tablet', strengthText: '', packLabel: '', unitsPerPack: '',
  baseUom: 'TAB', allowLooseSale: true, saleStep: '1', hsnCode: '',
  drugSchedule: '', rackLocation: '', reorderLevel: '0',
}

function draftFrom(m: Medicine): Draft {
  return {
    brandName: m.brandName,
    genericName: m.genericName ?? '',
    compositionText: m.compositionText,
    manufacturer: m.manufacturer,
    form: m.form,
    strengthText: m.strengthText,
    packLabel: m.packLabel,
    unitsPerPack: String(m.unitsPerPack),
    baseUom: m.baseUom,
    allowLooseSale: m.allowLooseSale,
    saleStep: m.saleStep,
    hsnCode: m.hsnCode,
    drugSchedule: m.drugSchedule,
    rackLocation: m.rackLocation ?? '',
    reorderLevel: String(m.reorderLevel),
  }
}

// -------------------------------------------------------------- pack sense ---

interface PackReading {
  /** Base units in ONE sale pack. */
  unitsPerPack: number | null
  baseUom: BaseUom | null
  /**
   * Sale packs in one purchase carton. THE CONTRACT HAS NOWHERE TO PUT THIS —
   * `MedicineInput` stops at `unitsPerPack` — so it is read, shown, and dropped.
   * Until it is stored, a goods receipt that says "2 boxes" is arithmetic the
   * operator does in their head.
   */
  packsPerBox: number | null
  strengthHint: string | null
  reading: string | null
  confident: boolean
}

const UOM_FOR_UNIT: Record<string, BaseUom> = {
  ml: 'ML', l: 'ML', gm: 'GM', g: 'GM', gms: 'GM',
}

const CONTAINER_UOM: Array<[RegExp, BaseUom]> = [
  [/\b(amp|ampoule|vial|inj)\b/, 'VIAL'],
  [/\b(bottle|btl)\b/, 'BOTTLE'],
  [/\b(tube)\b/, 'TUBE'],
  [/\b(cap|capsule)s?\b/, 'CAP'],
  [/\b(tab|tablet)s?\b/, 'TAB'],
]

function containerUom(label: string): BaseUom | null {
  for (const [re, uom] of CONTAINER_UOM) if (re.test(label)) return uom
  return null
}

/**
 * Read a printed pack label.
 *
 * The three levels are base unit (tablet) → sale pack (strip of 10) → purchase
 * pack (box of 10 strips). "10x10" is the third; "1x15" is one strip of 15;
 * "60ml" is a single container. "5x2ml amp" is the honest hard case: five
 * ampoules of 2 ml each, where the sellable thing is the ampoule and the 2 ml is
 * strength — so it is read with `confident: false` and asks to be checked.
 */
function readPack(raw: string): PackReading {
  const none: PackReading = {
    unitsPerPack: null, baseUom: null, packsPerBox: null,
    strengthHint: null, reading: null, confident: false,
  }
  const label = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (label === '') return none

  const hinted = containerUom(label)

  // "5x2ml amp" / "1x60ml" — a count of containers, each holding a measure.
  const measured = /^(\d+)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(ml|l|gm|g|gms|mg|mcg)\b/.exec(label)
  if (measured) {
    const count = Number(measured[1] ?? 0)
    const size = measured[2] ?? ''
    const unit = measured[3] ?? ''
    const measure = UOM_FOR_UNIT[unit] ?? null
    if (count === 1 && measure) {
      return {
        unitsPerPack: Number(size), baseUom: measure, packsPerBox: null, strengthHint: null,
        reading: `One ${hinted === 'BOTTLE' ? 'bottle' : 'container'} of ${size} ${unit} → a sale pack of ${size} ${measure}.`,
        confident: Number.isInteger(Number(size)),
      }
    }
    return {
      unitsPerPack: count,
      baseUom: hinted ?? 'UNIT',
      packsPerBox: null,
      strengthHint: `${size} ${unit}`,
      reading: `${count} × ${size} ${unit} → ${count} ${hinted === 'VIAL' ? 'ampoules/vials' : 'units'} of ${size} ${unit} each. The ${size} ${unit} is strength, not a count — check the strength field.`,
      confident: false,
    }
  }

  // "10x10", "1x15" — packs per box × units per pack.
  const twoLevel = /^(\d+)\s*[x×*]\s*(\d+)\b/.exec(label)
  if (twoLevel) {
    const boxes = Number(twoLevel[1] ?? 0)
    const units = Number(twoLevel[2] ?? 0)
    if (boxes === 1) {
      return {
        unitsPerPack: units, baseUom: hinted, packsPerBox: null, strengthHint: null,
        reading: `One pack of ${units} — a sale pack is ${units} ${hinted ?? 'units'}.`,
        confident: true,
      }
    }
    return {
      unitsPerPack: units, baseUom: hinted, packsPerBox: boxes, strengthHint: null,
      reading: `${boxes} × ${units} → a box of ${boxes} packs, each pack ${units} ${hinted ?? 'units'}. One sale pack = ${units}; the box of ${boxes} is not stored.`,
      confident: true,
    }
  }

  // "60ml", "100gm"
  const single = /^(\d+(?:\.\d+)?)\s*(ml|l|gm|g|gms)\b/.exec(label)
  if (single) {
    const size = single[1] ?? ''
    const unit = single[2] ?? ''
    const measure = UOM_FOR_UNIT[unit] ?? 'UNIT'
    return {
      unitsPerPack: Number(size), baseUom: measure, packsPerBox: null, strengthHint: null,
      reading: `A single ${size} ${unit} pack → a sale pack of ${size} ${measure}.`,
      confident: Number.isInteger(Number(size)),
    }
  }

  // "10s", "15's", or a bare count.
  const counted = /^(\d+)\s*(?:'?s)?$/.exec(label)
  if (counted) {
    const units = Number(counted[1] ?? 0)
    return {
      unitsPerPack: units, baseUom: hinted, packsPerBox: null, strengthHint: null,
      reading: `A pack of ${units} ${hinted ?? 'units'}.`,
      confident: true,
    }
  }

  return { ...none, reading: 'This label cannot be read automatically — set the units per pack by hand.' }
}

// -------------------------------------------------------------- validation ---

/* Character for character the adapter's rule (`api/medicines.ts`). A looser one
   here would only move the refusal to the far side of a round trip, and would
   contradict the message that came back. */
const HSN_RE = /^(?:\d{4}|\d{6}|\d{8})$/
const QTY_RE = /^\d+(\.\d{1,3})?$/
const INT_RE = /^\d+$/

/** Chapter 30 covers pharmaceuticals; the rest are what a chemist also sells. */
const HSN_SUGGESTIONS: Array<{ code: string; what: string }> = [
  { code: '3004', what: 'Medicaments, in doses' },
  { code: '3003', what: 'Medicaments, bulk' },
  { code: '3005', what: 'Dressings, gauze' },
  { code: '3006', what: 'Sutures, kits' },
  { code: '9018', what: 'Instruments' },
  { code: '2106', what: 'Food supplements' },
]

function validate(d: Draft): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {}
  if (!d.brandName.trim()) e.brandName = 'A brand name is required.'
  if (!d.compositionText.trim()) e.compositionText = 'Composition is what substitution is decided on. It is required.'
  if (!d.manufacturer.trim()) e.manufacturer = 'A manufacturer is required.'
  if (!d.packLabel.trim()) e.packLabel = 'Enter the pack exactly as it is printed.'

  if (!INT_RE.test(d.unitsPerPack.trim()) || Number(d.unitsPerPack) < 1) {
    e.unitsPerPack = 'Whole base units in one sale pack, at least 1.'
  }
  if (!QTY_RE.test(d.saleStep.trim()) || Number(d.saleStep) <= 0) {
    e.saleStep = 'The smallest sellable increment, greater than zero.'
  }
  if (!HSN_RE.test(d.hsnCode.trim())) e.hsnCode = 'An HSN code is 4, 6 or 8 digits — the tariff has no odd lengths.'
  if (d.drugSchedule === '') e.drugSchedule = 'Choose one. OTC is the explicit "not scheduled" answer.'
  if (!INT_RE.test(d.reorderLevel.trim())) e.reorderLevel = 'A whole number of base units.'
  return e
}

/** Non-blocking. Things that will bite later but are not wrong enough to refuse
 *  a save the backend would accept. */
function advice(d: Draft): Partial<Record<FieldName, string>> {
  const a: Partial<Record<FieldName, string>> = {}
  if (
    d.allowLooseSale
    && QTY_RE.test(d.saleStep.trim())
    && INT_RE.test(d.unitsPerPack.trim())
    && Number(d.unitsPerPack) >= 1
    && D.gt(D.dec(d.saleStep.trim()), D.dec(d.unitsPerPack.trim()))
  ) {
    a.saleStep = 'A step larger than the pack itself can never be dispensed.'
  }
  return a
}

function toInput(d: Draft): MedicineInput {
  const schedule = d.drugSchedule === 'OTC' || d.drugSchedule === '' ? 'OTC' : d.drugSchedule
  /* Sent even when empty. `applyMedicineUpdate` reads an ABSENT key as
     "unchanged", so omitting these two makes them one-way: an operator could add
     a generic name or a rack and never take one off again. '' is collapsed to
     null by the same validator that would have kept the old value. */
  const generic = d.genericName.trim()
  const rack = d.rackLocation.trim()
  return {
    brandName: d.brandName.trim(),
    genericName: generic,
    compositionText: d.compositionText.trim(),
    manufacturer: d.manufacturer.trim(),
    form: d.form,
    strengthText: d.strengthText.trim(),
    packLabel: d.packLabel.trim(),
    /* A count, not money: `unitsPerPack` and `reorderLevel` are integers in the
       contract, so Number() is the right conversion. `saleStep` is a Qty string
       and stays one. */
    unitsPerPack: Number(d.unitsPerPack.trim()),
    baseUom: d.baseUom,
    allowLooseSale: d.allowLooseSale,
    saleStep: d.allowLooseSale ? d.saleStep.trim() : d.unitsPerPack.trim(),
    hsnCode: d.hsnCode.trim(),
    drugSchedule: schedule,
    rackLocation: rack,
    reorderLevel: Number(d.reorderLevel.trim()),
  }
}

interface Conflict {
  id: number | null
  brandName: string
  packLabel: string
  manufacturer: string
}

/**
 * `code` is the contract; `details` is not.
 *
 * The adapter puts the whole clashing row in `details`, which is what lets this
 * form offer to OPEN it instead of only reporting that something clashed — but
 * the shape is read defensively, because a later backend is free to send only an
 * id, and a screen that trusts an undocumented payload breaks at cutover.
 */
function conflictFrom(details: unknown): Conflict {
  const d = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: typeof d.id === 'number' ? d.id : typeof d.medicineId === 'number' ? d.medicineId : null,
    brandName: str(d.brandName),
    packLabel: str(d.packLabel),
    manufacturer: str(d.manufacturer),
  }
}

const FIELD_NAMES = new Set<string>(FIELD_ORDER)

function fieldFrom(details: unknown): FieldName | null {
  if (typeof details !== 'object' || details === null) return null
  const raw = (details as { field?: unknown }).field
  return typeof raw === 'string' && FIELD_NAMES.has(raw) ? (raw as FieldName) : null
}

// ------------------------------------------------------------------- form ----

export function MedicineForm({
  open,
  onOpenChange,
  editing,
  initialBarcode,
  onSaved,
  onOpenExisting,
  onSearchFor,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** null creates; a medicine edits it. */
  editing: Medicine | null
  /** Set when the form was opened from an unmatched scan, purely to explain why. */
  initialBarcode?: string | null
  onSaved: (m: Medicine, created: boolean) => void
  onOpenExisting: (id: number) => void
  onSearchFor: (term: string) => void
}) {
  const api = useApi()
  useHotkeys('modal', {}, { enabled: open })

  const [draft, setDraft] = useState<Draft>(editing ? draftFrom(editing) : EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [packTouched, setPackTouched] = useState(false)
  /** The label the parser has already answered for. */
  const [lastLabel, setLastLabel] = useState(draft.packLabel)

  /* The draft is seeded from whichever record the dialog was opened on, adjusted
     during render rather than in an effect so the first paint is already right.
     `open` is in the identity so a second "New medicine" starts empty rather
     than resuming a create somebody abandoned an hour ago. */
  const identity = `${String(open)}:${editing ? `edit-${editing.id}` : 'create'}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    if (open) {
      const seeded = editing ? draftFrom(editing) : EMPTY
      setDraft(seeded)
      /* The stored units-per-pack is an answer somebody already gave, and the
         parser does not get to overrule it just because the dialog opened.
         Seeding this with the label is what keeps the auto-fill below firing
         only on a label typed HERE — without it, opening Edit on a 100ml syrup
         (one BOTTLE in the master) silently rewrote it to 100 ML, and the next
         bill priced a whole bottle as a millilitre. */
      setLastLabel(seeded.packLabel)
      setErrors({})
      setConflict(null)
      setPackTouched(false)
    }
  }

  const pack = readPack(draft.packLabel)

  /* Auto-fill from the parse only until the operator overrules it. Once they
     have typed in the units box, the label stops driving it. */
  if (draft.packLabel !== lastLabel) {
    setLastLabel(draft.packLabel)
    if (!packTouched && pack.confident) {
      setDraft((d) => ({
        ...d,
        ...(pack.unitsPerPack !== null ? { unitsPerPack: String(pack.unitsPerPack) } : {}),
        ...(pack.baseUom !== null ? { baseUom: pack.baseUom } : {}),
        ...(pack.unitsPerPack !== null && !d.allowLooseSale ? { saleStep: String(pack.unitsPerPack) } : {}),
      }))
    }
  }

  const brandRef = useRef<HTMLInputElement>(null)
  const compositionRef = useRef<HTMLInputElement>(null)
  const manufacturerRef = useRef<HTMLInputElement>(null)
  const packLabelRef = useRef<HTMLInputElement>(null)
  const unitsRef = useRef<HTMLInputElement>(null)
  const stepRef = useRef<HTMLInputElement>(null)
  const hsnRef = useRef<HTMLInputElement>(null)
  const scheduleRef = useRef<HTMLSelectElement>(null)
  const reorderRef = useRef<HTMLInputElement>(null)

  function focusFirstError(e: Partial<Record<FieldName, string>>) {
    const byField: Record<FieldName, { current: { focus: () => void } | null }> = {
      brandName: brandRef,
      compositionText: compositionRef,
      manufacturer: manufacturerRef,
      packLabel: packLabelRef,
      unitsPerPack: unitsRef,
      saleStep: stepRef,
      hsnCode: hsnRef,
      drugSchedule: scheduleRef,
      reorderLevel: reorderRef,
    }
    const first = FIELD_ORDER.find((f) => e[f])
    if (first) byField[first].current?.focus()
  }

  const save = useMutation({
    mutationFn: async (input: MedicineInput): Promise<{ medicine: Medicine; created: boolean }> => {
      if (editing) return { medicine: await api.updateMedicine(editing.id, input), created: false }
      return { medicine: await api.createMedicine(input), created: true }
    },
    onSuccess: ({ medicine, created }) => {
      onSaved(medicine, created)
      onOpenChange(false)
    },
    onError: (err) => {
      setConflict(null)
      if (!(err instanceof ApiError)) return
      /* MEDICINE_EXISTS is not a failure, it is a redirection: the record the
         operator was reaching for already exists. */
      if (err.code === 'MEDICINE_EXISTS') {
        setConflict(conflictFrom(err.details))
        return
      }
      /* The backend validates the same row again, and its answer is per-field.
         Dropping that into a toast would leave the operator hunting for which
         box it meant. */
      if (err.code === 'MEDICINE_INVALID') {
        const field = fieldFrom(err.details)
        if (field) {
          setErrors((prev) => ({ ...prev, [field]: err.message }))
          focusFirstError({ [field]: err.message })
        }
      }
    },
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const found = validate(draft)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      focusFirstError(found)
      return
    }
    /* No client-side duplicate pre-check. `createMedicine` refuses a clash on
       (brand, pack, manufacturer) and hands back the row it clashed with, so a
       second copy of that rule here could only ever disagree with the one that
       actually decides. */
    save.mutate(toInput(draft))
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  /* Read out of state before the JSX: narrowing a property does not survive into
     a callback, and both of these are only ever used inside one. */
  const conflictId = conflict?.id ?? null
  const conflictBrand = conflict?.brandName ?? ''
  const hints = advice(draft)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 760 }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">
              {editing ? `Edit ${editing.brandName}` : 'New medicine'}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              {editing
                ? 'Pack arithmetic, tax and schedule change how every future bill computes. Rack and reorder level do not.'
                : 'Most items are born on a goods receipt. Use this for the ones that are not.'}
            </Dialog.Description>
          </div>

          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="scroll-region min-h-0 flex-1 p-4">
              {initialBarcode ? (
                <Banner tone="info" icon={Info}>
                  Created from the unmatched scan <span className="mono">{initialBarcode}</span>. The code is linked
                  as soon as this saves.
                </Banner>
              ) : null}

              {conflict ? (
                <Banner tone="warning" icon={TriangleAlert}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      {conflict.brandName
                        ? <><span className="font-medium">{conflict.brandName}</span> {conflict.packLabel} by {conflict.manufacturer} is already in the catalogue.</>
                        : 'An item with this brand, pack and manufacturer already exists.'}
                    </span>
                    {conflictId !== null ? (
                      <Button size="sm" onClick={() => { onOpenExisting(conflictId); onOpenChange(false) }}>
                        Open it <ArrowRight />
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => { onSearchFor(conflictBrand || draft.brandName.trim()); onOpenChange(false) }}>
                        Find it <ArrowRight />
                      </Button>
                    )}
                  </span>
                </Banner>
              ) : null}

              {save.error && !conflict ? (
                <Banner tone="danger" icon={TriangleAlert}>
                  {(save.error as Error).message}
                  {save.error instanceof ApiError ? <span className="mono ml-2 text-2xs">{save.error.code}</span> : null}
                </Banner>
              ) : null}

              <Group title="Identity">
                <Field label="Brand name" required error={errors.brandName} className="col-span-2">
                  <input ref={brandRef} value={draft.brandName} onChange={(e) => set({ brandName: e.target.value })} className={inputCls(errors.brandName)} autoFocus autoComplete="off" />
                </Field>
                <Field label="Strength" hint="As printed: 500mg, 5%, 40IU">
                  <input value={draft.strengthText} onChange={(e) => set({ strengthText: e.target.value })} className={inputCls()} autoComplete="off" />
                </Field>
                <Field label="Composition / salt" required error={errors.compositionText} className="col-span-2">
                  <input ref={compositionRef} value={draft.compositionText} onChange={(e) => set({ compositionText: e.target.value })} placeholder="Amoxycillin (500mg) + Clavulanic Acid (125mg)" className={inputCls(errors.compositionText)} autoComplete="off" />
                </Field>
                <Field label="Generic name">
                  <input value={draft.genericName} onChange={(e) => set({ genericName: e.target.value })} className={inputCls()} autoComplete="off" />
                </Field>
                <Field label="Manufacturer" required error={errors.manufacturer}>
                  <input ref={manufacturerRef} value={draft.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} className={inputCls(errors.manufacturer)} autoComplete="off" />
                </Field>
                <Field label="Dosage form">
                  <select value={draft.form} onChange={(e) => set({ form: e.target.value as DosageForm })} className={inputCls()}>
                    {DOSAGE_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
              </Group>

              <Group title="Pack" note="Base unit → sale pack → purchase box">
                <Field label="Pack label" required error={errors.packLabel} hint="Exactly as the carton prints it">
                  <input ref={packLabelRef} value={draft.packLabel} onChange={(e) => set({ packLabel: e.target.value })} placeholder="10x10, 1x15, 60ml" className={inputCls(errors.packLabel)} autoComplete="off" />
                </Field>
                <Field label="Units per sale pack" required error={errors.unitsPerPack}>
                  <input
                    ref={unitsRef}
                    value={draft.unitsPerPack}
                    onChange={(e) => { setPackTouched(true); set({ unitsPerPack: e.target.value }) }}
                    inputMode="numeric"
                    className={cn(inputCls(errors.unitsPerPack), 'num text-left')}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Base unit">
                  <select value={draft.baseUom} onChange={(e) => { setPackTouched(true); set({ baseUom: e.target.value as BaseUom }) }} className={inputCls()}>
                    {BASE_UOMS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Field>

                {pack.reading ? (
                  <div className="col-span-3">
                    <div
                      className={cn(
                        'flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-sm',
                        pack.confident ? 'border-accent-6/60 bg-accent-2 text-accent-11' : 'border-warning-9/40 bg-warning-3 text-warning-11',
                      )}
                    >
                      {pack.confident ? <Check size={14} className="mt-0.5 shrink-0" aria-hidden /> : <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />}
                      <span>
                        <span className="font-medium">Read as: </span>{pack.reading}
                        {pack.strengthHint ? <> Suggested strength: <span className="font-medium">{pack.strengthHint}</span>.</> : null}
                        {pack.packsPerBox !== null ? (
                          <span className="mt-1 block text-2xs opacity-80">
                            The box factor of {pack.packsPerBox} has nowhere to live in the contract yet, so a
                            receipt booked in boxes still has to be converted by hand.
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                ) : null}

                <Field label="Loose sale" className="col-span-2" plain>
                  <Toggle
                    checked={draft.allowLooseSale}
                    onChange={(v) => set({ allowLooseSale: v, saleStep: v ? '1' : (draft.unitsPerPack || '1') })}
                    on="A strip may be cut"
                    off="Whole pack only"
                  />
                </Field>
                <Field label="Sale step" error={errors.saleStep} advice={hints.saleStep} hint={draft.allowLooseSale ? 'In base units' : 'Locked to one pack'}>
                  <input
                    ref={stepRef}
                    value={draft.allowLooseSale ? draft.saleStep : (draft.unitsPerPack || '1')}
                    onChange={(e) => set({ saleStep: e.target.value })}
                    disabled={!draft.allowLooseSale}
                    inputMode="decimal"
                    className={cn(inputCls(errors.saleStep), 'num text-left disabled:bg-inset disabled:text-fg-muted')}
                    autoComplete="off"
                  />
                </Field>
              </Group>

              <Group title="Compliance">
                <Field
                  label="HSN code"
                  required
                  error={errors.hsnCode}
                  hint="4, 6 or 8 digits"
                  footer={
                    <div className="mt-1 flex flex-wrap gap-1">
                      {HSN_SUGGESTIONS.map((h) => (
                        <button
                          key={h.code}
                          type="button"
                          title={h.what}
                          onClick={() => set({ hsnCode: h.code })}
                          className={cn(
                            'mono rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-2xs',
                            draft.hsnCode === h.code
                              ? 'border-accent-6 bg-accent-3 text-accent-11'
                              : 'border-border-subtle bg-subtle text-fg-muted hover:border-border-strong',
                          )}
                        >
                          {h.code}
                        </button>
                      ))}
                    </div>
                  }
                >
                  <input ref={hsnRef} value={draft.hsnCode} onChange={(e) => set({ hsnCode: e.target.value.replace(/\D/g, '').slice(0, 8) })} inputMode="numeric" className={cn(inputCls(errors.hsnCode), 'mono')} autoComplete="off" />
                </Field>
                <Field label="Drug schedule" required error={errors.drugSchedule}>
                  <select
                    ref={scheduleRef}
                    value={draft.drugSchedule}
                    onChange={(e) => set({ drugSchedule: e.target.value as DrugSchedule | '' })}
                    className={inputCls(errors.drugSchedule)}
                  >
                    <option value="" disabled>Choose…</option>
                    {DRUG_SCHEDULES.map((s) => (
                      <option key={s} value={s}>{s === 'OTC' ? 'OTC — not scheduled' : `Schedule ${s}`}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Rack / bin" hint="Where it physically sits">
                  <input value={draft.rackLocation} onChange={(e) => set({ rackLocation: e.target.value })} placeholder="A-12" className={cn(inputCls(), 'mono')} autoComplete="off" />
                </Field>
                <Field label="Reorder level" error={errors.reorderLevel} hint="Base units">
                  <input ref={reorderRef} value={draft.reorderLevel} onChange={(e) => set({ reorderLevel: e.target.value })} inputMode="numeric" className={cn(inputCls(errors.reorderLevel), 'num text-left')} autoComplete="off" />
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
                  <Check /> {editing ? 'Save changes' : 'Create item'}
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
  label, required, hint, error, advice: adviceText, className, footer, plain, children,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  /** Shown, never blocking: the save would succeed, but it will cost later. */
  advice?: string
  className?: string
  /** Rendered OUTSIDE the <label>: a button nested in a label steals its click. */
  footer?: React.ReactNode
  /** For controls that are buttons rather than a form field. */
  plain?: boolean
  children: React.ReactNode
}) {
  const head = (
    <span className="mb-1 flex items-baseline gap-1.5">
      <span className="micro-label">{label}{required ? <span className="text-danger-9"> *</span> : null}</span>
      {hint && !error ? <span className="text-2xs text-fg-subtle">{hint}</span> : null}
    </span>
  )
  return (
    <div className={cn('min-w-0', className)}>
      {plain ? (
        <div>{head}{children}</div>
      ) : (
        <label className="block">{head}{children}</label>
      )}
      {error ? <span className="mt-1 block text-2xs text-danger-11">{error}</span> : null}
      {!error && adviceText ? <span className="mt-1 block text-2xs text-warning-11">{adviceText}</span> : null}
      {footer}
    </div>
  )
}

function Toggle({
  checked, onChange, on, off,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  on: string
  off: string
}) {
  return (
    <div className="flex h-[var(--control-h)] items-center gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-0.5">
      {[true, false].map((v) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={checked === v}
          onClick={() => onChange(v)}
          className={cn(
            'h-full flex-1 rounded-[var(--radius-sm)] px-2 text-sm',
            checked === v ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover',
          )}
        >
          {v ? on : off}
        </button>
      ))}
    </div>
  )
}

function Banner({
  tone, icon: Icon, children,
}: {
  tone: 'info' | 'warning' | 'danger'
  icon: LucideIcon
  children: React.ReactNode
}) {
  const cls = {
    info: 'border-info-9/30 bg-info-3 text-info-11',
    warning: 'border-warning-9/40 bg-warning-3 text-warning-11',
    danger: 'border-danger-9/30 bg-danger-3 text-danger-11',
  }[tone]
  return (
    <div className={cn('mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-sm', cls)}>
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
