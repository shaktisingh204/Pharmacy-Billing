import { useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight, CalendarClock, CircleAlert, CirclePlus, Info, Layers, Lock, Minus, Plus,
  Search, Tag, Trash2, TrendingDown, TrendingUp,
} from 'lucide-react'
import type { PriceRule, PriceScope } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import {
  MAX_POLICY_DISCOUNT, SCOPE_LABEL, checkEffectiveFrom, checkRules, diffRules,
  pendingRevisions, revisionInForce,
} from '@/api/pricePolicy'
import { can } from '@/api/users'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Consequences, Field, PanelHeader, PanelShell, Section, inputClass } from './SettingsForm'

/**
 * The chain's price list.
 *
 * A chain that decides its prices at the counter does not have prices. The same
 * strip goes out at 8% off in one shop and 3% in another, the customer who uses
 * both notices before the owner does, and nobody can say what the chain's margin
 * actually is. This is where that is decided once.
 *
 * Three things shape the screen, and each is a consequence of the domain rather
 * than a layout preference:
 *
 *  - IT PUSHES DISCOUNTS, NEVER PRICES. MRP is printed on the strip and is part
 *    of a batch's identity. HQ decides how much of it the chain gives back; it
 *    cannot decide what a factory printed months ago. So every figure here is a
 *    percentage off, and a negative one is not representable.
 *  - THE DIFF IS THE PRODUCT. A branch handed a hundred-rule list reads none of
 *    it. A branch told "Cipla 9% → 7%, two items dropped" checks two prices. So
 *    the editor shows what will change BEFORE publishing, and the branch view
 *    shows what changed after — both from `diffRules`, never re-derived here.
 *  - A PUBLISHED LIST IS IMMUTABLE. Correcting a price means publishing again,
 *    the same way correcting an invoice means a credit note. It is the only
 *    reason "what were we charging in March" is answerable at all.
 */
