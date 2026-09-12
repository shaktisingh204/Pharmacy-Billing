import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRightLeft, Building, Check, CirclePlus, MapPin, Pencil, ReceiptIndianRupee, ShieldCheck,
  Store, X,
} from 'lucide-react'
import type { StoreProfile, StoreProfilePatch } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { branchConsequences, branchTemplate, newBranchProfile } from '@/api/branches'
import type { NewBranch } from '@/api/branches'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { Code } from '@/components/ui/Money'
import { ErrorState, SkeletonRows } from '@/components/states'
import {
  Consequences, Field, PanelHeader, PanelShell, Section, inputClass,
} from './SettingsForm'

/**
 * The chain.
 *
 * `storeId` has been on every transactional row since the first migration and
 * the switcher in the top bar has been able to move between branches for a
 * while — but there was nowhere to SEE the chain, and no way to open a branch
 * without editing a seed file. This is that place.
 *
 * The two things it exists to make visible are the ones that are invisible from
 * the counter and expensive to get wrong:
 *
 *  - WHAT EACH BRANCH ISSUES. Every branch numbers its own documents, and the
 *    prefix is stamped into every one of them. Two branches sharing a prefix
 *    produce the same invoice number twice, and the only place that is
 *    observable is a list like this one.
 *  - WHAT IS SHARED AND WHAT IS NOT. The medicine and party masters are the
 *    chain's; stock, bills, purchases and the day close belong to one shop. A
 *    branch that opens looking like a clone of the head office and then reports
 *    zero stock is a support call every single time.
 */
export function BranchSettings() {
  const api = useApi()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<number | null>(null)
  const [opening, setOpening] = useState(false)

  const active = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api.listStores() })

  const switchTo = useMutation({
    mutationFn: (id: number) => api.switchStore(id),
    onSuccess: (next) => {
      /* EVERYTHING. Every screen's data is store-scoped, and a missed key shows
         one branch's figures under another's name — which looks exactly like a
         busy day rather than like a bug. */
      void qc.invalidateQueries()
      toast.success(`Now billing for ${next.name}`, {
        description: 'Stock, bills, purchases and the day close all belong to this branch.',
      })
    },
    onError: (e) => toast.error('Could not switch branch', { description: (e as Error).message }),
  })

  if (stores.error || active.error) {
    return (
      <ErrorState
        code="BRANCHES_LOAD_FAILED"
        message={((stores.error ?? active.error) as Error).message}
        onRetry={() => { void stores.refetch(); void active.refetch() }}
      />
    )
  }
  if (stores.isPending || active.isPending || !stores.data || !active.data) {
    return <PanelShell><div className="card p-[var(--card-px)]"><SkeletonRows rows={4} cols={3} /></div></PanelShell>
  }

  const list = stores.data
  const activeId = active.data.id

  return (
    <PanelShell>
      <PanelHeader
        title="Branches"
        intro="Every shop in the chain, what each one issues, and which one this till is billing for."
        action={
          <Button
            variant={opening ? 'secondary' : 'primary'}
            onClick={() => { setOpening((o) => !o); setEditing(null) }}
          >
            {opening ? <><X /> Cancel</> : <><CirclePlus /> Open a branch</>}
          </Button>
        }
      />

      {opening ? (
        <NewBranchForm
          inheritFrom={active.data}
          siblings={list}
          onDone={() => setOpening(false)}
        />
      ) : null}

      <Section
        title="Shared across the chain, and not"
        icon={ShieldCheck}
        description="The line every new branch is surprised by."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SplitCard
            heading="One copy, chain-wide"
            items={['Medicine master', 'Barcodes', 'Suppliers and customers', 'Prescriber list', 'Branding and print templates']}
            tone="var(--accent-11)"
          />
          <SplitCard
            heading="Per branch, never merged"
            items={['Stock and batches', 'Bills and their numbering', 'Purchases and payables', 'The day close', 'Drug licence and UPI ID']}
            tone="var(--status-expiry-180)"
          />
        </div>
      </Section>

      <div className="flex flex-col" style={{ gap: 'var(--card-gap)' }}>
        {list.map((s) => (
          <BranchCard
            key={s.id}
            store={s}
            isActive={s.id === activeId}
            editing={editing === s.id}
            switching={switchTo.isPending}
            siblings={list}
            onEdit={() => { setEditing(editing === s.id ? null : s.id); setOpening(false) }}
            onSwitch={() => switchTo.mutate(s.id)}
          />
        ))}
      </div>
    </PanelShell>
  )
}

