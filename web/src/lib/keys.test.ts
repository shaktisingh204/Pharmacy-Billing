import { describe, expect, it } from 'vitest'
import {
  RESERVED_BY_BROWSER, SHORTCUTS,
  comboFromEvent, digitFromEvent, formatCombo, isTypingTarget, matchCombo, matchShortcut,
} from './keys'
import type { Shortcut } from './keys'

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

function shortcut(id: string): Shortcut {
  const s = SHORTCUTS.find((x) => x.id === id)
  if (!s) throw new Error(`no shortcut '${id}'`)
  return s
}

describe('numpad binds by code, never by key', () => {
  it('matches NumpadAdd on the code', () => {
    expect(matchCombo(press({ key: '+', code: 'NumpadAdd' }), 'NumpadAdd')).toBe(true)
  })

  it('does NOT match Shift+= , which reports the same key', () => {
    // The whole reason for binding by code: '+' has to stay typeable in every
    // text field, and Shift+= is how it is typed on a QWERTY row.
    const shiftEquals = press({ key: '+', code: 'Equal', shiftKey: true })
    expect(matchCombo(shiftEquals, 'NumpadAdd')).toBe(false)
  })

  it('keeps the numpad and the main-row Enter apart', () => {
    expect(matchCombo(press({ key: 'Enter', code: 'NumpadEnter' }), 'NumpadEnter')).toBe(true)
    expect(matchCombo(press({ key: 'Enter', code: 'Enter' }), 'NumpadEnter')).toBe(false)
    // Numpad Enter with no Ctrl must not reach the payment shortcut.
    expect(matchCombo(press({ key: 'Enter', code: 'NumpadEnter' }), 'ctrl+enter')).toBe(false)
  })

  it('rejects a mis-cased numpad code rather than matching nothing forever', () => {
    expect(matchCombo(press({ key: '-', code: 'NumpadSubtract' }), 'numpadsubtract')).toBe(false)
  })
})

describe('modifiers', () => {
  it('separates ctrl+s from ctrl+shift+s', () => {
    const save = press({ key: 's', code: 'KeyS', ctrlKey: true })
    const saveNoPrint = press({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true })
    expect(matchCombo(save, 'ctrl+s')).toBe(true)
    expect(matchCombo(save, 'ctrl+shift+s')).toBe(false)
    expect(matchCombo(saveNoPrint, 'ctrl+shift+s')).toBe(true)
    expect(matchCombo(saveNoPrint, 'ctrl+s')).toBe(false)
  })

  it('ignores shift for punctuation, which already spent it', () => {
    // '?' IS Shift+/ on QWERTY; requiring shiftKey:false would make it unmatchable.
    expect(matchCombo(press({ key: '?', code: 'Slash', shiftKey: true }), '?')).toBe(true)
    expect(matchCombo(press({ key: '/', code: 'Slash' }), 'slash')).toBe(true)
    expect(matchCombo(press({ key: '?', code: 'Slash', shiftKey: true }), 'slash')).toBe(false)
    // '/' is itself Shift+7 on a German layout: giving it a name must not make
    // it stricter about shift than '?' is.
    expect(matchCombo(press({ key: '/', code: 'Digit7', shiftKey: true }), 'slash')).toBe(true)
  })

  it('does not let a bare letter fire while a modifier is held', () => {
    const s = shortcut('shortbook.add')
    expect(matchCombo(press({ key: 's', code: 'KeyS' }), s.combo)).toBe(true)
    expect(matchCombo(press({ key: 's', code: 'KeyS', ctrlKey: true }), s.combo)).toBe(false)
  })

  it('falls back to the physical code for Alt combos', () => {
    // macOS composes Option+C into 'ç'; without the fallback every Alt alias is
    // dead on a Mac.
    expect(matchCombo(press({ key: 'ç', code: 'KeyC', altKey: true }), 'alt+c')).toBe(true)
    expect(matchCombo(press({ key: '¡', code: 'Digit1', altKey: true }), 'alt+1')).toBe(true)
    // Scoped to Alt: a bare letter must still follow the layout, not the position.
    expect(matchCombo(press({ key: 'a', code: 'KeyS' }), 's')).toBe(false)
  })
})

describe('aliases', () => {
  it('fires a shortcut from either its combo or an alias', () => {
    const salt = shortcut('search.salt')
    expect(salt.aliases).toContain('alt+s')
    expect(matchShortcut(press({ key: 'F7', code: 'F7' }), salt)).toBe(true)
    expect(matchShortcut(press({ key: 's', code: 'KeyS', altKey: true }), salt)).toBe(true)
    expect(matchShortcut(press({ key: 's', code: 'KeyS' }), salt)).toBe(false)
  })

  it('reaches every recall slot through the alias list', () => {
    const recall = shortcut('bill.recallSlot')
    for (const digit of ['1', '3', '9']) {
      expect(matchShortcut(press({ key: digit, code: `Digit${digit}`, altKey: true }), recall)).toBe(true)
    }
    expect(matchShortcut(press({ key: '0', code: 'Digit0', altKey: true }), recall)).toBe(false)
  })
})

