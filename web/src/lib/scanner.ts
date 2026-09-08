/**
 * Barcode scanner input detection.
 *
 * A USB scanner is a keyboard. There is no API, no device event and no way to
 * ask "was that a scan?" — the payload simply arrives as keystrokes, far faster
 * than a person can type, followed by Enter or Tab. So detection is timing:
 * buffer printable keys, and at the terminator decide whether the burst could
 * only have come from a machine.
 *
 * Two consequences drive the design:
 *  - The characters have ALREADY landed in whatever input had focus by the time
 *    we classify them. `rollback` undoes that.
 *  - A wrong "yes" is worse than a wrong "no": swallowing a cashier's Enter
 *    breaks the form they were in. When the timing says human, we neither fire
 *    nor consume the key.
 */

import { parseGs1, type Gs1Data } from './gs1'

const FNC1 = '\x1D'

export interface ScanEvent {
  /**
   * The payload as transmitted, minus the AIM Code ID; FNC1 separators appear
   * as '\x1D'. This is the lookup key, and what to hand `rollback`.
   */
  raw: string
  symbology: string | null
  kind: 'gtin' | 'gs1' | 'unknown'
  parsed: Gs1Data | null
}

export interface ScannerOptions {
  onScan: (e: ScanEvent) => void
  minLength?: number
  maxLength?: number
  maxMeanGapMs?: number
  maxSingleGapMs?: number
  maxTotalMs?: number
  /** Injectable clock; defaults to the monotonic `performance.now`. */
  now?: () => number
}

/** ']E0' and friends: the prefix a scanner prepends when AIM Code ID is enabled. */
const AIM_CODES: Record<string, { name: string; kind: ScanEvent['kind'] }> = {
  ']E0': { name: 'EAN-13', kind: 'gtin' },
  ']E4': { name: 'EAN-8', kind: 'gtin' },
  ']C1': { name: 'GS1-128', kind: 'gs1' },
  ']d2': { name: 'GS1 DataMatrix', kind: 'gs1' },
  ']Q3': { name: 'GS1 QR', kind: 'gs1' },
}

/**
 * Keys that carry no character and are NOT evidence a human took over. A pack
 * batch like "MFL2214" is transmitted with a Shift keydown before every capital
 * letter; treating those as human input would break every uppercase scan.
 */
const TRANSPARENT_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead',
])

