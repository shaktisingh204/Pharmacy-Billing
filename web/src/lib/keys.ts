/**
 * Keyboard binding, scoping and discovery.
 *
 * The map is anchored on Marg/Tally muscle memory, not on web habits. A pharmacy
 * switching software loses weeks if F4 stops meaning discount, so the F-keys are
 * the contract and the Ctrl/Alt forms are aliases, never the other way round.
 *
 * TWO MATCHING RULES, and they are NOT interchangeable:
 *  - Numpad accelerators bind by `e.code`. Shift+= and NumpadAdd both report
 *    key '+', so binding '+' by key makes '+' untypeable in every text field.
 *  - Letters and digits bind by `e.key` lowercased, so an Inscript or Devanagari
 *    layout still reaches the same command from wherever the letter lives.
 *
 * COMBO GRAMMAR: `modifier*+key`, modifiers from ctrl/alt/shift/meta in that
 * canonical order. The key token is one of
 *   - an exact numpad `code`  — 'NumpadAdd'
 *   - an F-key                — 'F3'
 *   - a named key             — 'enter', 'escape', 'slash', 'space'
 *   - a single character      — 'a', '4', '?'
 * '+' is deliberately unbindable: the only key that should mean "+" is the one
 * on the numpad, and that one binds by code.
 */

export const SCOPES = ['global', 'billing', 'cart', 'payment', 'search', 'modal'] as const
export type Scope = (typeof SCOPES)[number]

export interface Shortcut {
  id: string
  /** Canonical combo string, e.g. 'F3', 'ctrl+enter', 'alt+c', 'NumpadAdd', 'slash'. */
  combo: string
  /** Alternate combos that do the same thing (the Alt+letter aliases). */
  aliases?: string[]
  scope: Scope
  label: string
  /** Grouping in the cheat sheet. */
  group: string
  /** Rendered form, e.g. ['F3'] or ['Ctrl','↵']. */
  display: string[]
}

/**
 * Chrome does not honour preventDefault on these: the operator loses the tab
 * mid-bill and the cart with it. Nothing in SHORTCUTS may use one, and a
 * dev-time assertion at the bottom of this file enforces that.
 *
 * Alt+D is absent from the map for the same family of reasons — Chrome owns it
 * for the address bar — which is why deleting a line is Ctrl+D.
 */
export const RESERVED_BY_BROWSER: string[] = [
  'ctrl+n', 'ctrl+shift+n',
  'ctrl+t', 'ctrl+shift+t',
  'ctrl+w', 'ctrl+shift+w',
  'ctrl+q',
  'ctrl+tab',
  'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5',
  'ctrl+6', 'ctrl+7', 'ctrl+8', 'ctrl+9',
  /* 'F4' is the canonical token for an F-key, so alt+F4 canonicalises this way. */
  'alt+F4',
]

// ------------------------------------------------------------------- grammar ---

const NUMPAD_CODES = [
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDecimal', 'NumpadEnter',
] as const

const NUMPAD: ReadonlySet<string> = new Set(NUMPAD_CODES)

/** Characters that get a name because their glyph reads badly inside a combo. */
const CHAR_TOKEN: Record<string, string> = { '/': 'slash', ' ': 'space' }

/* Naming a character must not make it stricter about shift than an unnamed one:
   '/' is Shift+7 on a German layout exactly as '?' is Shift+/ on a US one. */
const NAMED_CHAR: ReadonlySet<string> = new Set(Object.values(CHAR_TOKEN))

const F_KEY = /^f([1-9]|1[0-2])$/i
const ALNUM = /^[a-z0-9]$/

function normalizeKeyToken(key: string): string {
  if (key.length === 1) return CHAR_TOKEN[key] ?? key.toLowerCase()
  if (F_KEY.test(key)) return key.toUpperCase()
  return key.toLowerCase()
}

interface ComboSpec {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

const MODIFIER_ALIAS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta',
}

/* Parsing is cached: every keystroke in the app is tested against every bound
   combo, and splitting the same twenty strings on each keydown is pure waste. */
const PARSED = new Map<string, ComboSpec | null>()

function parseCombo(combo: string): ComboSpec | null {
  const cached = PARSED.get(combo)
  if (cached !== undefined) return cached
  const spec = parseUncached(combo)
  PARSED.set(combo, spec)
  return spec
}

function parseUncached(combo: string): ComboSpec | null {
  const parts = combo.split('+')
  const raw = parts.at(-1)
  if (raw === undefined || raw === '') return null
  /* A near-miss like 'numpadadd' would parse as a key token and then silently
     match nothing, which is the worst possible failure for an accelerator. */
  if (/^numpad/i.test(raw) && !NUMPAD.has(raw)) return null

  const spec: ComboSpec = {
    ctrl: false, alt: false, shift: false, meta: false,
    key: NUMPAD.has(raw) ? raw : normalizeKeyToken(raw),
  }
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIAS[part.toLowerCase()]
    if (!mod) return null
    spec[mod] = true
  }
  return spec
}

