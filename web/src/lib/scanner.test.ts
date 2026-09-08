import { describe, expect, it } from 'vitest'
import { createScannerListener, rollback, type ScanEvent, type ScannerOptions } from './scanner'

const GS = '\x1D'
const EAN = '8901234567890'

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init })
}

/**
 * The clock is injected, so a "1000 characters per second" scanner and a
 * two-fingered cashier are the same test with a different gap. No timers.
 */
function harness(overrides: Omit<ScannerOptions, 'onScan' | 'now'> = {}) {
  let t = 1000
  const scans: ScanEvent[] = []
  const listener = createScannerListener({
    onScan: (e) => scans.push(e),
    now: () => t,
    ...overrides,
  })

  return {
    scans,
    listener,
    advance: (ms: number) => {
      t += ms
    },
    type(text: string, gapMs: number): void {
      for (const ch of text) {
        listener.handleKeyDown(keyEvent(ch))
        t += gapMs
      }
    },
    terminate(key: 'Enter' | 'Tab' = 'Enter'): KeyboardEvent {
      const e = keyEvent(key)
      listener.handleKeyDown(e)
      return e
    },
  }
}

describe('scan detection', () => {
  it('fires on a machine-speed burst and swallows the terminator', () => {
    const h = harness()
    h.type(EAN, 10)
    const enter = h.terminate()

    expect(h.scans).toHaveLength(1)
    expect(h.scans[0]?.raw).toBe(EAN)
    expect(h.scans[0]?.kind).toBe('gtin')
    // The Enter must never reach the form behind the input.
    expect(enter.defaultPrevented).toBe(true)
  })

  it('accepts Tab as a terminator too', () => {
    const h = harness()
    h.type(EAN, 10)
    const tab = h.terminate('Tab')

    expect(h.scans).toHaveLength(1)
    expect(tab.defaultPrevented).toBe(true)
  })

  it('leaves a person typing a code and pressing Enter completely alone', () => {
    const h = harness()
    h.type('PARA500', 150)
    const enter = h.terminate()

    expect(h.scans).toEqual([])
    expect(enter.defaultPrevented).toBe(false)
  })

  it('rejects a burst that is fast but not machine-fast', () => {
    // 50ms per key is under the single-gap ceiling yet well over the mean one:
    // a quick typist, not a wedge.
    const h = harness()
    h.type(EAN, 50)
    const enter = h.terminate()

    expect(h.scans).toEqual([])
    expect(enter.defaultPrevented).toBe(false)
  })

  it('rejects a burst longer than a barcode can be', () => {
    const h = harness()
    h.type('x'.repeat(70), 5)
    const enter = h.terminate()

    expect(h.scans).toEqual([])
    expect(enter.defaultPrevented).toBe(false)
  })

  it('rejects a burst that dawdles past the total budget', () => {
    const h = harness({ maxTotalMs: 100 })
    h.type(EAN, 10)
    const enter = h.terminate()

    expect(h.scans).toEqual([])
    expect(enter.defaultPrevented).toBe(false)
  })

  it('rejects a burst shorter than the minimum', () => {
    const h = harness()
    h.type('12345', 10)
    h.terminate()

    expect(h.scans).toEqual([])
  })

  it('starts a fresh buffer when a scan follows something a human typed', () => {
    const h = harness()
    h.type('PARA', 200)
    h.type(EAN, 10)
    h.terminate()

    expect(h.scans[0]?.raw).toBe(EAN)
  })

  it('ignores auto-repeat and abandons the buffer on a shortcut', () => {
    const h = harness()
    h.type('890', 10)
    h.listener.handleKeyDown(keyEvent('a', { repeat: true }))
    h.listener.handleKeyDown(keyEvent('s', { ctrlKey: true, code: 'KeyS' }))
    h.type('1234567890', 10)
    h.terminate()

    expect(h.scans[0]?.raw).toBe('1234567890')
  })

  it('survives the Shift keydowns an upper-case payload arrives with', () => {
    // A wedge types "MFL2214" as Shift-down, M, Shift-up, … Treating a bare
    // modifier keydown as human input would kill every batch number.
    const h = harness()
    for (const ch of 'MFL2214XY') {
      h.listener.handleKeyDown(keyEvent('Shift', { shiftKey: true }))
      h.advance(2)
      h.listener.handleKeyDown(keyEvent(ch, { shiftKey: true }))
      h.advance(8)
    }
    h.terminate()

    expect(h.scans[0]?.raw).toBe('MFL2214XY')
  })
})

