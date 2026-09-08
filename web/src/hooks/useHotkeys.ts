import { useEffect, useRef } from 'react'
import { SCOPES, SHORTCUTS, matchShortcut } from '@/lib/keys'
import type { Scope, Shortcut } from '@/lib/keys'

type Handlers = Partial<Record<string, (e: KeyboardEvent) => void>>

interface Binding {
  scope: Scope
  handlers: { current: Handlers }
}

/**
 * Every mounted, enabled hook, so a contested key can be arbitrated.
 *
 * Registration ORDER cannot decide the winner: the cart grid mounts before the
 * billing screen (effects run child-first) but a modal mounts after everything,
 * so "first" and "last" are each wrong half the time. SCOPES is ordered from
 * broadest to narrowest instead, and the narrowest mounted scope that actually
 * has a handler for the event takes it. That is what makes Escape step back
 * exactly ONE level, and F2 edit a cell inside the grid while still starting a
 * new bill everywhere else.
 */
const MOUNTED = new Set<Binding>()

const CANDIDATES = new Map<Scope, Shortcut[]>()

function candidatesFor(scope: Scope): Shortcut[] {
  const cached = CANDIDATES.get(scope)
  if (cached) return cached
  const own = SHORTCUTS.filter((s) => s.scope === scope)
  const global = scope === 'global' ? [] : SHORTCUTS.filter((s) => s.scope === 'global')
  const list = [...own, ...global]
  CANDIDATES.set(scope, list)
  return list
}

function resolve(e: KeyboardEvent, b: Binding): Shortcut | null {
  for (const s of candidatesFor(b.scope)) {
    if (!b.handlers.current[s.id]) continue
    if (matchShortcut(e, s)) return s
  }
  return null
}

function claim(e: KeyboardEvent): { binding: Binding; shortcut: Shortcut } | null {
  /* A modal is exclusive, not merely narrow. Being narrowest only wins the keys
     it implements, and a dialog implements almost none — so without this, Num ↵
     saves and prints the bill from under an open overlay. Keys the modal does
     not claim are left alone rather than swallowed: preventDefault on every
     keystroke would stop the operator typing inside the dialog. */
  let modal = false
  for (const b of MOUNTED) {
    if (b.scope === 'modal') { modal = true; break }
  }

  let best: { binding: Binding; shortcut: Shortcut } | null = null
  for (const binding of MOUNTED) {
    if (modal && binding.scope !== 'modal') continue
    const shortcut = resolve(e, binding)
    if (!shortcut) continue
    if (best === null || SCOPES.indexOf(binding.scope) > SCOPES.indexOf(best.binding.scope)) {
      best = { binding, shortcut }
    }
  }
  return best
}

/**
 * Bind the shortcuts of one scope. `handlers` is keyed by `Shortcut.id`; only
 * ids present here are bound, so a screen advertises exactly what it implements.
 *
 * Two same-scope hooks that both handle a key would fight, and the first mounted
 * one wins. Where that is ambiguous — the cart grid claiming F2 while focus is
 * in the search box — pass `enabled` rather than guarding inside the handler:
 * a disabled hook binds nothing and does not swallow the browser default.
 *
 * Scope 'modal' is exclusive: while one is mounted no other scope is dispatched
 * to at all. Every dialog owes the screen behind it that call —
 * `useHotkeys('modal', {}, { enabled: open })` is enough — or F2 starts a new
 * bill under the overlay.
 */
export function useHotkeys(
  scope: Scope,
  handlers: Handlers,
  opts?: { enabled?: boolean },
): void {
  const enabled = opts?.enabled ?? true

  /* Handlers are a fresh object literal on every render. Kept in a ref, so the
     listener is attached once per mount instead of re-attached per keystroke. */
  const handlersRef = useRef<Handlers>(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (!enabled) return

    if (import.meta.env.DEV) {
      const known = candidatesFor(scope)
      for (const id of Object.keys(handlersRef.current)) {
        if (!known.some((s) => s.id === id)) {
          console.warn(`useHotkeys: '${id}' is not a shortcut in scope '${scope}' — it will never fire`)
        }
      }
    }

    /* A new object each effect run, so StrictMode's mount/unmount/mount leaves
       exactly one binding registered. */
    const binding: Binding = { scope, handlers: handlersRef }
    MOUNTED.add(binding)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      const claimed = claim(e)
      if (claimed === null || claimed.binding !== binding) return
      /* Prevent on the auto-repeat too: swallowing only the first tick would let
         a leaned-on Ctrl+P open the browser print dialog on the second. */
      e.preventDefault()
      if (e.repeat) return
      claimed.binding.handlers.current[claimed.shortcut.id]?.(e)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      MOUNTED.delete(binding)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [scope, enabled])
}