export function createScannerListener(opts: ScannerOptions): {
  handleKeyDown: (e: KeyboardEvent) => void
  /** True while a scan buffer is open — the focus watchdog MUST consult this. */
  isScanning: () => boolean
  reset: () => void
} {
  const minLength = opts.minLength ?? 6
  const maxLength = opts.maxLength ?? 64
  const maxMeanGapMs = opts.maxMeanGapMs ?? 35
  const maxSingleGapMs = opts.maxSingleGapMs ?? 70
  const maxTotalMs = opts.maxTotalMs ?? 500
  const now = opts.now ?? (() => performance.now())

  let buf = ''
  let firstAt = 0
  let lastAt = 0
  let maxGap = 0
  let overflowed = false

  function reset(): void {
    buf = ''
    firstAt = 0
    lastAt = 0
    maxGap = 0
    overflowed = false
  }

  function push(ch: string, t: number): void {
    if (buf === '') {
      firstAt = t
    } else {
      const gap = t - lastAt
      // A gap no scanner could produce ends the previous burst instead of
      // poisoning this one: a cashier who types "PARA", pauses, then scans must
      // still get a scan.
      if (gap > maxSingleGapMs) {
        reset()
        firstAt = t
      } else if (gap > maxGap) {
        maxGap = gap
      }
    }
    lastAt = t
    // Stop growing rather than buffering a document someone pasted into a note
    // field; the flag makes the terminator reject the burst.
    if (buf.length >= maxLength) {
      overflowed = true
      return
    }
    buf += ch
  }

  function meanGap(): number {
    return buf.length > 1 ? (lastAt - firstAt) / (buf.length - 1) : 0
  }

  /**
   * `t` is when the terminator arrived. The gap in front of it is deliberately
   * left out of the mean and the ceiling — scanners are configurable to hold a
   * suffix delay — but it still has to fit inside the total budget.
   */
  function looksMachineTyped(t: number): boolean {
    if (overflowed || buf.length < minLength) return false
    return t - firstAt <= maxTotalMs && maxGap <= maxSingleGapMs && meanGap() <= maxMeanGapMs
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return // an auto-repeating held key, never a scan
    const t = now()

    // THE detail everything else depends on: most scanners transmit the GS1
    // FNC1 separator as Ctrl+]. A blanket "ignore ctrl chords" rule drops it,
    // and the variable-length batch then runs on into the expiry behind it.
    if (e.ctrlKey && e.code === 'BracketRight') {
      push(FNC1, t)
      return
    }
    if (TRANSPARENT_KEYS.has(e.key)) return
    if (e.ctrlKey || e.metaKey || e.altKey) {
      reset() // a shortcut is in flight; whatever is buffered is not a scan
      return
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
      const machine = looksMachineTyped(t)
      const payload = buf
      reset()
      if (!machine) return // let a person's Enter reach the form untouched
      // Nothing downstream may see this key: not the form, not the grid cell.
      e.preventDefault()
      e.stopImmediatePropagation()
      opts.onScan(toScanEvent(payload))
      return
    }

    if (e.key.length !== 1) {
      reset() // Escape, Backspace, an arrow: a human is editing
      return
    }
    push(e.key, t)
  }

  return {
    handleKeyDown,
    // Deliberately stricter than "buffer is non-empty": a single keystroke is
    // not yet evidence of a scan, and a watchdog that stands down on every
    // keypress never returns focus to the search box. A burst also goes stale,
    // so a scan that never sent its terminator cannot wedge the flag on.
    isScanning: () => buf.length > 1 && meanGap() <= maxMeanGapMs && now() - lastAt <= maxTotalMs,
    reset,
  }
}

function toScanEvent(payload: string): ScanEvent {
  const aim = payload.length >= 3 && payload.startsWith(']') ? payload.slice(0, 3) : null
  const raw = aim === null ? payload : payload.slice(3)
  const known = aim === null ? undefined : AIM_CODES[aim]
  const kind = known ? known.kind : shapeOf(raw)
  return {
    raw,
    symbology: known ? known.name : aim,
    kind,
    parsed: kind === 'gs1' ? parseGs1(raw) : null,
  }
}

/**
 * Shape routing for the common case — most wedges ship with the AIM Code ID
 * disabled, so there is no prefix to route on. Only two shapes are unambiguous:
 * an all-digit GTIN, and a payload carrying an FNC1 (or the bracket form),
 * which nothing but GS1 produces.
 */
function shapeOf(payload: string): ScanEvent['kind'] {
  if (/^\d+$/.test(payload) && (payload.length === 8 || payload.length === 12 || payload.length === 13)) {
    // The scanner has already verified the check digit in hardware; re-deriving
    // it here would only reject packs whose symbol is fine.
    return 'gtin'
  }
  if (payload.includes(FNC1) || /^\(\d{2,4}\)/.test(payload)) return 'gs1'
  return 'unknown'
}

/**
 * Remove a scan that has already been typed into a focused field.
 *
 * The write goes through the NATIVE value setter on purpose: React installs its
 * own `value` setter on the node to track the last value it saw, so assigning
 * `el.value` updates that tracker too, React concludes nothing changed, and
 * onChange never fires — leaving component state holding the barcode forever.
 */
export function rollback(el: HTMLInputElement | HTMLTextAreaElement, payload: string): void {
  const typed = candidates(payload).find((c) => c !== '' && el.value.endsWith(c))
  if (typed === undefined) return

  let next = el.value.slice(0, el.value.length - typed.length)
  // The AIM Code ID is stripped from ScanEvent.raw, but its three characters
  // are printable and did land in the field.
  next = next.replace(/\][A-Za-z][A-Za-z0-9]$/, '')

  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, next)
  else el.value = next
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Ctrl+] produces no character, so a GS1 payload lands without its separators. */
function candidates(payload: string): string[] {
  const flat = payload.split(FNC1).join('')
  return payload === flat ? [payload] : [payload, flat]
}
