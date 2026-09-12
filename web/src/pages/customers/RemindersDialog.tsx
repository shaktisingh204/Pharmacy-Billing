import { useState } from 'react'
import { Dialog } from 'radix-ui'
import {
  AlarmClock, BellRing, Cake, Check, Copy, Download, PhoneOff, Repeat, ScanBarcode, X,
} from 'lucide-react'
import type { IsoDate } from '@contract'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState } from '@/components/states'
import { formatDay, refillWords } from './CustomerTable'
import type { BirthdayDue } from './careFile'
import type { RefillDue } from './profile'
import { callListText, downloadCallList, toCallRows } from './callList'

/**
 * The reminders an owner can work down before the shop gets busy.
 *
 * Two lists, deliberately in one place and deliberately in this order. A refill
 * that is late is a customer who has either run out or bought it somewhere else,
 * and it costs the shop money today; a birthday is goodwill. Both are worked the
 * same way — by picking up the phone — which is why the list leaves as text as
 * well as being clickable, and why every row carries its own reason.
 *
 * A row with no phone number is shown, not hidden. It cannot be rung, and that
 * is exactly the thing the shop needs to see: the record has to be fixed the
 * next time that customer walks in.
 */

const HORIZONS = [7, 14, 30] as const
export type Horizon = (typeof HORIZONS)[number]