function SplitCard({ heading, items, tone }: { heading: string; items: string[]; tone: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border-subtle bg-subtle p-3.5">
      <span className="micro-label" style={{ color: tone }}>{heading}</span>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-fg-muted">
            <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
            {i}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------- one branch ---

function BranchCard({
  store, isActive, editing, switching, siblings, onEdit, onSwitch,
}: {
  store: StoreProfile
  isActive: boolean
  editing: boolean
  switching: boolean
  siblings: readonly StoreProfile[]
  onEdit: () => void
  onSwitch: () => void
}) {
  const prefixClash = siblings.some(
    (s) => s.id !== store.id
      && s.invoicePrefix.trim().toUpperCase() === store.invoicePrefix.trim().toUpperCase(),
  )

  return (
    <section
      className={cn(
        'card overflow-hidden',
        isActive && 'border-accent-9/40 ring-1 ring-accent-9/20',
      )}
    >
      <div className="flex flex-wrap items-start gap-4 p-[var(--card-px)]">
        <span
          aria-hidden
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-[var(--radius-lg)]',
            isActive ? 'bg-accent-10 text-fg-on-accent' : 'bg-inset text-fg-muted',
          )}
        >
          <Store size={20} strokeWidth={1.75} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight text-fg">{store.name}</h3>
            {isActive ? (
              <Chip icon={Check} tone="var(--accent-11)">Billing here</Chip>
            ) : null}
            {prefixClash ? (
              <Chip icon={ReceiptIndianRupee} tone="var(--danger-11)">Prefix clash</Chip>
            ) : null}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <MapPin size={13} aria-hidden />{store.addressLine}, {store.city}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Building size={13} aria-hidden />{store.phone}
            </span>
          </p>

          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            <Fact label="Series"><Code value={`${store.invoicePrefix}/…`} /></Fact>
            <Fact label="GSTIN"><Code value={store.gstin} /></Fact>
            <Fact label="Drug licence">
              <span className="flex flex-wrap gap-1.5">
                {store.dlNos.length === 0
                  ? <span className="text-sm text-danger-11">None — bills are not compliant</span>
                  : store.dlNos.map((d) => <Code key={d} value={d} />)}
              </span>
            </Fact>
            <Fact label="UPI">
              {store.upiVpa
                ? <Code value={store.upiVpa} />
                : <span className="text-sm text-fg-subtle">No QR on this branch's bills</span>}
            </Fact>
          </dl>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2">
          <Button onClick={onEdit} aria-expanded={editing}>
            {editing ? <><X /> Close</> : <><Pencil /> Edit</>}
          </Button>
          {isActive ? null : (
            <Button variant="secondary" disabled={switching} onClick={onSwitch}>
              <ArrowRightLeft /> Bill here
            </Button>
          )}
        </div>
      </div>

      {editing ? <BranchEditor store={store} isActive={isActive} /> : null}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

// ---------------------------------------------------------------- editing ---

interface EditDraft {
  name: string
  tagline: string
  addressLine: string
  city: string
  phone: string
  invoicePrefix: string
  upiVpa: string
  dlNos: string
}

function toEditDraft(s: StoreProfile): EditDraft {
  return {
    name: s.name,
    tagline: s.tagline ?? '',
    addressLine: s.addressLine,
    city: s.city,
    phone: s.phone,
    invoicePrefix: s.invoicePrefix,
    upiVpa: s.upiVpa ?? '',
    dlNos: s.dlNos.join(', '),
  }
}

function BranchEditor({ store, isActive }: { store: StoreProfile; isActive: boolean }) {
  const api = useApi()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<EditDraft>(() => toEditDraft(store))
  const [failedField, setFailedField] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: StoreProfilePatch) => api.updateBranch(store.id, patch),
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ['stores'] })
      if (isActive) qc.setQueryData(['store'], next)
      setFailedField(null)
      toast.success(`${next.name} saved`)
    },
    onError: (e) => {
      const field = e instanceof ApiError
        ? (e.details as { field?: string } | undefined)?.field ?? null
        : null
      setFailedField(field)
      toast.error('Not saved', { description: (e as Error).message })
    },
  })

  const set = <K extends keyof EditDraft>(key: K, value: EditDraft[K]) => {
    setFailedField(null)
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(toEditDraft(store))
  const id = (field: string) => `branch-${store.id}-${field}`

  return (
    <div className="border-t border-border-subtle bg-subtle p-[var(--card-px)]">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Branch name" name="name" failedField={failedField}>
          <input
            id={id('name')}
            aria-label={`Branch name for ${store.name}`}
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass(failedField === 'name')}
          />
        </Field>
        <Field label="Tagline">
          <input
            aria-label={`Tagline for ${store.name}`}
            value={draft.tagline}
            onChange={(e) => set('tagline', e.target.value)}
            className={inputClass()}
          />
        </Field>
        <Field label="Address" name="addressLine" failedField={failedField}>
          <input
            aria-label={`Address for ${store.name}`}
            value={draft.addressLine}
            onChange={(e) => set('addressLine', e.target.value)}
            className={inputClass(failedField === 'addressLine')}
          />
        </Field>
        <Field label="City" name="city" failedField={failedField}>
          <input
            aria-label={`City for ${store.name}`}
            value={draft.city}
            onChange={(e) => set('city', e.target.value)}
            className={inputClass(failedField === 'city')}
          />
        </Field>
        <Field label="Phone" name="phone" failedField={failedField}>
          <input
            aria-label={`Phone for ${store.name}`}
            value={draft.phone}
            onChange={(e) => set('phone', e.target.value)}
            className={inputClass(failedField === 'phone')}
          />
        </Field>
        <Field
          label="Invoice prefix"
          name="invoicePrefix"
          failedField={failedField}
          hint="Locked once this branch has issued documents in the current financial year."
        >
          <input
            aria-label={`Invoice prefix for ${store.name}`}
            value={draft.invoicePrefix}
            onChange={(e) => set('invoicePrefix', e.target.value)}
            maxLength={6}
            className={cn('mono uppercase', inputClass(failedField === 'invoicePrefix'))}
          />
        </Field>
        <Field
          label="Drug licence numbers"
          name="dlNos"
          failedField={failedField}
          hint="Separate two numbers with a comma. This branch's own — the head office's licence does not cover this counter."
        >
          <input
            aria-label={`Drug licences for ${store.name}`}
            value={draft.dlNos}
            onChange={(e) => set('dlNos', e.target.value)}
            className={cn('mono', inputClass(failedField === 'dlNos'))}
          />
        </Field>
        <Field
          label="UPI ID"
          name="upiVpa"
          failedField={failedField}
          hint="Goes into the QR on this branch's bills. Empty means no QR."
        >
          <input
            aria-label={`UPI ID for ${store.name}`}
            value={draft.upiVpa}
            onChange={(e) => set('upiVpa', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={inputClass(failedField === 'upiVpa')}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <span className="text-sm text-fg-muted" aria-live="polite">
          {dirty ? 'Unsaved changes.' : 'Everything is saved.'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(toEditDraft(store))}>
            Discard
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({
              name: draft.name,
              tagline: draft.tagline.trim() === '' ? null : draft.tagline.trim(),
              addressLine: draft.addressLine,
              city: draft.city,
              phone: draft.phone,
              invoicePrefix: draft.invoicePrefix,
              upiVpa: draft.upiVpa,
              dlNos: draft.dlNos.split(',').map((d) => d.trim()).filter((d) => d !== ''),
            })}
          >
            {save.isPending ? 'Saving…' : `Save ${store.name}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ opening one ---

function NewBranchForm({
  inheritFrom, siblings, onDone,
}: {
  inheritFrom: StoreProfile
  siblings: readonly StoreProfile[]
  onDone: () => void
}) {
  const api = useApi()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<NewBranch>(() => branchTemplate(inheritFrom))
  const [failedField, setFailedField] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: (profile: StoreProfile) => api.createStore(profile),
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: ['stores'] })
      toast.success(`${next.name} is open`, {
        description: `It issues the ${next.invoicePrefix} series and starts with no stock.`,
      })
      onDone()
    },
    onError: (e) => {
      const field = e instanceof ApiError
        ? (e.details as { field?: string } | undefined)?.field ?? null
        : null
      setFailedField(field)
      setRefusal((e as Error).message)
    },
  })

  const set = <K extends keyof NewBranch>(key: K, value: NewBranch[K]) => {
    setFailedField(null)
    setRefusal(null)
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function submit() {
    try {
      const profile = newBranchProfile(draft, inheritFrom, siblings)
      setRefusal(null)
      create.mutate(profile)
    } catch (e) {
      const field = e instanceof ApiError
        ? (e.details as { field?: string } | undefined)?.field ?? null
        : null
      setFailedField(field)
      setRefusal((e as Error).message)
    }
  }

  return (
    <Section
      title="Open a branch"
      icon={CirclePlus}
      description={`It inherits ${inheritFrom.name}'s tax thresholds, expiry guard and round-off policy, and needs its own premises, licence and number series.`}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Branch name" name="name" failedField={failedField}>
          <input
            aria-label="New branch name"
            value={draft.name}
            placeholder="Sanjeevani Medical — Kothrud"
            onChange={(e) => set('name', e.target.value)}
            className={inputClass(failedField === 'name')}
          />
        </Field>
        <Field label="Tagline" hint="Optional, printed under the name.">
          <input
            aria-label="New branch tagline"
            value={draft.tagline}
            onChange={(e) => set('tagline', e.target.value)}
            className={inputClass()}
          />
        </Field>
        <Field label="Address" name="addressLine" failedField={failedField}>
          <input
            aria-label="New branch address"
            value={draft.addressLine}
            placeholder="Shop 4, Paud Road"
            onChange={(e) => set('addressLine', e.target.value)}
            className={inputClass(failedField === 'addressLine')}
          />
        </Field>
        <Field label="City" name="city" failedField={failedField}>
          <input
            aria-label="New branch city"
            value={draft.city}
            onChange={(e) => set('city', e.target.value)}
            className={inputClass(failedField === 'city')}
          />
        </Field>
        <Field label="Phone" name="phone" failedField={failedField}>
          <input
            aria-label="New branch phone"
            value={draft.phone}
            onChange={(e) => set('phone', e.target.value)}
            className={inputClass(failedField === 'phone')}
          />
        </Field>
        <Field
          label="Invoice prefix"
          name="invoicePrefix"
          failedField={failedField}
          hint="Must differ from every other branch. Two branches on one prefix issue the same invoice number twice."
        >
          <input
            aria-label="New branch invoice prefix"
            value={draft.invoicePrefix}
            placeholder="KT"
            maxLength={6}
            onChange={(e) => set('invoicePrefix', e.target.value)}
            className={cn('mono uppercase', inputClass(failedField === 'invoicePrefix'))}
          />
        </Field>
        <Field
          label="GSTIN"
          name="gstin"
          failedField={failedField}
          hint="Copied from the head office. A branch in another state needs that state's own registration."
        >
          <input
            aria-label="New branch GSTIN"
            value={draft.gstin}
            maxLength={15}
            onChange={(e) => set('gstin', e.target.value)}
            className={cn('mono uppercase', inputClass(failedField === 'gstin'))}
          />
        </Field>
        <Field label="State code" name="stateCode" failedField={failedField} hint="Two digits.">
          <input
            aria-label="New branch state code"
            value={draft.stateCode}
            maxLength={2}
            inputMode="numeric"
            onChange={(e) => set('stateCode', e.target.value)}
            className={cn('num text-left', inputClass(failedField === 'stateCode'))}
          />
        </Field>
        <Field
          label="Drug licence numbers"
          name="dlNos"
          failedField={failedField}
          hint="Separate two with a comma. Issued against premises, so this branch needs its own."
        >
          <input
            aria-label="New branch drug licences"
            value={draft.dlNos.join(', ')}
            placeholder="MH-PN4-118B, MH-PN4-119B"
            onChange={(e) => set('dlNos', e.target.value.split(','))}
            className={cn('mono', inputClass(failedField === 'dlNos'))}
          />
        </Field>
        <Field
          label="UPI ID"
          name="upiVpa"
          failedField={failedField}
          hint="Optional. Empty means this branch's bills print without a QR."
        >
          <input
            aria-label="New branch UPI ID"
            value={draft.upiVpa}
            placeholder="kothrud@okaxis"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set('upiVpa', e.target.value)}
            className={inputClass(failedField === 'upiVpa')}
          />
        </Field>
      </div>

      {refusal ? (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-danger-9/30 bg-danger-3 px-3 py-2.5 text-sm text-danger-11"
        >
          <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="max-w-[76ch]">{refusal}</span>
        </p>
      ) : null}

      <Consequences items={branchConsequences(draft, inheritFrom)} />

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-4">
        <Button variant="ghost" onClick={onDone}>Discard this branch</Button>
        <Button variant="primary" disabled={create.isPending} onClick={submit}>
          <CirclePlus /> {create.isPending ? 'Opening…' : 'Open this branch'}
        </Button>
      </div>
    </Section>
  )
}