export function PricingSettings() {
  const api = useApi()
  const qc = useQueryClient()

  const revisions = useQuery({ queryKey: ['priceRevisions'], queryFn: () => api.listPriceRevisions() })
  const me = useQuery({ queryKey: ['currentUser'], queryFn: () => api.currentUser() })
  const catalogue = useQuery({
    queryKey: ['medicines', 'pricing-companies'],
    queryFn: () => api.listMedicines({ limit: 1 }),
  })

  const today = new Date().toISOString().slice(0, 10)
  const rows = useMemo(() => revisions.data ?? [], [revisions.data])
  const live = useMemo(() => revisionInForce(rows, today), [rows, today])
  const pending = useMemo(() => pendingRevisions(rows, today), [rows, today])

  const mayPublish = me.data ? can(me.data, 'settings.pricing') : false

  if (revisions.error) {
    return (
      <ErrorState
        code={revisions.error instanceof ApiError ? revisions.error.code : 'PRICE_LIST_FAILED'}
        message={(revisions.error as Error).message}
        onRetry={() => void revisions.refetch()}
      />
    )
  }

  return (
    <PanelShell>
      <PanelHeader
        title="Chain price list"
        intro={
          'One list, published centrally, applied at every branch. It sets a discount off the '
          + 'printed MRP — never a price, because the MRP on the strip is what the customer pays '
          + 'and no head office can change it after the fact.'
        }
        action={live ? <Chip tone="success">List {live.serial} in force</Chip> : null}
      />

      <Section
        title="What every branch is billing at"
        icon={Tag}
        description={
          live
            ? `Published by ${live.publishedBy}, in force since ${live.effectiveFrom}.`
            : 'Nothing has been published yet, so no line is priced by policy.'
        }
        aside={live ? <span className="num text-sm text-fg-muted">{live.rules.length} rules</span> : null}
      >
        {revisions.isPending ? (
          <SkeletonRows rows={3} cols={3} />
        ) : live ? (
          <RuleTable rules={live.rules} />
        ) : (
          <EmptyState
            icon={Tag}
            title="No price list yet"
            body={
              'Until one is published every line starts at zero discount and the counter decides. '
              + 'That is a working shop, not a chain.'
            }
          />
        )}
        {live?.note ? (
          <p className="mt-3 border-l-2 border-border pl-3 text-sm italic text-fg-muted">{live.note}</p>
        ) : null}
      </Section>

      {pending.length > 0 && (
        <Section
          title="Starting soon"
          icon={CalendarClock}
          description="Published and dated forward. Nothing on a bill changes until the day it starts."
        >
          {pending.map((next) => (
            <article key={next.id} className="rounded-[var(--radius-lg)] border border-border bg-subtle p-[var(--card-px)]">
              <header className="flex flex-wrap items-baseline gap-2">
                <span className="text-base font-semibold text-fg">List {next.serial}</span>
                <Chip tone="warning">
                  <CalendarClock size={12} aria-hidden />
                  From {next.effectiveFrom}
                </Chip>
                <span className="text-sm text-fg-muted">by {next.publishedBy}</span>
              </header>
              {next.note ? <p className="mt-1.5 text-sm text-fg-muted">{next.note}</p> : null}
              <ChangeList changes={diffRules(live?.rules ?? [], next.rules)} />
            </article>
          ))}
        </Section>
      )}

      {mayPublish ? (
        <Publisher
          baseRules={live?.rules ?? []}
          today={today}
          companies={catalogue.data?.manufacturers ?? []}
          onPublished={() => {
            void qc.invalidateQueries({ queryKey: ['priceRevisions'] })
          }}
        />
      ) : (
        <Section
          title="Publishing"
          icon={Lock}
          description="Reading the list needs no permission. Changing it does."
        >
          <p className="text-base text-fg-muted">
            {'Your account cannot publish a price list. That is deliberate — a price change reaches '
             + 'every branch at once, so it sits behind its own permission rather than behind the '
             + 'general settings one.'}
          </p>
        </Section>
      )}

      {rows.length > 1 && (
        <Section title="Every list published" icon={Layers} description="Immutable, newest first.">
          <ol className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border-subtle pb-1.5 text-sm last:border-0"
              >
                <span className="num w-14 shrink-0 font-medium text-fg">List {r.serial}</span>
                <span className="num text-fg-muted">from {r.effectiveFrom}</span>
                <span className="num text-fg-subtle">{r.rules.length} rules</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{r.note || '—'}</span>
                <span className="shrink-0 text-fg-subtle">{r.publishedBy}</span>
                {r.id === live?.id && <Chip tone="success">In force</Chip>}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </PanelShell>
  )
}

/* --------------------------------------------------------------- reading --- */

const SCOPE_TONE: Record<PriceScope, 'accent' | 'neutral'> = {
  MEDICINE: 'accent', COMPANY: 'accent', ALL: 'neutral',
}

function RuleTable({ rules }: { rules: readonly PriceRule[] }) {
  if (rules.length === 0) {
    return <p className="text-base text-fg-muted">This list has no rules, so nothing is priced by it.</p>
  }
  return (
    <table className="w-full text-base">
      <caption className="sr-only">Price rules in force</caption>
      <thead>
        <tr className="border-b border-border-subtle text-left">
          <th className="micro-label pb-1.5 font-medium">Applies to</th>
          <th className="micro-label pb-1.5 font-medium">Which</th>
          <th className="micro-label pb-1.5 text-right font-medium">Off MRP</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={`${r.scope}-${r.target}`} className="border-b border-border-subtle last:border-0">
            <td className="py-2">
              <Chip tone={SCOPE_TONE[r.scope]}>{SCOPE_LABEL[r.scope]}</Chip>
            </td>
            <td className="py-2 text-fg">{r.label || '—'}</td>
            <td className="num py-2 text-right font-medium text-fg">{r.discountPct}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ChangeList({ changes }: { changes: ReturnType<typeof diffRules> }) {
  if (changes.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-sm text-fg-muted">
        <Info size={14} aria-hidden />
        No price moves. Same figures as the list in force.
      </p>
    )
  }
  return (
    <ul className="mt-2.5 flex flex-col gap-1.5">
      {changes.map((c) => {
        /* Icon AND word, never the colour alone: this is read on a matte panel
           at an angle, and "cheaper" versus "dearer" is the whole message. */
        const cheaper = c.kind === 'ADDED' || (c.to !== null && c.from !== null && Number(c.to) > Number(c.from))
        const Icon = c.kind === 'REMOVED' ? Minus : cheaper ? TrendingDown : TrendingUp
        return (
          <li key={`${c.scope}-${c.target}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <Icon
              size={14}
              aria-hidden
              className={cn('self-center', c.kind === 'REMOVED' ? 'text-fg-subtle' : cheaper ? 'text-success-11' : 'text-warning-11')}
            />
            <span className="font-medium text-fg">{c.label || SCOPE_LABEL[c.scope]}</span>
            {c.kind === 'ADDED' && <span className="text-fg-muted">newly priced at</span>}
            {c.kind === 'REMOVED' && <span className="text-fg-muted">no longer priced — falls through to the next rule; was</span>}
            {c.kind === 'CHANGED' && (
              <span className="num text-fg-muted">
                {c.from}%
                <ArrowRight size={12} className="mx-1 inline align-middle" aria-hidden />
              </span>
            )}
            <span className="num font-medium text-fg">{(c.to ?? c.from)}%</span>
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------------------- writing --- */

interface Draft extends PriceRule {
  /** Local only, so a row keeps its identity while its target is still blank. */
  key: string
}

let draftSeq = 0
const nextKey = (): string => `d${(draftSeq += 1)}`

const toDraft = (r: PriceRule): Draft => ({ ...r, key: nextKey() })

function Publisher({
  baseRules, today, companies, onPublished,
}: {
  baseRules: readonly PriceRule[]
  today: string
  companies: readonly string[]
  onPublished: () => void
}) {
  const api = useApi()
  /* Seeded from the list in force, so publishing is an EDIT rather than a
     re-type. Re-typing a hundred rules to change one is how a price list
     acquires a typo nobody notices for a month. */
  const [drafts, setDrafts] = useState<Draft[]>(() => baseRules.map(toDraft))
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [note, setNote] = useState('')

  const rules = useMemo<PriceRule[]>(
    () => drafts.map(({ key: _key, ...rule }) => rule),
    [drafts],
  )
  const faults = useMemo(() => checkRules(rules), [rules])
  const dateFault = checkEffectiveFrom(effectiveFrom, today)
  const changes = useMemo(() => diffRules(baseRules, rules), [baseRules, rules])
  const faultAt = (index: number) => faults.find((f) => f.index === index)?.reason ?? null

  /* Identifies the ATTEMPT, not its content.
     A key derived from the rules would collapse a genuine revert onto the
     revision it reverts to: publish A, publish B, then decide B was wrong and
     publish A's prices again — the content key matches A, and the shop is handed
     back a months-old revision instead of a new one. So the key is minted per
     attempt and rotated on success: a retry of one attempt lands once, and two
     attempts are two revisions even when they say the same thing. */
  const [attempt, setAttempt] = useState(() => nanoid(10))

  const publish = useMutation({
    mutationFn: () => api.publishPriceRevision({
      effectiveFrom,
      note,
      rules,
      idempotencyKey: `price:${attempt}`,
    }),
    onSuccess: (rev) => {
      toast.success(`List ${rev.serial} published`, {
        description: rev.effectiveFrom === today
          ? 'Every branch bills at these prices from now.'
          : `Every branch switches to these prices on ${rev.effectiveFrom}.`,
      })
      setNote('')
      setAttempt(nanoid(10))
      onPublished()
    },
    onError: (e: unknown) => {
      toast.error('Not published', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const blocked = faults.length > 0 || dateFault !== null || changes.length === 0

  return (
    <Section
      title="Publish a new list"
      icon={CirclePlus}
      description="Starts from the list in force. Change what moves, leave the rest."
      aside={
        <span className="num text-sm text-fg-muted">
          {changes.length === 0 ? 'no changes' : `${changes.length} price${changes.length === 1 ? '' : 's'} move`}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <RuleRow
              key={d.key}
              draft={d}
              index={i}
              companies={companies}
              fault={faultAt(i)}
              onChange={(next) => setDrafts((all) => all.map((r) => (r.key === d.key ? next : r)))}
              onRemove={() => setDrafts((all) => all.filter((r) => r.key !== d.key))}
            />
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setDrafts((all) => [
              ...all,
              { key: nextKey(), scope: 'COMPANY', target: '', label: '', discountPct: '' },
            ])}
          >
            <Plus size={15} aria-hidden />
            Add a rule
          </Button>
          {!drafts.some((d) => d.scope === 'ALL') && (
            <Button
              variant="ghost"
              onClick={() => setDrafts((all) => [
                ...all,
                { key: nextKey(), scope: 'ALL', target: '', label: 'Everything else', discountPct: '' },
              ])}
            >
              <Plus size={15} aria-hidden />
              Add a catch-all
            </Button>
          )}
        </div>

        {/* The consequence a price list actually has, stated before publishing
            rather than discovered at a counter. */}
        <Consequences
          items={[
            ...(drafts.some((d) => d.scope === 'ALL')
              ? []
              : ['No catch-all rule: any medicine no rule names sells at zero discount.']),
            ...(changes.some((c) => c.kind === 'REMOVED')
              ? ['A removed rule is a price change — whatever it covered falls through to the next rule, or to zero.']
              : []),
          ]}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Starts on"
            hint="Bills before this day keep the price they were posted at."
            name="effectiveFrom"
            failedField={dateFault ? 'effectiveFrom' : null}
          >
            <input
              type="date"
              min={today}
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className={inputClass(dateFault !== null)}
              aria-invalid={dateFault !== null}
            />
            {dateFault ? (
              <span className="flex items-center gap-1.5 text-sm text-danger-11">
                <CircleAlert size={14} aria-hidden />
                {dateFault}
              </span>
            ) : null}
          </Field>
          <Field label="Why" hint="Printed on every branch's screen beside the list.">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Festival week — deeper on generics"
              className={inputClass(false)}
            />
          </Field>
        </div>

        <div className="rounded-[var(--radius-lg)] border border-border bg-subtle p-[var(--card-px)]">
          <h4 className="micro-label">What every branch will see change</h4>
          <ChangeList changes={changes} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => publish.mutate()} disabled={blocked || publish.isPending}>
            {publish.isPending ? 'Publishing…' : 'Publish to every branch'}
          </Button>
          {/* Says WHY it is disabled. A dead button with no reason beside it is
              the thing people file a support ticket about. */}
          <span className="text-sm text-fg-muted">
            {faults.length > 0
              ? `${faults.length} rule${faults.length === 1 ? '' : 's'} to fix first.`
              : dateFault
                ? 'Pick a start date.'
                : changes.length === 0
                  ? 'Nothing has changed from the list in force.'
                  : 'Published lists cannot be edited — correcting one means publishing again.'}
          </span>
        </div>
      </div>
    </Section>
  )
}

function RuleRow({
  draft, index, companies, fault, onChange, onRemove,
}: {
  draft: Draft
  index: number
  companies: readonly string[]
  fault: string | null
  onChange: (next: Draft) => void
  onRemove: () => void
}) {
  const api = useApi()
  const [term, setTerm] = useState('')

  /* Only for a MEDICINE row, and only once something is typed. A settings panel
     must not fire a catalogue search per keystroke for rows that will never use
     one. */
  const hits = useQuery({
    queryKey: ['medicines', 'price-target', term],
    queryFn: () => api.searchMedicines({ term, limit: 6, includeOutOfStock: true }),
    enabled: draft.scope === 'MEDICINE' && term.trim().length >= 2,
  })

  return (
    <li
      className={cn(
        'rounded-[var(--radius-lg)] border p-3',
        fault ? 'border-danger-9/40 bg-danger-3' : 'border-border bg-surface',
      )}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Applies to" className="w-[9.5rem]">
          <select
            value={draft.scope}
            onChange={(e) => {
              const scope = e.target.value as PriceScope
              onChange({
                ...draft,
                scope,
                // Both the target and the label are cleared: a row that kept
                // "Cipla" after switching to a medicine rule would be a row
                // showing one thing and carrying another.
                target: '',
                label: scope === 'ALL' ? 'Everything else' : '',
              })
              setTerm('')
            }}
            className={inputClass(false)}
          >
            {(['MEDICINE', 'COMPANY', 'ALL'] as const).map((s) => (
              <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
            ))}
          </select>
        </Field>

        <Field label="Which" className="min-w-[14rem] flex-1">
          {draft.scope === 'ALL' ? (
            <input
              value="Every medicine no other rule names"
              readOnly
              className={cn(inputClass(false), 'bg-inset text-fg-muted')}
            />
          ) : draft.scope === 'COMPANY' ? (
            <>
              <input
                list={`companies-${draft.key}`}
                value={draft.label}
                onChange={(e) => onChange({ ...draft, target: e.target.value, label: e.target.value })}
                placeholder="Cipla"
                className={inputClass(fault !== null && draft.target.trim() === '')}
              />
              <datalist id={`companies-${draft.key}`}>
                {companies.map((c) => <option key={c} value={c} />)}
              </datalist>
            </>
          ) : (
            <>
              <input
                value={draft.label || term}
                onChange={(e) => {
                  setTerm(e.target.value)
                  /* Typing again clears the pick. A row showing one medicine's
                     name while carrying another's id is the worst outcome here. */
                  onChange({ ...draft, target: '', label: '' })
                }}
                placeholder="Search a medicine"
                className={inputClass(fault !== null && draft.target.trim() === '')}
              />
              {draft.target === '' && (hits.data ?? []).length > 0 && (
                <ul className="mt-1 max-h-44 overflow-auto rounded-[var(--radius-md)] border border-border bg-surface">
                  {(hits.data ?? []).map(({ medicine: m }) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-hover"
                        onClick={() => {
                          onChange({ ...draft, target: String(m.id), label: m.brandName })
                          setTerm('')
                        }}
                      >
                        <Search size={12} className="shrink-0 text-fg-subtle" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-fg">{m.brandName}</span>
                        <span className="shrink-0 text-fg-subtle">{m.manufacturer}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Field>

        <Field label="Off MRP" className="w-[7.5rem]">
          <div className="flex items-center gap-1.5">
            <input
              inputMode="decimal"
              value={draft.discountPct}
              onChange={(e) => onChange({ ...draft, discountPct: e.target.value })}
              placeholder="0"
              max={MAX_POLICY_DISCOUNT}
              className={cn(inputClass(fault !== null), 'num text-right')}
              aria-invalid={fault !== null}
              aria-label={`Discount for rule ${index + 1}`}
            />
            <span className="text-base text-fg-muted">%</span>
          </div>
        </Field>

        <Button variant="ghost" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
          <Trash2 size={15} aria-hidden />
        </Button>
      </div>

      {fault ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-danger-11">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          {fault}
        </p>
      ) : null}
    </li>
  )
}
