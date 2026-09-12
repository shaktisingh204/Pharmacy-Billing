import { useState } from 'react'
import { Cake, Eraser, MonitorSmartphone, NotebookPen, Plus, ShieldAlert, Stethoscope, X } from 'lucide-react'
import type { Customer } from '@contract'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Section } from './sheet'
import { formatLongDay } from './CustomerTable'
import type { CareFile } from './careFile'
import { CONDITION_SUGGESTIONS, ageOn, isDob, nextBirthday } from './careFile'

/**
 * The care file editor.
 *
 * Two rules, and the first one is the reason this tab is not simply "edit
 * customer":
 *
 *  1. ALLERGIES ARE READ-ONLY HERE. They live on the customer master, they are
 *     the one dispensing control on this screen, and the API has no customer
 *     update — so offering an editable allergy box would either silently drop
 *     what was typed or fork the safety-critical field onto one machine. It is
 *     shown, it is labelled as coming from the master, and the operator is told
 *     where it is actually captured.
 *  2. EVERYTHING ELSE SAYS WHERE IT LIVES. Conditions, the date of birth and the
 *     counter note are held on THIS DEVICE, and the panel says so in as many
 *     words rather than letting a second till discover it the hard way.
 */

export function CarePanel({
  customer,
  file,
  today,
  onChange,
  onClear,
}: {
  customer: Customer
  file: CareFile
  today: Date
  onChange: (patch: Partial<CareFile>) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState(file.note ?? '')
  const [dob, setDob] = useState(file.dob ?? '')

  const age = ageOn(file.dob, today)
  const birthday = nextBirthday(file.dob, today)
  const dobRejected = dob !== '' && !isDob(dob, today)

  const add = (value: string) => {
    const text = value.trim()
    if (!text) return
    onChange({ conditions: [...file.conditions, text] })
    setDraft('')
  }

  const unused = CONDITION_SUGGESTIONS.filter(
    (s) => !file.conditions.some((c) => c.toLowerCase() === s.toLowerCase()),
  )

  return (
    <div>
      <Section title="Allergies" icon={ShieldAlert} note="from the customer master">
        {customer.allergies.length === 0 ? (
          <p className="px-[var(--card-px)] pb-3 text-sm text-fg-muted">
            None recorded — ask before dispensing. Allergies are captured on the customer record at
            the counter, which is where a new one gets added.
          </p>
        ) : (
          <div className="px-[var(--card-px)] pb-3">
            <p className="flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-2.5 py-2 text-sm text-danger-11">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-danger-9" aria-hidden />
              <span>
                <span className="font-semibold">Allergic to</span> {customer.allergies.join(', ')}
              </span>
            </p>
            <p className="mt-1.5 text-2xs text-fg-subtle">
              Held on the customer record itself, so every till sees it. Edited at the counter.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Chronic conditions"
        icon={Stethoscope}
        note={file.conditions.length > 0 ? `${file.conditions.length} recorded` : undefined}
      >
        <div className="px-[var(--card-px)] pb-3">
          {file.conditions.length > 0 ? (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {file.conditions.map((c) => (
                <li key={c}>
                  <span className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-md)] border border-info-9/25 bg-info-3 pl-2 pr-1 text-xs font-medium text-info-11">
                    <Stethoscope size={12} aria-hidden />
                    {c}
                    <button
                      type="button"
                      aria-label={`Remove ${c}`}
                      onClick={() => onChange({ conditions: file.conditions.filter((x) => x !== c) })}
                      className="flex size-5 items-center justify-center rounded-[var(--radius-sm)] text-info-11 hover:bg-info-9/15 hover:text-info-11"
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-sm text-fg-muted">
              Nothing noted. What somebody is on long term is what turns a repeat purchase into a
              refill you can plan for — and it is the first thing the next person on the till asks.
            </p>
          )}

          <div className="flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft) } }}
              placeholder="Type a condition and press Enter"
              aria-label="Add a chronic condition"
              autoComplete="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm placeholder:text-fg-subtle hover:border-border-strong"
            />
            <Button size="sm" onClick={() => add(draft)} disabled={draft.trim() === ''}>
              <Plus /> Add
            </Button>
          </div>

          {unused.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {unused.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => add(s)}
                  className="inline-flex h-6 items-center gap-1 rounded-[var(--radius-full)] border border-border-subtle bg-surface px-2 text-2xs text-fg-muted hover:border-border-strong hover:text-fg"
                >
                  <Plus size={11} aria-hidden />{s}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="Date of birth" icon={Cake}>
        <div className="px-[var(--card-px)] pb-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="micro-label">Born</span>
              <input
                type="date"
                value={dob}
                onChange={(e) => {
                  setDob(e.target.value)
                  if (e.target.value === '' || isDob(e.target.value, today)) {
                    onChange({ dob: e.target.value || null })
                  }
                }}
                aria-invalid={dobRejected}
                className={cn(
                  'mono h-9 rounded-[var(--radius-md)] border bg-surface px-2 text-sm',
                  dobRejected ? 'border-danger-9' : 'border-border hover:border-border-strong',
                )}
              />
            </label>
            {age !== null ? (
              <span className="flex flex-col">
                <span className="micro-label">Age</span>
                <span className="num text-lg font-semibold text-fg">{age}</span>
              </span>
            ) : null}
          </div>

          {dobRejected ? (
            <p role="alert" className="mt-1.5 text-2xs text-danger-11">
              That is not a date somebody could have been born on. It has to be in the past and
              within a human lifetime.
            </p>
          ) : birthday ? (
            <p className="mt-1.5 text-2xs text-fg-muted">
              Turning <span className="num">{birthday.turning}</span> on {formatLongDay(birthday.on)}
              {birthday.inDays === 0 ? ' — today' : ` — in ${birthday.inDays} day${birthday.inDays === 1 ? '' : 's'}`}.
              Appears in the reminders list a fortnight ahead.
            </p>
          ) : (
            <p className="mt-1.5 text-2xs text-fg-subtle">
              A date of birth is what puts this customer on the birthday reminders — and it is worth
              having on a paediatric or geriatric dose conversation anyway.
            </p>
          )}
        </div>
      </Section>

      <Section title="Counter note" icon={NotebookPen}>
        <div className="px-[var(--card-px)] pb-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => onChange({ note })}
            rows={3}
            maxLength={400}
            aria-label="Counter note"
            placeholder="Anything the next person on the till needs to know — prefers a particular brand, collects for a parent, pays on the first."
            className="w-full resize-none rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-2 text-sm placeholder:text-fg-subtle hover:border-border-strong"
          />
          <p className="mt-1 text-2xs text-fg-subtle">Saved when you click away. {400 - note.length} characters left.</p>
        </div>
      </Section>

      <div className="flex items-start gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
        <MonitorSmartphone size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
        <p className="min-w-0 flex-1 text-2xs text-fg-muted">
          Conditions, date of birth and the note are kept <strong>on this device</strong>. The
          customer API has no field for them, so a second till will not see what is typed here.
          Allergies are on the customer record itself and travel everywhere.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setNote(''); setDob(''); onClear() }}
          disabled={file.conditions.length === 0 && file.dob === null && file.note === null}
        >
          <Eraser /> Clear
        </Button>
      </div>
    </div>
  )
}
