import { describe, expect, it } from 'vitest'
import type { BrandProfile } from '@contract'
import {
  ACCENT_VAR,
  DEFAULT_BRAND,
  faviconDataUri,
  accentVars,
  applyBrandToDocument,
  builtInAccentVars,
  checkAccent,
  contrastOnWhite,
  deriveAccent,
  deriveDarkAccent,
  documentCredit,
  documentTitle,
  formatRatio,
} from './applyBrand'

const VAR_NAMES = Object.values(ACCENT_VAR)

/** A saturated indigo: dark enough to carry white text, far from the built-in teal. */
const INDIGO = '#4338ca'
/** Pale yellow — the exact mistake this module exists to prevent. */
const PALE_YELLOW = '#fde68a'

function brand(patch: Partial<BrandProfile> = {}): BrandProfile {
  return { ...DEFAULT_BRAND, ...patch }
}

function accentOf(base: string): BrandProfile['accent'] {
  return { base, hover: '', text: '', tint: '', ring: '' }
}

/** Contrast against white falls as a colour darkens, so it orders the ramp. */
function darkerThan(a: string, b: string): boolean {
  const ca = contrastOnWhite(a)
  const cb = contrastOnWhite(b)
  if (ca === null || cb === null) throw new Error('not a hex colour')
  return ca > cb
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

describe('checkAccent', () => {
  it('names the field that is not a hex colour', () => {
    const rejected = checkAccent({
      base: '#0d9488',
      hover: 'rgb(13, 148, 136)',
      text: '',
      tint: '',
      ring: '',
    })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.key).toBe('hover')
    expect(rejected[0]?.reason).toMatch(/hex/i)
  })

  it('rejects a base that is not #rgb or #rrggbb', () => {
    // Eight-digit hex carries alpha; a named colour is not a hex colour at all.
    for (const bad of ['#0d94', '#0d948', 'teal', '0d9488', '#0d9488ff', '']) {
      const rejected = checkAccent(accentOf(bad))
      expect(rejected.map((r) => r.key)).toEqual(['base'])
    }
  })

  it('accepts the three-digit form', () => {
    expect(checkAccent(accentOf('#079'))).toEqual([])
  })

  it('treats blank derived steps as "derive it", not as an error', () => {
    expect(checkAccent(accentOf('#0d9488'))).toEqual([])
  })

  it('rejects an accent too pale to carry white text', () => {
    const rejected = checkAccent(accentOf(PALE_YELLOW))
    expect(rejected.map((r) => r.key)).toEqual(['base'])
    // The panel prints this verbatim, so it has to read as a sentence.
    expect(rejected[0]?.reason).toMatch(/white/i)
    expect(rejected[0]?.reason).toContain('3.0:1')
  })

  it('never reports a failing ratio as the floor it just missed', () => {
    // 2.9953:1. Rounded to nearest it printed "3.0:1 … needs 3.0:1", which reads
    // as a broken checker rather than as a colour that is one hair too pale.
    const reason = checkAccent(accentOf('#959595'))[0]?.reason ?? ''
    expect(reason).toContain('2.9:1 against white')
    expect(reason).toContain('needs 3.0:1')
  })

  it('passes the built-in teal, which sits just above the floor at 3.7:1', () => {
    const teal = contrastOnWhite('#0d9488')
    expect(teal).not.toBeNull()
    expect(formatRatio(teal ?? 0)).toBe('3.7')
    expect(checkAccent(accentOf('#0d9488'))).toEqual([])
  })

  it('has nothing to say about a null accent', () => {
    expect(checkAccent(null)).toEqual([])
  })
})