describe('digitFromEvent', () => {
  it('reads the slot even when the key is a composed character', () => {
    // macOS Option+7 reports '¶', which is exactly the case the code fallback
    // matched on; a handler reading Number(e.key) would recall slot NaN.
    expect(digitFromEvent(press({ key: '¶', code: 'Digit7', altKey: true }))).toBe(7)
    expect(digitFromEvent(press({ key: '5', code: 'Digit5', altKey: true }))).toBe(5)
    expect(digitFromEvent(press({ key: '3', code: 'Numpad3' }))).toBe(3)
    expect(digitFromEvent(press({ key: 'ç', code: 'KeyC', altKey: true }))).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('is true for the fields an operator types into', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true)
    }
  })

  it('is true for a contenteditable element and false for a plain div', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    expect(isTypingTarget(editable)).toBe(true)

    const off = document.createElement('div')
    off.setAttribute('contenteditable', 'false')
    expect(isTypingTarget(off)).toBe(false)

    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('typing suppression', () => {
  function inField(init: KeyboardEventInit): KeyboardEvent {
    const e = press(init)
    Object.defineProperty(e, 'target', { value: document.createElement('input') })
    return e
  }

  it('suppresses bare letters and slash inside a field', () => {
    expect(matchShortcut(inField({ key: 's', code: 'KeyS' }), shortcut('shortbook.add'))).toBe(false)
    expect(matchShortcut(inField({ key: '/', code: 'Slash' }), shortcut('search.focus'))).toBe(false)
    expect(matchShortcut(inField({ key: '1', code: 'Digit1' }), shortcut('payment.cash'))).toBe(false)
  })

  it('still fires F-keys, modified combos and the numpad inside a field', () => {
    expect(matchShortcut(inField({ key: 'F3', code: 'F3' }), shortcut('line.batch'))).toBe(true)
    expect(
      matchShortcut(inField({ key: 'd', code: 'KeyD', ctrlKey: true }), shortcut('line.delete')),
    ).toBe(true)
    expect(matchShortcut(inField({ key: '+', code: 'NumpadAdd' }), shortcut('payment.open'))).toBe(true)
    expect(matchShortcut(inField({ key: 'Escape', code: 'Escape' }), shortcut('escape'))).toBe(true)
  })

  it('keeps the modified alias alive when the bare form is suppressed', () => {
    const help = shortcut('help.open')
    expect(matchShortcut(inField({ key: '?', code: 'Slash', shiftKey: true }), help)).toBe(false)
    expect(matchShortcut(inField({ key: '/', code: 'Slash', ctrlKey: true }), help)).toBe(true)
  })
})

describe('comboFromEvent', () => {
  const cases: KeyboardEventInit[] = [
    { key: 'F3', code: 'F3' },
    { key: 'Enter', code: 'Enter', ctrlKey: true },
    { key: 'c', code: 'KeyC', altKey: true },
    { key: '+', code: 'NumpadAdd' },
    { key: '?', code: 'Slash', shiftKey: true },
    { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true },
    { key: 'Escape', code: 'Escape' },
  ]

  it('round-trips through matchCombo', () => {
    for (const init of cases) {
      const e = press(init)
      expect(matchCombo(e, comboFromEvent(e))).toBe(true)
    }
  })

  it('emits the canonical form the map is written in', () => {
    expect(comboFromEvent(press({ key: '+', code: 'NumpadAdd' }))).toBe('NumpadAdd')
    expect(comboFromEvent(press({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBe('ctrl+enter')
    expect(comboFromEvent(press({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true })))
      .toBe('ctrl+shift+s')
    expect(comboFromEvent(press({ key: '/', code: 'Slash' }))).toBe('slash')
    expect(comboFromEvent(press({ key: '?', code: 'Slash', shiftKey: true }))).toBe('?')
    expect(comboFromEvent(press({ key: 'F4', code: 'F4' }))).toBe('F4')
  })
})

describe('the map', () => {
  const allCombos = SHORTCUTS.flatMap((s) => (s.aliases ? [s.combo, ...s.aliases] : [s.combo]))

  it('never binds a combo Chrome refuses to surrender', () => {
    const reserved = new Set(RESERVED_BY_BROWSER)
    for (const combo of allCombos) {
      expect(reserved.has(combo), `${combo} is reserved by the browser`).toBe(false)
    }
    // Alt+D is Chrome's address bar; deleting a line is Ctrl+D.
    expect(allCombos).not.toContain('alt+d')
  })

  it('has unique ids and a renderable display for every entry', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of SHORTCUTS) {
      expect(s.display.length, s.id).toBeGreaterThan(0)
      expect(s.label.length, s.id).toBeGreaterThan(0)
    }
  })

  it('binds no combo twice inside one scope', () => {
    const seen = new Set<string>()
    for (const s of SHORTCUTS) {
      for (const combo of s.aliases ? [s.combo, ...s.aliases] : [s.combo]) {
        const key = `${s.scope}:${combo}`
        expect(seen.has(key), `${combo} bound twice in ${s.scope}`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('keeps F2 and F4 contextual across scopes, which is the point', () => {
    expect(shortcut('bill.new').combo).toBe('F2')
    expect(shortcut('cell.edit').combo).toBe('F2')
    expect(shortcut('bill.discount').combo).toBe('F4')
    expect(shortcut('line.discount').combo).toBe('F4')
    expect(shortcut('cell.edit').scope).not.toBe(shortcut('bill.new').scope)
    expect(shortcut('line.discount').scope).not.toBe(shortcut('bill.discount').scope)
  })
})

describe('formatCombo', () => {
  it('renders a combo as <Kbd> parts', () => {
    expect(formatCombo('ctrl+enter')).toEqual(['Ctrl', '↵'])
    expect(formatCombo('alt+s')).toEqual(['Alt', 'S'])
    expect(formatCombo('NumpadSubtract')).toEqual(['Num −'])
    expect(formatCombo('F7')).toEqual(['F7'])
    expect(formatCombo('ctrl+slash')).toEqual(['Ctrl', '/'])
  })
})
