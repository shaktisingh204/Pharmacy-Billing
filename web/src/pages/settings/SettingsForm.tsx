import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleAlert, Info } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { StoreProfile, StoreProfilePatch } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { warningsFor } from '@/api/storeSettings'
import { Button } from '@/components/ui/Button'
import { ErrorState, SkeletonRows } from '@/components/states'

/**
 * The shared spine of the editable settings panels.
 *
 * One place that loads the store, tracks the draft, shows what a change WOULD do
 * before it is made, and reports the adapter's refusal against the field it came
 * from. Two panels doing that separately is how one of them ends up silently
 * swallowing an error the other surfaces.
 */
export function StoreForm({
  title,
  intro,
  children,
}: {
  title: string
  intro: string
  children: (ctx: FormContext) => React.ReactNode
}) {
  const api = useApi()
  const qc = useQueryClient()
  const [patch, setPatch] = useState<StoreProfilePatch>({})
  const [failedField, setFailedField] = useState<string | null>(null)

  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })

  const save = useMutation({
    mutationFn: (p: StoreProfilePatch) => api.updateStore(p),
    onSuccess: (next) => {
      qc.setQueryData(['store'], next)
      void qc.invalidateQueries({ queryKey: ['filing'] })
      /* The branch list carries the same rows under a different key, and the
         chip in the top bar reads it. Leaving it stale renames the shop
         everywhere except the one place that says which shop you are billing
         for. */
      void qc.invalidateQueries({ queryKey: ['stores'] })
      setPatch({})
      setFailedField(null)
      toast.success('Settings saved')
    },
    onError: (e) => {
      /* The refusal is shown AGAINST THE FIELD as well as in the toast. A
         message about the invoice prefix that appears only in a corner, on a
         form with a dozen inputs, is a message about nothing. */
      const field = e instanceof ApiError
        ? (e.details as { field?: string } | undefined)?.field ?? null
        : null
      setFailedField(field)
      toast.error('Not saved', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const warnings = useMemo(
    () => (store.data ? warningsFor(store.data, patch) : []),
    [store.data, patch],
  )

  if (store.error) {
    return (
      <ErrorState
        code="STORE_LOAD_FAILED"
        message={(store.error as Error).message}
        onRetry={() => void store.refetch()}
      />
    )
  }
  if (store.isPending || !store.data) {
    return <PanelShell><div className="card p-[var(--card-px)]"><SkeletonRows rows={6} cols={2} /></div></PanelShell>
  }

  const dirty = Object.keys(patch).length > 0
  const value = { ...store.data, ...patch, filing: { ...store.data.filing, ...patch.filing } }

  const ctx: FormContext = {
    store: value,
    saved: store.data,
    dirty,
    failedField,
    set: (key, v) => {
      setFailedField(null)
      setPatch((p) => ({ ...p, [key]: v }))
    },
    setFiling: (key, v) => {
      setFailedField(null)
      setPatch((p) => ({ ...p, filing: { ...p.filing, [key]: v } }))
    },
  }

  return (
    <PanelShell>
      <PanelHeader title={title} intro={intro} />

      {children(ctx)}

      <Consequences items={warnings} />

      <SaveBar
        dirty={dirty}
        busy={save.isPending}
        onDiscard={() => { setPatch({}); setFailedField(null) }}
        onSave={() => save.mutate(patch)}
      />
    </PanelShell>
  )
}

export interface FormContext {
  /** The saved profile with the unsaved draft laid over it. */
  store: StoreProfile
  /** What is actually on disk, for a panel that wants to show the difference. */
  saved: StoreProfile
  dirty: boolean
  /** The field the last refusal named, so it can be marked. */
  failedField: string | null
  set: <K extends keyof StoreProfilePatch>(key: K, value: StoreProfilePatch[K]) => void
  setFiling: (key: 'b2clMinimum' | 'rule46Minimum' | 'hsnDigits', value: never) => void
}

// ------------------------------------------------------------- the shell ---

/**
 * Every panel sits in the same column.
 *
 * Measured rather than fluid: a settings form stretched across a 1600px counter
 * monitor puts the label and its input at opposite ends of the desk, and the eye
 * loses the pairing somewhere in the middle.
 */
export function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto flex w-full max-w-[860px] flex-col pb-10"
      style={{ gap: 'var(--card-gap)', padding: 'var(--card-px)' }}
    >
      {children}
    </div>
  )
}

export function PanelHeader({
  title, intro, action,
}: {
  title: string
  intro: string
  action?: ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-6 pb-1">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        <p className="mt-1 max-w-[68ch] text-base text-fg-muted">{intro}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}

/**
 * A card with a titled head. The icon sits in a tinted square rather than beside
 * the words: at this size a bare 15px glyph on white reads as debris.
 */
export function Section({
  title, icon: Icon, description, aside, children,
}: {
  title: string
  icon: LucideIcon
  description?: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header
        className="flex items-start gap-3 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-3"
      >
        <span
          aria-hidden
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent-2 text-accent-11"
        >
          <Icon size={15} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          {description ? (
            <p className="mt-0.5 max-w-[70ch] text-sm text-fg-muted">{description}</p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </header>
      <div className="flex flex-col gap-5 p-[var(--card-px)]">{children}</div>
    </section>
  )
}

/** Allowed changes that land somewhere other than this screen. */
export function Consequences({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col gap-2">
      {items.map((w) => (
        <li
          key={w}
          className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-warning-9/25 bg-warning-3 px-3 py-2.5 text-sm text-warning-11"
        >
          <Info size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="max-w-[76ch]">{w}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Pinned to the foot of the scroll region.
 *
 * A settings form is taller than the pane on every panel here, and a Save button
 * that has scrolled off is a form people abandon half-edited — which on this
 * screen means a GSTIN that is half changed.
 */
export function SaveBar({
  dirty, busy, onDiscard, onSave, label = 'Save',
}: {
  dirty: boolean
  busy: boolean
  onDiscard: () => void
  onSave: () => void
  label?: string
}) {
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-[var(--card-px)] -mb-10 mt-1 flex items-center gap-3',
        'border-t border-border bg-raised/95 px-[var(--card-px)] py-3 backdrop-blur',
      )}
    >
      <span
        className={cn('text-sm', dirty ? 'font-medium text-warning-11' : 'text-fg-muted')}
        aria-live="polite"
      >
        {dirty ? 'Unsaved changes.' : 'Everything is saved.'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" disabled={!dirty || busy} onClick={onDiscard}>Discard</Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={onSave}>
          {busy ? 'Saving…' : label}
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- the parts ---

export function Field({
  label, hint, name, failedField, children, className,
}: {
  label: string
  hint?: ReactNode
  name?: string
  failedField?: string | null
  children: ReactNode
  className?: string
}) {
  const failed = name !== undefined && failedField === name
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className={cn('micro-label', failed && 'text-danger-11')}>{label}</span>
      {children}
      {hint ? (
        <span className={cn('max-w-[70ch] text-xs', failed ? 'text-danger-11' : 'text-fg-subtle')}>
          {failed ? <CircleAlert size={12} className="mr-1 inline align-[-2px]" aria-hidden /> : null}
          {hint}
        </span>
      ) : null}
    </label>
  )
}

export const inputClass = (failed?: boolean): string => cn(
  'h-[var(--control-h)] w-full min-w-0 rounded-[var(--radius-md)] border bg-surface px-3 text-base',
  'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
  failed ? 'border-danger-9/60 bg-danger-3/40' : 'border-border hover:border-border-strong',
)

export function Toggle({
  checked, onChange, label, hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-border-subtle bg-subtle px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-[var(--accent-9)]"
      />
      <span className="min-w-0">
        <span className="block text-base text-fg">{label}</span>
        <span className="mt-0.5 block max-w-[70ch] text-xs text-fg-muted">{hint}</span>
      </span>
    </label>
  )
}