describe('accentVars', () => {
  it('is empty for a null accent', () => {
    expect(accentVars(null)).toEqual({})
  })

  it('writes all five steps from a single base colour', () => {
    const vars = accentVars(accentOf(INDIGO))
    expect(Object.keys(vars).sort()).toEqual([...VAR_NAMES].sort())
    expect(vars[ACCENT_VAR.base]).toBe(INDIGO)
  })

  it('refuses the whole ramp when the base fails contrast, never half of it', () => {
    // Half-applying is the dangerous outcome: a teal button with a yellow hover.
    expect(accentVars(accentOf(PALE_YELLOW))).toEqual({})
    expect(accentVars(accentOf('not-a-colour'))).toEqual({})
  })

  it('derives a darker hover and a lighter tint than the base', () => {
    const vars = accentVars(accentOf(INDIGO))
    const base = vars[ACCENT_VAR.base] ?? ''
    const hover = vars[ACCENT_VAR.hover] ?? ''
    const tint = vars[ACCENT_VAR.tint] ?? ''
    const text = vars[ACCENT_VAR.text] ?? ''

    expect(darkerThan(hover, base)).toBe(true)
    expect(darkerThan(base, tint)).toBe(true)
    // Text is the step body copy uses, so it goes further than the hover.
    expect(darkerThan(text, hover)).toBe(true)
  })

  it('keeps derived steps in gamut for every hue', () => {
    for (const base of ['#b91c1c', '#1d4ed8', '#15803d', '#7c3aed', '#0f172a', '#a16207']) {
      const vars = accentVars(accentOf(base))
      for (const name of VAR_NAMES) {
        expect(vars[name]).toMatch(/^#[\da-f]{6}$/)
      }
      expect(darkerThan(vars[ACCENT_VAR.hover] ?? '', base)).toBe(true)
      expect(darkerThan(base, vars[ACCENT_VAR.tint] ?? '')).toBe(true)
    }
  })

  it('gives a near-black base a hover the eye can still separate from it', () => {
    // sRGB has nothing darker left down here: a fixed negative offset lands back
    // on the base — exactly on it, for black — and the button stops answering
    // the pointer. The step goes the other way instead.
    for (const base of ['#000000', '#050505', '#0a0a0a']) {
      const hover = accentVars(accentOf(base))[ACCENT_VAR.hover] ?? ''
      expect(hover, base).not.toBe(base)
      const cBase = contrastOnWhite(base) ?? 0
      const cHover = contrastOnWhite(hover) ?? 1
      // Both are measured against white, so the larger over the smaller IS the
      // contrast between the two fills.
      expect(Math.max(cBase / cHover, cHover / cBase), base).toBeGreaterThan(1.1)
    }
  })

  it('lets an explicitly supplied step override the derivation', () => {
    const vars = accentVars({
      base: INDIGO, hover: '#111827', text: '', tint: '', ring: '',
    })
    expect(vars[ACCENT_VAR.hover]).toBe('#111827')
  })

  it('normalises the three-digit form to six digits', () => {
    expect(accentVars(accentOf('#079'))[ACCENT_VAR.base]).toBe('#007799')
  })
})

describe('deriveAccent', () => {
  it('returns a complete, storable ramp', () => {
    const accent = deriveAccent(INDIGO)
    expect(accent).not.toBeNull()
    expect(accent?.base).toBe(INDIGO)
    for (const step of [accent?.hover, accent?.text, accent?.tint, accent?.ring]) {
      expect(step).toMatch(/^#[\da-f]{6}$/)
    }
  })

  it('returns null rather than a partial ramp for a bad colour', () => {
    expect(deriveAccent('chartreuse')).toBeNull()
  })
})

/**
 * The derivation is calibrated against tokens.css, so feeding it the product's
 * own accent has to give the product's own ramp back. If this drifts, every
 * reseller's theme drifts with it and nobody notices until a screenshot.
 */
describe('calibration against the built-in ramp', () => {
  const BUILT_IN = {
    base: '#0d9488', hover: '#0f766e', text: '#115e59', tint: '#ccfbf1', ring: '#5eead4',
  } as const

  function channels(hex: string): [number, number, number] {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  }

  it('reproduces every hand-tuned step within a few 8-bit levels', () => {
    const derived = deriveAccent(BUILT_IN.base)
    expect(derived).not.toBeNull()
    for (const key of ['hover', 'text', 'tint', 'ring'] as const) {
      const got = channels(derived?.[key] ?? '#000000')
      const want = channels(BUILT_IN[key])
      for (let i = 0; i < 3; i++) {
        expect(Math.abs((got[i] ?? 0) - (want[i] ?? 0)), `${key} channel ${i}`).toBeLessThanOrEqual(8)
      }
    }
  })

  it('keeps accent text readable on its own tint, whatever the brand', () => {
    // A pastel brand yields a pastel tint; the two must not converge.
    for (const base of ['#0d9488', '#4338ca', '#be123c', '#a16207', '#2563eb']) {
      const accent = deriveAccent(base)
      const text = accent?.text ?? ''
      const tint = accent?.tint ?? ''
      const lText = contrastOnWhite(text) ?? 0
      const lTint = contrastOnWhite(tint) ?? 0
      // Both are measured against white, so their ratio IS contrast(text, tint).
      expect(lText / lTint, base).toBeGreaterThan(4)
    }
  })
})

describe('applyBrandToDocument', () => {
  it('sets the document title from the product name and tagline', () => {
    applyBrandToDocument(brand({ productName: 'MediCounter', tagline: 'Retail POS' }), makeRoot())
    expect(document.title).toBe('MediCounter — Retail POS')
  })

  it('drops the em dash when there is no tagline', () => {
    applyBrandToDocument(brand({ productName: 'MediCounter', tagline: null }), makeRoot())
    expect(document.title).toBe('MediCounter')
  })

  it('falls back to the product name when the reseller blanks it', () => {
    expect(documentTitle(brand({ productName: '   ', tagline: null }))).toBe('RxBill')
  })

  it('writes every override onto the root element', () => {
    const root = makeRoot()
    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)
    for (const name of VAR_NAMES) {
      expect(root.style.getPropertyValue(name)).not.toBe('')
    }
    expect(root.style.getPropertyValue(ACCENT_VAR.base)).toBe(INDIGO)
  })

  it('removes every override it set when the accent goes back to null', () => {
    const root = makeRoot()
    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)
    applyBrandToDocument(brand({ accent: null }), root)

    for (const name of VAR_NAMES) {
      expect(root.style.getPropertyValue(name)).toBe('')
    }
    // Nothing left behind at all: a stray step would half-theme the app.
    expect(root.style.length).toBe(0)
  })

  it('removes the overrides when a saved accent later fails validation', () => {
    const root = makeRoot()
    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)
    applyBrandToDocument(brand({ accent: accentOf(PALE_YELLOW) }), root)
    for (const name of VAR_NAMES) {
      expect(root.style.getPropertyValue(name)).toBe('')
    }
  })

  it('remembers the stylesheet ramp from before the first override', () => {
    const root = makeRoot()
    // Stands in for tokens.css: the ramp already in effect when the app boots.
    root.style.setProperty(ACCENT_VAR.base, '#0d9488')
    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)

    expect(root.style.getPropertyValue(ACCENT_VAR.base)).toBe(INDIGO)
    // What the settings preview shows when a reseller clears the colour: the
    // built-in, not the indigo the root is still wearing.
    expect(builtInAccentVars(root)[ACCENT_VAR.base]).toBe('#0d9488')
  })

  it('never mistakes an earlier override for the built-in ramp', () => {
    const root = makeRoot()
    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)
    applyBrandToDocument(brand({ accent: deriveAccent('#be123c') }), root)
    expect(builtInAccentVars(root)).toEqual({})
  })

  it('follows the accent with theme-color, and restores the shipped one', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#0d9488'
    document.head.appendChild(meta)
    const root = makeRoot()

    applyBrandToDocument(brand({ accent: deriveAccent(INDIGO) }), root)
    expect(meta.content).toBe(INDIGO)

    applyBrandToDocument(brand({ accent: null }), root)
    expect(meta.content).toBe('#0d9488')

    meta.remove()
  })
})