export function RemindersDialog({
  open,
  onOpenChange,
  refills,
  birthdays,
  horizon,
  onHorizonChange,
  today,
  onOpenCustomer,
  onGoToBilling,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  refills: readonly RefillDue[]
  birthdays: readonly BirthdayDue[]
  horizon: Horizon
  onHorizonChange: (h: Horizon) => void
  today: IsoDate
  onOpenCustomer: (id: number) => void
  onGoToBilling: () => void
}) {
  const [copied, setCopied] = useState(false)

  /* Claims the narrowest scope while open, so a key this dialog does not
     implement cannot reach the grid underneath and move the selection out from
     under whoever is reading the list. */
  useHotkeys('modal', {}, { enabled: open })

  const rows = toCallRows(refills, birthdays)
  const overdue = refills.filter((r) => r.dueInDays < 0).length

  const copy = () => {
    void navigator.clipboard?.writeText(callListText(rows, today)).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      },
      // A blocked clipboard is not an error worth a toast over the list itself;
      // the CSV button beside it does the same job and cannot be refused.
      () => setCopied(false),
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          data-density="comfortable"
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-[520px] max-w-[92vw] flex-col',
            'border-l border-border bg-surface shadow-[var(--shadow-overlay)]',
          )}
        >
          <div className="flex shrink-0 items-start gap-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
            <span aria-hidden className="mt-0.5 flex size-9 items-center justify-center rounded-[var(--radius-full)] bg-accent-2 text-accent-11">
              <BellRing size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-xl font-semibold tracking-tight">Reminders</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
                Refills projected from what each customer actually buys, and the birthdays you chose
                to record. Worked from the top: the most overdue is first.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close reminders"
                className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-hover hover:text-fg"
              >
                <X size={17} aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-2.5">
            <span className="micro-label">Looking ahead</span>
            <div className="flex gap-1">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={horizon === h}
                  onClick={() => onHorizonChange(h)}
                  className={cn(
                    'inline-flex h-7 items-center rounded-[var(--radius-md)] border px-2 text-2xs',
                    horizon === h
                      ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                      : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                  )}
                >
                  {h} days
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" onClick={copy} disabled={rows.length === 0}>
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy call list'}
              </Button>
              <Button size="sm" onClick={() => downloadCallList(rows, today)} disabled={rows.length === 0}>
                <Download /> CSV
              </Button>
            </div>
          </div>

          <div className="scroll-region min-h-0 flex-1">
            <section className="border-b border-border-subtle">
              <header className="flex items-center gap-2 px-[var(--card-px)] pt-3 pb-1.5">
                <AlarmClock size={15} className="text-fg-subtle" aria-hidden />
                <h3 className="text-base font-semibold text-fg">Refills</h3>
                <span className="ml-auto text-2xs text-fg-subtle">
                  {refills.length === 0
                    ? 'none due'
                    : `${refills.length} due${overdue > 0 ? `, ${overdue} already late` : ''}`}
                </span>
              </header>

              {refills.length === 0 ? (
                <p className="px-[var(--card-px)] pb-3 text-sm text-fg-muted">
                  Nothing is due in the next {horizon} days. A refill is only projected once a
                  medicine has been bought on three separate dates — before that there is one gap,
                  and one gap is a guess rather than a cycle.
                </p>
              ) : (
                <ul>
                  {refills.map((r) => (
                    <li
                      key={`${r.customerId}-${r.item.medicineId}`}
                      className="flex items-start gap-2.5 border-t border-border-subtle px-[var(--card-px)] py-2.5"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-full)]',
                          r.dueInDays < 0 ? 'bg-warning-3 text-warning-11' : 'bg-accent-3 text-accent-11',
                        )}
                      >
                        <Repeat size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-base font-medium text-fg">{r.name}</span>
                          {r.phone
                            ? <span className="mono text-2xs text-fg-subtle">{r.phone}</span>
                            : (
                              <span className="inline-flex items-center gap-1 text-2xs text-warning-11">
                                <PhoneOff size={11} aria-hidden /> no phone on file
                              </span>
                            )}
                        </div>
                        <div className="truncate text-sm text-fg-muted" title={r.item.brandName}>
                          {r.item.brandName} · {r.item.packLabel}
                        </div>
                        <div className="text-2xs text-fg-subtle">
                          {r.item.cycle ? (
                            <>
                              Every <span className="num">{r.item.cycle.days}</span> days
                              {r.item.cycle.steady ? ', steady' : ', roughly'} · last collected{' '}
                              {formatDay(r.item.lastBought)}
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className={cn('text-sm font-medium', r.dueInDays < 0 ? 'text-warning-11' : 'text-fg')}>
                          {refillWords(r.dueInDays)}
                        </span>
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => onOpenCustomer(r.customerId)}>
                            Open
                          </Button>
                          <Button size="sm" onClick={onGoToBilling}>
                            <ScanBarcode /> Bill
                          </Button>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <header className="flex items-center gap-2 px-[var(--card-px)] pt-3 pb-1.5">
                <Cake size={15} className="text-fg-subtle" aria-hidden />
                <h3 className="text-base font-semibold text-fg">Birthdays</h3>
                <span className="ml-auto text-2xs text-fg-subtle">
                  {birthdays.length === 0 ? 'none recorded' : `${birthdays.length} in ${horizon} days`}
                </span>
              </header>

              {birthdays.length === 0 ? (
                <div className="px-[var(--card-px)] pb-4">
                  <EmptyState
                    icon={Cake}
                    title="No birthdays in this window"
                    body="A date of birth is recorded on the Care tab of a customer's sheet, and is kept on this device. Nobody with one falls inside the next few weeks."
                  />
                </div>
              ) : (
                <ul>
                  {birthdays.map((b) => (
                    <li
                      key={b.customerId}
                      className="flex items-center gap-2.5 border-t border-border-subtle px-[var(--card-px)] py-2.5"
                    >
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-accent-2 text-accent-11">
                        <Cake size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-base font-medium text-fg">{b.name}</span>
                          {b.phone
                            ? <span className="mono text-2xs text-fg-subtle">{b.phone}</span>
                            : (
                              <span className="inline-flex items-center gap-1 text-2xs text-warning-11">
                                <PhoneOff size={11} aria-hidden /> no phone on file
                              </span>
                            )}
                        </div>
                        <div className="text-2xs text-fg-subtle">
                          Turning <span className="num">{b.birthday.turning}</span> on{' '}
                          {formatDay(b.birthday.on)}
                        </div>
                      </div>
                      <span className="shrink-0 text-sm font-medium text-fg">
                        {b.birthday.inDays === 0 ? 'today' : `in ${b.birthday.inDays} d`}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => onOpenCustomer(b.customerId)}>
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
            <span className="text-2xs text-fg-subtle">
              Refill dates are projected from the loaded bill window; birthdays are held on this
              device. Neither is a promise about stock.
            </span>
            <Button size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
              Close <Kbd>Esc</Kbd>
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
