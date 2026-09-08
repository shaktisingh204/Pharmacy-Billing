import { useRef } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Kbd } from '@/components/ui/Kbd'
import { SHORTCUTS, formatCombo } from '@/lib/keys'
import type { Scope, Shortcut } from '@/lib/keys'

const SCOPE_LABEL: Record<Scope, string> = {
  global: 'Anywhere',
  billing: 'Billing',
  cart: 'Cart grid',
  payment: 'Payment',
  search: 'Search',
  modal: 'Dialog',
}

/** Declaration order in SHORTCUTS is the reading order; a Map preserves it. */
function groupsFor(scope: Scope): Array<[string, Shortcut[]]> {
  const byGroup = new Map<string, Shortcut[]>()
  for (const s of SHORTCUTS) {
    if (s.scope !== 'global' && s.scope !== scope) continue
    const list = byGroup.get(s.group)
    if (list) list.push(s)
    else byGroup.set(s.group, [s])
  }
  return [...byGroup]
}

function Combo({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <Kbd key={`${i}-${part}`}>{part}</Kbd>
      ))}
    </>
  )
}

function Row({ shortcut }: { shortcut: Shortcut }) {
  /* Only a single alias is worth a second chord. `bill.recallSlot` carries eight
     of them and already displays as "Alt 1–9"; printing them would be noise. */
  const alias = shortcut.aliases?.length === 1 ? shortcut.aliases[0] : undefined

  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm text-fg">{shortcut.label}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Combo parts={shortcut.display} />
        {alias ? (
          <>
            <span className="px-0.5 text-2xs text-fg-subtle">or</span>
            <Combo parts={formatCombo(alias)} />
          </>
        ) : null}
      </span>
    </div>
  )
}

/**
 * The shortcut cheat sheet. Shows the active scope plus everything global,
 * because "what does F4 do right here" is the question an operator actually has.
 */
export function ShortcutHelp({
  open,
  onClose,
  scope,
}: {
  open: boolean
  onClose: () => void
  scope: Scope
}) {
  /**
   * Radix's modal content hard-codes its close-focus to `Dialog.Trigger`, and a
   * sheet opened from a hotkey has no trigger — focus would land on <body> and
   * the operator would have to mouse back into the bill. So the opener is
   * captured in onOpenAutoFocus, which fires while it is still the active
   * element, and restored by hand.
   */
  const openerRef = useRef<HTMLElement | null>(null)

  /* Claims the modal scope while open — otherwise the sheet is a picture of the
     shortcuts that still fire on the bill behind it. Escape is Radix's, which
     preventDefaults at capture, so the screen's own Escape stays put too. */
  useHotkeys('modal', {}, { enabled: open })

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ backgroundColor: 'color-mix(in srgb, var(--fg) 32%, transparent)' }}
        />
        <Dialog.Content
          onOpenAutoFocus={() => {
            const active = document.activeElement
            openerRef.current = active instanceof HTMLElement ? active : null
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            openerRef.current?.focus()
          }}
          className={[
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col',
            'w-[min(880px,calc(100vw-48px))] max-h-[min(680px,calc(100vh-64px))]',
            'rounded-[var(--radius-lg)] border border-border bg-surface shadow-overlay',
          ].join(' ')}
        >
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
            <Dialog.Title className="text-base font-medium text-fg">
              Keyboard shortcuts
            </Dialog.Title>
            <span className="rounded-[var(--radius-sm)] bg-subtle px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
              {SCOPE_LABEL[scope]}
            </span>
            <Dialog.Description className="sr-only">
              Every shortcut available in the {SCOPE_LABEL[scope]} context, grouped by task.
            </Dialog.Description>
            <div className="min-w-0 flex-1" />
            <Dialog.Close
              aria-label="Close"
              className="flex size-7 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>

          <div className="scroll-region min-h-0 flex-1 columns-2 gap-8 px-4 py-4">
            {groupsFor(scope).map(([group, items]) => (
              <section key={group} className="mb-5 break-inside-avoid">
                <h3 className="micro-label mb-1.5">{group}</h3>
                <div className="flex flex-col">
                  {items.map((s) => (
                    <Row key={s.id} shortcut={s} />
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border-subtle px-4 text-2xs text-fg-muted">
            <Kbd>Esc</Kbd>
            <span>closes this sheet.</span>
            <span className="text-fg-subtle">
              Function keys follow Marg; the Alt aliases exist for the browsers that swallow them.
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