describe('favicon branding', () => {
  it('draws the mark on the accent so the tab icon follows the theme', () => {
    const uri = faviconDataUri({ ...DEFAULT_BRAND, markText: 'Rx' }, '#7C3AED')
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true)
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length))
    expect(svg).toContain('#7C3AED')
    expect(svg).toContain('>Rx<')
  })

  it('prefers a supplied logo over the drawn mark', () => {
    const logo = 'data:image/png;base64,AAAA'
    expect(faviconDataUri({ ...DEFAULT_BRAND, logoUrl: logo }, '#0D9488')).toBe(logo)
  })

  it('escapes a mark that would otherwise break the SVG', () => {
    const uri = faviconDataUri({ ...DEFAULT_BRAND, markText: '<&' }, '#0D9488')
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length))
    expect(svg).toContain('&lt;&amp;')
    // One <text> element, not an injected second one.
    expect(svg.match(/<text/g)?.length).toBe(1)
  })
})

describe('documentCredit', () => {
  const brand = (over: Partial<BrandProfile>): BrandProfile => ({ ...DEFAULT_BRAND, ...over })

  it('prints the vendor credit by default — which the Settings copy promises', () => {
    expect(documentCredit(brand({}))).toBe('Powered by RxBill')
  })

  it("a reseller's own line wins outright", () => {
    expect(documentCredit(brand({ documentFooter: 'Powered by MedSoft' })))
      .toBe('Powered by MedSoft')
  })

  it('hiding the powered-by line leaves NO trace of the vendor on the paper', () => {
    expect(documentCredit(brand({ hidePoweredBy: true }))).toBeNull()
  })

  it('hiding it does not suppress a line the reseller wrote themselves', () => {
    // The toggle is about the vendor credit. A reseller who has both hidden the
    // credit AND written their own footer wants their footer, not silence.
    expect(documentCredit(brand({ hidePoweredBy: true, documentFooter: 'Sold by MedSoft' })))
      .toBe('Sold by MedSoft')
  })

  it('treats a whitespace-only footer as unset rather than printing a blank line', () => {
    expect(documentCredit(brand({ documentFooter: '   ' }))).toBe('Powered by RxBill')
  })

  it('prints nothing at all when no brand has loaded', () => {
    // A missing brand must never cost a customer their receipt.
    expect(documentCredit(null)).toBeNull()
    expect(documentCredit(undefined)).toBeNull()
  })
})