describe('FNC1 over the keyboard wedge', () => {
  it('turns Ctrl+] into a group separator inside the buffer', () => {
    const h = harness()
    h.type('0108901234567890' + '10MFL2214', 8)
    h.listener.handleKeyDown(keyEvent(']', { ctrlKey: true, code: 'BracketRight' }))
    h.advance(8)
    h.type('17271130', 8)
    h.terminate()

    const scan = h.scans[0]
    expect(scan?.raw).toBe(`010890123456789010MFL2214${GS}17271130`)
    expect(scan?.kind).toBe('gs1')
    // The separator is the whole point: without it the batch eats the expiry.
    expect(scan?.parsed?.batch).toBe('MFL2214')
    expect(scan?.parsed?.expiry).toBe('2027-11-30')
    expect(scan?.parsed?.gtin).toBe('08901234567890')
  })
})

describe('symbology routing', () => {
  it('strips an AIM Code ID and routes GS1-128 through the parser', () => {
    const h = harness()
    h.type(`]C1010890123456789010MFL2214${GS}17271130`, 8)
    h.terminate()

    const scan = h.scans[0]
    expect(scan?.symbology).toBe('GS1-128')
    expect(scan?.kind).toBe('gs1')
    expect(scan?.raw.startsWith('01')).toBe(true)
    expect(scan?.parsed?.expiry).toBe('2027-11-30')
  })

  it('routes ]E0 to a plain GTIN', () => {
    const h = harness()
    h.type(`]E0${EAN}`, 8)
    h.terminate()

    expect(h.scans[0]?.symbology).toBe('EAN-13')
    expect(h.scans[0]?.kind).toBe('gtin')
    expect(h.scans[0]?.raw).toBe(EAN)
    expect(h.scans[0]?.parsed).toBeNull()
  })

  it('keeps an unrecognised AIM Code ID and falls back to the payload shape', () => {
    const h = harness()
    h.type(`]X0${EAN}`, 8)
    h.terminate()

    expect(h.scans[0]?.symbology).toBe(']X0')
    expect(h.scans[0]?.kind).toBe('gtin')
  })

  it('calls an internal alphanumeric code unknown, without parsing it', () => {
    const h = harness()
    h.type('RACK-B12-77', 8)
    h.terminate()

    expect(h.scans[0]?.kind).toBe('unknown')
    expect(h.scans[0]?.parsed).toBeNull()
  })
})

describe('isScanning', () => {
  it('is true mid-burst and false once the scan is delivered', () => {
    const h = harness()
    h.type('89012', 10)
    expect(h.listener.isScanning()).toBe(true)

    h.type('34567890', 10)
    h.terminate()
    expect(h.listener.isScanning()).toBe(false)
  })

  it('stays false while a person types', () => {
    const h = harness()
    h.type('PARA', 150)

    expect(h.listener.isScanning()).toBe(false)
  })

  it('goes stale so a scan that never sent its terminator cannot wedge it on', () => {
    const h = harness()
    h.type('89012', 10)
    h.advance(600)

    expect(h.listener.isScanning()).toBe(false)
  })

  it('is cleared by reset', () => {
    const h = harness()
    h.type('89012', 10)
    h.listener.reset()

    expect(h.listener.isScanning()).toBe(false)
  })
})

describe('character rollback', () => {
  function field(value: string): { el: HTMLInputElement; events: () => number } {
    const el = document.createElement('input')
    let fired = 0
    el.addEventListener('input', () => {
      fired += 1
    })
    el.value = value
    return { el, events: () => fired }
  }

  it('removes the payload and notifies React', () => {
    const f = field(EAN)
    rollback(f.el, EAN)

    expect(f.el.value).toBe('')
    // React only learns about a programmatic write from the input event.
    expect(f.events()).toBe(1)
  })

  it('removes only the trailing payload', () => {
    const f = field(`Paracetamol${EAN}`)
    rollback(f.el, EAN)

    expect(f.el.value).toBe('Paracetamol')
  })

  it('handles a GS1 payload whose separators never reached the field', () => {
    // Ctrl+] types no character, so the field holds the payload without them.
    const f = field('010890123456789010MFL221417271130')
    rollback(f.el, `010890123456789010MFL2214${GS}17271130`)

    expect(f.el.value).toBe('')
  })

  it('takes the AIM Code ID with it', () => {
    const f = field(`]E0${EAN}`)
    rollback(f.el, EAN)

    expect(f.el.value).toBe('')
  })

  it('does nothing when the payload never landed', () => {
    const f = field('Paracetamol')
    rollback(f.el, EAN)

    expect(f.el.value).toBe('Paracetamol')
    expect(f.events()).toBe(0)
  })
})