/** '?' IS Shift+/ — the shift state is already spent producing the character. */
function isShiftedCharacter(key: string): boolean {
  if (NAMED_CHAR.has(key)) return true
  return key.length === 1 && !ALNUM.test(key)
}

function physicalCode(key: string): string {
  return /[0-9]/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`
}

function matchesKey(e: KeyboardEvent, spec: ComboSpec): boolean {
  if (NUMPAD.has(spec.key)) return e.code === spec.key
  if (normalizeKeyToken(e.key) === spec.key) return true
  /* macOS composes Option+letter into another character entirely — Alt+C reports
     'ç', Alt+S reports 'ß' — so every Alt alias would be dead on a Mac if we only
     ever consulted e.key. The fallback is scoped to Alt combos so it can never
     resurrect a bare letter on a non-QWERTY layout. */
  return spec.alt && ALNUM.test(spec.key) && e.code === physicalCode(spec.key)
}

export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  const spec = parseCombo(combo)
  if (!spec) return false
  if (e.ctrlKey !== spec.ctrl || e.altKey !== spec.alt || e.metaKey !== spec.meta) return false
  /* Shift is compared for letters, digits and named keys — Ctrl+S and Ctrl+Shift+S
     are different commands. For punctuation it is compared by the character. */
  if (!isShiftedCharacter(spec.key) && e.shiftKey !== spec.shift) return false
  return matchesKey(e, spec)
}

export function comboFromEvent(e: KeyboardEvent): string {
  const key = NUMPAD.has(e.code) ? e.code : normalizeKeyToken(e.key)
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey && !isShiftedCharacter(key)) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(key)
  return parts.join('+')
}

/**
 * The digit behind an `alt+N` accelerator — the held slot, the note value.
 *
 * `Number(e.key)` is NOT it: the same macOS composition that forces the code
 * fallback in matchesKey turns Option+7 into '¶', so a handler reading the key
 * recalls slot NaN on the one platform the fallback exists for.
 */
export function digitFromEvent(e: KeyboardEvent): number | null {
  if (/^[0-9]$/.test(e.key)) return Number(e.key)
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1]
  return digit === undefined ? null : Number(digit)
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (el === null || typeof el !== 'object') return false
  const node = el as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: unknown }

  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true

  if (node.isContentEditable === true) return true
  /* jsdom implements neither isContentEditable nor contentEditable, so without
     the attribute fallback every contenteditable assertion passes in the browser
     and fails in the suite — or worse, the reverse. */
  if (typeof node.getAttribute === 'function') {
    const attr = (node.getAttribute as (name: string) => string | null)('contenteditable')
    if (attr !== null && attr !== 'false') return true
  }
  return false
}

/**
 * A combo made of nothing but a typed character has to yield to a text field:
 * '/' and 's' are things an operator types. Modified combos, F-keys, Escape and
 * the numpad accelerators still fire — the numpad deliberately so, because
 * reaching payment with the left hand still on the quantity field is the point.
 */
function isTypedCharacter(spec: ComboSpec): boolean {
  if (spec.ctrl || spec.alt || spec.meta) return false
  return spec.key.length === 1 || spec.key === 'slash' || spec.key === 'space'
}

/** Does `e` trigger `s`? Honours aliases and the typing-target suppression rule. */
export function matchShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const typing = isTypingTarget(e.target)
  for (const combo of s.aliases ? [s.combo, ...s.aliases] : [s.combo]) {
    if (typing) {
      const spec = parseCombo(combo)
      if (spec && isTypedCharacter(spec)) continue
    }
    if (matchCombo(e, combo)) return true
  }
  return false
}

const DISPLAY_TOKEN: Record<string, string> = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: '⌘',
  enter: '↵', escape: 'Esc', tab: 'Tab', space: 'Space', slash: '/',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num ×',
  NumpadEnter: 'Num ↵', NumpadDecimal: 'Num .',
}

/** Combo → <Kbd> parts, so an alias renders the same way as `display` does. */
export function formatCombo(combo: string): string[] {
  const spec = parseCombo(combo)
  if (!spec) return [combo]
  const parts: string[] = []
  if (spec.ctrl) parts.push(DISPLAY_TOKEN.ctrl ?? 'Ctrl')
  if (spec.alt) parts.push(DISPLAY_TOKEN.alt ?? 'Alt')
  if (spec.shift) parts.push(DISPLAY_TOKEN.shift ?? 'Shift')
  if (spec.meta) parts.push(DISPLAY_TOKEN.meta ?? '⌘')
  parts.push(DISPLAY_TOKEN[spec.key] ?? (spec.key.length === 1 ? spec.key.toUpperCase() : spec.key))
  return parts
}

// ----------------------------------------------------------------- the map ---

/**
 * Declaration order is reading order in the cheat sheet, and groups are kept
 * contiguous so the sheet needs no sort.
 *
 * F2 and F4 appear TWICE on purpose. F2 is "new bill" everywhere and "edit this
 * cell" inside the grid; F4 is the line discount in the grid and the bill
 * discount on the totals rail. The narrower scope wins at dispatch time — see
 * useHotkeys — which is exactly how Marg behaves.
 */
export const SHORTCUTS: Shortcut[] = [
  // --- General -----------------------------------------------------------
  {
    id: 'palette.open', combo: 'ctrl+k', aliases: ['alt+g'], scope: 'global',
    group: 'General', label: 'Command palette', display: ['Ctrl', 'K'],
  },
  {
    id: 'help.open', combo: '?', aliases: ['ctrl+slash'], scope: 'global',
    group: 'General', label: 'Keyboard shortcuts', display: ['?'],
  },
  {
    id: 'print', combo: 'ctrl+p', scope: 'global',
    group: 'General', label: 'Print / reprint', display: ['Ctrl', 'P'],
  },
  {
    id: 'escape', combo: 'escape', scope: 'global',
    group: 'General', label: 'Step back exactly one level', display: ['Esc'],
  },

  // --- Bill --------------------------------------------------------------
  {
    id: 'bill.new', combo: 'F2', aliases: ['alt+n'], scope: 'global',
    group: 'Bill', label: 'New bill', display: ['F2'],
  },
  {
    id: 'bill.hold', combo: 'F8', scope: 'global',
    group: 'Bill', label: 'Hold / park the bill', display: ['F8'],
  },
  {
    id: 'bill.recall', combo: 'F9', scope: 'global',
    group: 'Bill', label: 'Recall held bills', display: ['F9'],
  },
  {
    /* One entry, nine combos: the handler reads the digit off the event. Nine
       rows would bury the rest of the sheet for one command. */
    id: 'bill.recallSlot', combo: 'alt+1',
    aliases: ['alt+2', 'alt+3', 'alt+4', 'alt+5', 'alt+6', 'alt+7', 'alt+8', 'alt+9'],
    scope: 'global', group: 'Bill', label: 'Recall a held slot directly',
    display: ['Alt', '1–9'],
  },
  {
    id: 'bill.return', combo: 'NumpadMultiply', scope: 'global',
    group: 'Bill', label: 'Sale return against a bill', display: ['Num ×'],
  },

  // --- Search & entry ----------------------------------------------------
  {
    id: 'search.focus', combo: 'slash', scope: 'billing',
    group: 'Search & entry', label: 'Focus medicine search', display: ['/'],
  },
  {
    /* F7 alone prompts caret browsing in Firefox, hence the alias. */
    id: 'search.salt', combo: 'F7', aliases: ['alt+s'], scope: 'billing',
    group: 'Search & entry', label: 'Search by salt → substitutes', display: ['F7'],
  },
  {
    id: 'medicine.create', combo: 'alt+c', scope: 'billing',
    group: 'Search & entry', label: 'Create a medicine inline', display: ['Alt', 'C'],
  },
  {
    id: 'shortbook.add', combo: 's', scope: 'billing',
    group: 'Search & entry', label: 'Add to short book (on a short-stock strip)',
    display: ['S'],
  },

  // --- Customer & doctor -------------------------------------------------
  {
    id: 'customer.attach', combo: 'alt+u', scope: 'billing',
    group: 'Customer & doctor', label: 'Attach customer by phone', display: ['Alt', 'U'],
  },
  {
    id: 'doctor.attach', combo: 'alt+o', scope: 'billing',
    group: 'Customer & doctor', label: 'Attach doctor + prescription', display: ['Alt', 'O'],
  },

  // --- Totals ------------------------------------------------------------
  {
    id: 'bill.discount', combo: 'F4', scope: 'billing',
    group: 'Totals', label: 'Bill discount', display: ['F4'],
  },
  {
    id: 'payment.open', combo: 'NumpadAdd', aliases: ['ctrl+enter'], scope: 'billing',
    group: 'Totals', label: 'Go to payment', display: ['Num +'],
  },
  {
    id: 'bill.save', combo: 'NumpadEnter', aliases: ['ctrl+s'], scope: 'billing',
    group: 'Totals', label: 'Save & print', display: ['Num ↵'],
  },
  {
    id: 'bill.saveNoPrint', combo: 'ctrl+shift+s', scope: 'billing',
    group: 'Totals', label: 'Save without printing', display: ['Ctrl', 'Shift', 'S'],
  },

  // --- Cart line ---------------------------------------------------------
  {
    id: 'cell.edit', combo: 'F2', scope: 'cart',
    group: 'Cart line', label: 'Edit the focused cell', display: ['F2'],
  },
  {
    id: 'line.batch', combo: 'F3', aliases: ['ctrl+b'], scope: 'cart',
    group: 'Cart line', label: 'Batch & expiry picker', display: ['F3'],
  },
  {
    id: 'line.discount', combo: 'F4', scope: 'cart',
    group: 'Cart line', label: 'Line discount', display: ['F4'],
  },
  {
    /* Ctrl+D, never Alt+D: Chrome owns Alt+D for the address bar. */
    id: 'line.delete', combo: 'ctrl+d', scope: 'cart',
    group: 'Cart line', label: 'Delete the focused line', display: ['Ctrl', 'D'],
  },

  // --- Payment -----------------------------------------------------------
  {
    id: 'payment.cash', combo: '1', scope: 'payment',
    group: 'Payment mode', label: 'Cash', display: ['1'],
  },
  {
    id: 'payment.upi', combo: '2', scope: 'payment',
    group: 'Payment mode', label: 'UPI', display: ['2'],
  },
  {
    id: 'payment.card', combo: '3', scope: 'payment',
    group: 'Payment mode', label: 'Card', display: ['3'],
  },
  {
    id: 'payment.credit', combo: '4', scope: 'payment',
    group: 'Payment mode', label: 'Credit', display: ['4'],
  },
  {
    id: 'payment.split', combo: 'NumpadSubtract', scope: 'payment',
    group: 'Payment mode', label: 'Add a split-tender row', display: ['Num −'],
  },

  // --- Cash tendered -----------------------------------------------------
  {
    id: 'payment.exact', combo: 'e', scope: 'payment',
    group: 'Cash tendered', label: 'Exact cash', display: ['E'],
  },
  {
    id: 'payment.note500', combo: 'alt+5', scope: 'payment',
    group: 'Cash tendered', label: 'Add a ₹500 note', display: ['Alt', '5'],
  },
  {
    id: 'payment.note200', combo: 'alt+2', scope: 'payment',
    group: 'Cash tendered', label: 'Add a ₹200 note', display: ['Alt', '2'],
  },
  {
    id: 'payment.note100', combo: 'alt+1', scope: 'payment',
    group: 'Cash tendered', label: 'Add a ₹100 note', display: ['Alt', '1'],
  },
  {
    id: 'payment.note50', combo: 'alt+0', scope: 'payment',
    group: 'Cash tendered', label: 'Add a ₹50 note', display: ['Alt', '0'],
  },
]

// ------------------------------------------------------------- assertions ---

/**
 * A bad combo string is invisible at runtime — the accelerator simply never
 * fires, and nobody notices until a counter is queued. So the map is validated
 * at import time in dev, where it is a hard stop rather than a code review.
 */
if (import.meta.env.DEV) {
  const canonical = (combo: string): string => {
    const spec = parseCombo(combo)
    if (!spec) throw new Error(`keys: unparseable combo '${combo}'`)
    const mods = [
      spec.ctrl ? 'ctrl' : '', spec.alt ? 'alt' : '',
      spec.shift ? 'shift' : '', spec.meta ? 'meta' : '',
    ].filter(Boolean)
    return [...mods, spec.key].join('+')
  }

  const reserved = new Set(RESERVED_BY_BROWSER.map(canonical))
  const ids = new Set<string>()
  const bound = new Set<string>()

  for (const s of SHORTCUTS) {
    if (ids.has(s.id)) throw new Error(`keys: duplicate shortcut id '${s.id}'`)
    ids.add(s.id)
    if (s.display.length === 0) throw new Error(`keys: '${s.id}' has no display form`)

    for (const combo of s.aliases ? [s.combo, ...s.aliases] : [s.combo]) {
      const c = canonical(combo)
      if (reserved.has(c)) {
        throw new Error(
          `keys: '${s.id}' binds ${combo}, which Chrome will not surrender — see RESERVED_BY_BROWSER`,
        )
      }
      /* Only same-scope collisions are errors. F2/F4 across scopes are the
         deliberate contextual bindings the narrower scope resolves. */
      const key = `${s.scope}:${c}`
      if (bound.has(key)) throw new Error(`keys: ${combo} is bound twice in scope '${s.scope}'`)
      bound.add(key)
    }
  }
}