describe('the accent on a dark panel', () => {
  /* The customer display is the only dark screen, and the only one an actual
     CUSTOMER reads. Its three accent steps were teal literals until this — the
     one place a white-label could not reach. */
  const GROUND = '#0A101C'

  /** WCAG contrast, computed here so the test does not trust the module twice. */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      const ch = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * ch(n[0]!) + 0.7152 * ch(n[1]!) + 0.0722 * ch(n[2]!)
    }
    const [x, y] = [lum(a), lum(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }

  it('reproduces the palette this screen was designed with', () => {
    // The three steps were chosen by eye and approved. If the derivation cannot
    // rediscover them from the built-in teal it is a DIFFERENT palette wearing
    // the same name, and the screen quietly changed appearance.
    const dark = deriveDarkAccent('#0D9488', GROUND)!
    expect(dark.tint).toBe('#0f3b36')   // designed #0F3B37
    expect(dark.base).toBe('#25d4c4')   // designed #2DD4BF
    expect(dark.text).toBe('#5beada')   // designed #5EEAD4
  })

  it("follows the RESELLER's colour, which is the whole point", () => {
    const teal = deriveDarkAccent('#0D9488', GROUND)!
    const violet = deriveDarkAccent('#7C3AED', GROUND)!
    expect(violet.base).not.toBe(teal.base)
    expect(violet.text).not.toBe(teal.text)
  })

  it('LIGHTENS rather than reusing the light ramp, whatever the brand', () => {
    // A near-black brand is the case that breaks a naive "just use the base":
    // it would paint the accent onto the panel and vanish.
    for (const brandColour of ['#0D9488', '#1E3A8A', '#4C0519', '#111111']) {
      const dark = deriveDarkAccent(brandColour, GROUND)!
      expect(contrast(dark.base, GROUND)).toBeGreaterThanOrEqual(3)
      expect(contrast(dark.text, GROUND)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the tint a SURFACE — dark even when the brand is neon', () => {
    // It is painted behind text. A tint that tracked a bright brand upward
    // would out-glow what sits on it.
    for (const brandColour of ['#F59E0B', '#EAB308', '#22D3EE']) {
      const dark = deriveDarkAccent(brandColour, GROUND)!
      expect(contrast(dark.text, dark.tint)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('does not DIM a brand that is already lighter than the target', () => {
    // Dragging a neon brand down to a fixed lightness stops it being the brand.
    const neon = deriveDarkAccent('#FDE047', GROUND)!
    expect(contrast(neon.base, GROUND)).toBeGreaterThan(10)
  })

  it('keeps the brand HUE rather than drifting toward the nearest primary', () => {
    // A reseller notices hue long before they notice lightness.
    const violet = deriveDarkAccent('#7C3AED', GROUND)!
    const [r, , b] = [1, 3, 5].map((i) => parseInt(violet.base.slice(i, i + 2), 16))
    expect(b!).toBeGreaterThan(r!)
  })

  it('returns null rather than a guess when either colour is not hex', () => {
    expect(deriveDarkAccent('teal', GROUND)).toBeNull()
    expect(deriveDarkAccent('#0D9488', 'black')).toBeNull()
  })
})

describe('the step that carries white text', () => {
  /**
   * `--accent-10` is what every button, badge and active nav item paints white
   * text on, and it is the reseller's derived HOVER step. The built-in teal made
   * the problem visible: white on `--accent-9` measures 3.74:1, so an axe sweep
   * flagged every primary button in the product. A white-label must not be
   * allowed to reintroduce that.
   */
  function whiteOn(hex: string): number {
    const lum = (h: string) => {
      const n = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      const ch = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * ch(n[0]!) + 0.7152 * ch(n[1]!) + 0.0722 * ch(n[2]!)
    }
    return 1.05 / (lum(hex) + 0.05)
  }

  it('clears AA for WHITE TEXT whatever the brand colour', () => {
    // The pastel end is the case that breaks: a brand light enough to pass the
    // 3:1 identity floor can still be far too light to print a label on.
    for (const brandColour of ['#0D9488', '#7C3AED', '#B91C1C', '#1E3A8A', '#F59E0B', '#EAB308', '#22D3EE']) {
      const accent = deriveAccent(brandColour)!
      expect(whiteOn(accent.hover), brandColour).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('still steps VISIBLY away from the base, so a hover reads as a hover', () => {
    const accent = deriveAccent('#0D9488')!
    expect(accent.hover).not.toBe(accent.base)
  })

  it('keeps a near-black brand usable rather than darkening it into itself', () => {
    // Nothing darker exists, and such a brand carries white text easily — so the
    // step is lifted instead, which the AA floor above cannot undo.
    const accent = deriveAccent('#0A0A0A')!
    expect(accent.hover).not.toBe(accent.base)
    expect(whiteOn(accent.hover)).toBeGreaterThanOrEqual(4.5)
  })
})
