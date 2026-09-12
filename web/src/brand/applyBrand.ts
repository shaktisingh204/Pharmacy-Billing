import type { BrandProfile } from '@contract'

/**
 * Branding as data, applied to the document.
 *
 * A white-label deployment overrides five steps of the accent ramp — nothing
 * else. The rest of the palette is neutral by construction, so a reseller who
 * only knows their own brand colour still gets a coherent product rather than a
 * five-field colour picker they will fill in badly.
 *
 * Two things make this safe to hand to a reseller:
 *  - the accent is VALIDATED, not trusted. A pale yellow on a white button is
 *    unreadable, and the person choosing it is looking at their logo, not at a
 *    contrast checker;
 *  - the derived steps are computed in OKLab. A naive RGB darken drags saturated
 *    hues through grey — the "muddy hover" that makes a themed app look cheap.
 */

export type AccentKey = keyof NonNullable<BrandProfile['accent']>

/** Base first: every other step derives from it. */
export const ACCENT_KEYS: readonly AccentKey[] = ['base', 'hover', 'text', 'tint', 'ring']

/** Which token each step overrides. The names are the contract with tokens.css. */
export const ACCENT_VAR: Record<AccentKey, string> = {
  base: '--accent-9',
  hover: '--accent-10',
  text: '--accent-11',
  tint: '--accent-3',
  ring: '--accent-6',
}

/**
 * White text sits on the base step (primary buttons, the active-nav bar, count
 * badges), so the base carries the whole readability burden.
 *
 * 3:1 and not 4.5:1 deliberately: button labels are 14px semibold on a solid
 * fill, which WCAG treats as a UI component boundary (SC 1.4.11), and the
 * built-in teal itself measures 3.74:1. A 4.5 floor would reject the palette
 * this app already ships.
 */
export const MIN_BASE_CONTRAST = 3

/** Accent text on the accent tint — real body copy, so the full AA floor. */
const MIN_TEXT_ON_TINT = 4.5

/**
 * The fallback profile.
 *
 * It duplicates nothing visual — accent stays null so tokens.css remains the one
 * place the built-in ramp is written. It exists so a failed getBrand() shows the
 * app under its own name instead of an empty shell.
 */
export const DEFAULT_BRAND: BrandProfile = {
  productName: 'RxBill',
  markText: 'Rx',
  logoUrl: null,
  accent: null,
  tagline: 'Pharmacy POS',
  documentFooter: null,
  hidePoweredBy: false,
}

/** Why a step was refused, in words the settings panel can print verbatim. */
export interface AccentRejection {
  key: AccentKey
  reason: string
}

interface Rgb { r: number; g: number; b: number }
interface Oklab { L: number; a: number; b: number }
interface Oklch { L: number; C: number; h: number }

/* ------------------------------------------------------------------- hex --- */

/* #rgb or #rrggbb only. Eight-digit hex carries alpha, and a translucent accent
   would let the page behind bleed through every primary button. */
const HEX_RE = /^#(?:([\da-f])([\da-f])([\da-f])|([\da-f]{2})([\da-f]{2})([\da-f]{2}))$/i

function parseHex(value: string | null | undefined): Rgb | null {
  if (typeof value !== 'string') return null
  const m = HEX_RE.exec(value.trim())
  if (!m) return null
  const [, r3, g3, b3, r6, g6, b6] = m
  if (r3 !== undefined && g3 !== undefined && b3 !== undefined) {
    return { r: parseInt(r3 + r3, 16), g: parseInt(g3 + g3, 16), b: parseInt(b3 + b3, 16) }
  }
  if (r6 !== undefined && g6 !== undefined && b6 !== undefined) {
    return { r: parseInt(r6, 16), g: parseInt(g6, 16), b: parseInt(b6, 16) }
  }
  return null
}

function toHex({ r, g, b }: Rgb): string {
  const pair = (n: number) => n.toString(16).padStart(2, '0')
  return `#${pair(r)}${pair(g)}${pair(b)}`
}

/** True for #rgb / #rrggbb, false for anything else including a blank string. */
export function isHexColour(value: string | null | undefined): boolean {
  return parseHex(value) !== null
}

/** Normalises to lowercase #rrggbb, or null when the input is not a hex colour. */
export function normalizeHex(value: string | null | undefined): string | null {
  const rgb = parseHex(value)
  return rgb ? toHex(rgb) : null
}

/* -------------------------------------------------------------- contrast --- */

function channelLuminance(n: number): number {
  const c = n / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  )
}

function ratio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }

/** WCAG contrast of a hex colour against white, or null if it is not a hex colour. */
export function contrastOnWhite(value: string): number | null {
  const rgb = parseHex(value)
  return rgb ? ratio(rgb, WHITE) : null
}

/* ----------------------------------------------------------------- OKLab --- */

function toLinear(n: number): number {
  const c = n / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function fromLinear(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.min(255, Math.max(0, Math.round(v * 255)))
}

function srgbToOklab(rgb: Rgb): Oklab {
  const r = toLinear(rgb.r)
  const g = toLinear(rgb.g)
  const b = toLinear(rgb.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function oklabToLinear(c: Oklab): [number, number, number] {
  const l = (c.L + 0.3963377774 * c.a + 0.2158037573 * c.b) ** 3
  const m = (c.L - 0.1055613458 * c.a - 0.0638541728 * c.b) ** 3
  const s = (c.L - 0.0894841775 * c.a - 1.291485548 * c.b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function srgbToOklch(rgb: Rgb): Oklch {
  const { L, a, b } = srgbToOklab(rgb)
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) }
}

function oklchToLinear({ L, C, h }: Oklch): [number, number, number] {
  return oklabToLinear({ L, a: Math.cos(h) * C, b: Math.sin(h) * C })
}

/**
 * OKLCh to sRGB, reducing chroma until the colour fits.
 *
 * Clipping the channels instead is what turns a derived light step the wrong
 * hue: a light blue asked for more chroma than sRGB holds clips its blue channel
 * alone and arrives lilac. Dropping chroma keeps the hue and the lightness,
 * which are the two things a reseller would actually notice.
 */
function oklchToSrgb(c: Oklch): Rgb {
  const inGamut = ([r, g, b]: [number, number, number]) =>
    r >= -1e-4 && g >= -1e-4 && b >= -1e-4 && r <= 1 + 1e-4 && g <= 1 + 1e-4 && b <= 1 + 1e-4

  let lo = 0
  let hi = c.C
  if (!inGamut(oklchToLinear(c))) {
    // 12 halvings resolve chroma far below one 8-bit step.
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear({ ...c, C: mid }))) lo = mid
      else hi = mid
    }
  } else {
    lo = c.C
  }

  const [r, g, b] = oklchToLinear({ ...c, C: lo })
  return { r: fromLinear(r), g: fromLinear(g), b: fromLinear(b) }
}

/*
 * The ramp shape, measured off the built-in teal rather than invented.
 *
 * tokens.css was hand-tuned, so it is the ground truth for what "one step
 * darker" and "the selected-row tint" mean in this product:
 *   9 -> 10  L -0.089, chroma x0.83      9 -> 3  L 0.953, chroma x0.48
 *   9 -> 11  L -0.163, chroma x0.68      9 -> 6  L 0.855, chroma x1.20
 * Chroma RISES into the ring step: a focus border that desaturates as it
 * lightens reads as grey, and a grey focus ring is a broken focus ring.
 *
 * Lightness is absolute for the two light steps and relative for the two dark
 * ones. A tint is a fixed place on the page — near-white, whatever the brand —
 * while a hover only has to be visibly darker than the button it belongs to.
 */
const HOVER_DL = 0.09
const HOVER_CK = 0.85
const TEXT_DL = 0.16
const TEXT_CK = 0.7
const TINT_L = 0.95
const TINT_CK = 0.48
const RING_L = 0.855
const RING_CK = 1.2

/**
 * The smallest step that still reads as "the button answered the pointer".
 *
 * sRGB runs out below the built-in offset: a near-black brand darkened by 0.09 L
 * lands back on its own base, and pure black lands on itself exactly. Such a
 * hover is a hover that does not exist. The built-in ramp steps 1.47:1 from base
 * to hover, so 1.1 only ever catches the degenerate end.
 */
const MIN_HOVER_STEP = 1.1

/**
 * White body text on this step must clear AA.
 *
 * The hover step becomes `--accent-11`, and `--accent-10` — the step below it —
 * is what every button, badge and active nav item paints white text on. The
 * built-in teal made this visible: white on `--accent-9` measures 3.74:1, and an
 * axe sweep flagged every primary button in the product. `--accent-9` is still
 * the identity colour on rings and bars, where 3:1 under SC 1.4.11 is the right
 * bar; anything carrying WORDS sits a step darker, and a reseller's ramp has to
 * make that step as readable as ours or the white-label ships the defect we just
 * removed.
 */
const MIN_WHITE_ON_ACCENT = 4.5

/** Darker by preference, lighter when sRGB has no darker left to give. */
function deriveHover(ok: Oklch, base: Rgb): Rgb {
  const at = (L: number) => oklchToSrgb({ L, C: ok.C * HOVER_CK, h: ok.h })

  /* Darkened past the nominal offset until white text on it is legible. This
     only binds for a light brand — a navy one clears it at the first step — and
     for a light brand it is the difference between a readable button and a
     white-on-pastel label nobody outside the design review can read. */
  let L = ok.L - HOVER_DL
  let hover = at(L)
  while (ratio(WHITE, hover) < MIN_WHITE_ON_ACCENT && L > 0) {
    L -= 0.02
    hover = at(L)
  }

  /* Only now the degenerate case: a near-black brand has no darker left, so the
     hover is lifted instead. Such a brand already carries white text easily, so
     lightening here cannot undo the floor above. */
  for (let up = ok.L + HOVER_DL; ratio(hover, base) < MIN_HOVER_STEP && up <= 1; up += 0.02) {
    hover = at(up)
  }
  return hover
}

/**
 * The four steps a reseller does not choose.
 *
 * Text is darkened past its nominal offset until it clears AA against the tint
 * it will be printed on: a pastel brand yields a pastel tint, and a fixed offset
 * would leave accent text and its own background a hair apart.
 */
function deriveRamp(base: Rgb): Record<AccentKey, Rgb> {
  const ok = srgbToOklch(base)
  const tint = oklchToSrgb({ L: TINT_L, C: ok.C * TINT_CK, h: ok.h })

  let text = oklchToSrgb({ L: ok.L - TEXT_DL, C: ok.C * TEXT_CK, h: ok.h })
  for (let L = ok.L - TEXT_DL; L > 0 && ratio(text, tint) < MIN_TEXT_ON_TINT; L -= 0.02) {
    text = oklchToSrgb({ L, C: ok.C * TEXT_CK, h: ok.h })
  }

  return {
    base,
    hover: deriveHover(ok, base),
    text,
    tint,
    ring: oklchToSrgb({ L: RING_L, C: ok.C * RING_CK, h: ok.h }),
  }
}

/**
 * A complete accent from one colour, for storing on the profile.
 *
 * The derivation is written into the saved data rather than recomputed at paint
 * time so that a later tweak to the constants above cannot silently restyle
 * every existing reseller.
 */
export function deriveAccent(base: string): BrandProfile['accent'] {
  const rgb = parseHex(base)
  if (!rgb) return null
  const ramp = deriveRamp(rgb)
  return {
    base: toHex(ramp.base),
    hover: toHex(ramp.hover),
    text: toHex(ramp.text),
    tint: toHex(ramp.tint),
    ring: toHex(ramp.ring),
  }
}

/* ---------------------------------------------------------- dark ground --- */

/**
 * The accent re-grounded for a dark surface.
 *
 * The customer display is the only dark screen in the app, and it is the only
 * screen a CUSTOMER looks at — so it is the last place the vendor's teal should
 * survive a white-label. It cannot reuse the light ramp: `--accent-3` there is a
 * near-white tint that would glow on a near-black panel, and `--accent-11` is
 * darkened until it clears AA against that tint, which is the opposite of what a
 * dark ground needs.
 *
 * So the three dark steps are derived from the same brand colour against the
 * ground they will actually be painted on. Hue and chroma carry over; only
 * lightness is re-chosen. The ground is a parameter rather than a constant
 * because the screen that owns the palette is the screen that knows it.
 */
/* Calibrated so the built-in teal derives back to the three steps that were
   chosen by eye for this screen and approved: #0F3B37 / #2DD4BF / #5EEAD4, hit
   here within one 8-bit step. The dark ramp is therefore that palette
   generalised, not a second palette with its own taste in it. Chroma rises
   above 1.0 on the two lit steps because a dark ground carries more of it —
   the same colour that reads confident on white reads washed out on black. */
const DARK_TINT_L = 0.32
const DARK_TINT_CK = 0.46
const DARK_BASE_L = 0.785
const DARK_BASE_CK = 1.28
const DARK_TEXT_L = 0.855
const DARK_TEXT_CK = 1.2

/** Same split as the light ramp: a fill is a UI boundary, text is text. */
const MIN_DARK_BASE = 3
const MIN_DARK_TEXT = 4.5

export interface DarkAccent {
  /** The `--accent-3` role: a dark surface the accent sits ON, not a tint. */
  tint: string
  base: string
  text: string
}

/**
 * Three accent steps for a dark panel, or null if either colour is not hex.
 *
 * A brand LIGHTER than the target keeps its own lightness rather than being
 * dimmed to it — a neon brand dragged down to a fixed L stops being the brand.
 * The contrast floors are then a guarantee rather than the usual path: against a
 * near-black panel they never bind, and against a lifted one they do.
 */
export function deriveDarkAccent(base: string, ground: string): DarkAccent | null {
  const rgb = parseHex(base)
  const bg = parseHex(ground)
  if (!rgb || !bg) return null
  const ok = srgbToOklch(rgb)

  const at = (L: number, ck: number) => oklchToSrgb({ L, C: ok.C * ck, h: ok.h })
  const lift = (target: number, ck: number, floor: number): Rgb => {
    const start = Math.max(target, ok.L)
    let out = at(start, ck)
    for (let L = start; ratio(out, bg) < floor && L <= 1; L += 0.02) out = at(L, ck)
    return out
  }

  return {
    // The tint stays dark whatever the brand: it is a surface, and a surface
    // that tracked a light brand upward would out-glow the text on it.
    tint: toHex(at(DARK_TINT_L, DARK_TINT_CK)),
    base: toHex(lift(DARK_BASE_L, DARK_BASE_CK, MIN_DARK_BASE)),
    text: toHex(lift(DARK_TEXT_L, DARK_TEXT_CK, MIN_DARK_TEXT)),
  }
}

/* ------------------------------------------------------------ validation --- */

/**
 * Everything wrong with an accent, keyed by field. Empty means "apply it".
 *
 * Blank non-base steps are not errors — they mean "derive it", which is the
 * common case: a reseller supplies one brand colour, not a ramp.
 */
export function checkAccent(accent: BrandProfile['accent']): AccentRejection[] {
  if (!accent) return []
  const rejected: AccentRejection[] = []

  const base = parseHex(accent.base)
  if (!base) {
    rejected.push({ key: 'base', reason: 'Not a hex colour — write it as #RGB or #RRGGBB.' })
  } else {
    const c = ratio(base, WHITE)
    if (c < MIN_BASE_CONTRAST) {
      rejected.push({
        key: 'base',
        reason:
          `Too light for white text: ${formatRatio(c)}:1 against white, ` +
          `and a primary button needs ${formatRatio(MIN_BASE_CONTRAST)}:1.`,
      })
    }
  }

  for (const key of ACCENT_KEYS) {
    if (key === 'base') continue
    const value = accent[key]
    if (value.trim() === '' || isHexColour(value)) continue
    rejected.push({ key, reason: 'Not a hex colour — write it as #RGB or #RRGGBB.' })
  }

  return rejected
}

/**
 * One decimal place, always rounded DOWN.
 *
 * Rounding to nearest let a refusal print "2.96:1 against white, and a primary
 * button needs 3.0:1" as "3.0:1 … needs 3.0:1" — a sentence that reads as a bug
 * in the checker rather than a fault in the colour. Truncating can only ever
 * understate a measurement, which is the safe direction for both messages.
 *
 * `toFixed` is banned repo-wide; money made that rule, and an exception here
 * would be one grep away from becoming a rounded rupee.
 */
export function formatRatio(n: number): string {
  const scaled = Math.floor(n * 10)
  return `${Math.trunc(scaled / 10)}.${Math.abs(scaled % 10)}`
}

/**
 * The accent currently painted on an element.
 *
 * Read off computed style rather than duplicated as a constant here: tokens.css
 * owns the built-in ramp, and a second copy of it in TypeScript is a copy that
 * goes stale. Returns null when no stylesheet is in play, which the settings
 * panel treats as "no colour to offer as a starting point".
 */
export function currentAccentBase(root: HTMLElement): string | null {
  const view = root.ownerDocument.defaultView
  if (!view) return null
  return normalizeHex(view.getComputedStyle(root).getPropertyValue(ACCENT_VAR.base).trim())
}

/* --------------------------------------------------------------- applying -- */

/**
 * The custom properties for an accent, keyed by CSS variable name.
 *
 * Empty when the accent is null OR when the base is unusable: a rejected base
 * makes every derived step meaningless, so the whole override is dropped and the
 * built-in ramp shows through intact.
 */
export function accentVars(accent: BrandProfile['accent']): Record<string, string> {
  if (!accent) return {}
  const base = parseHex(accent.base)
  if (!base || ratio(base, WHITE) < MIN_BASE_CONTRAST) return {}

  const derived = deriveRamp(base)
  const vars: Record<string, string> = {}
  for (const key of ACCENT_KEYS) {
    // A supplied step wins; anything blank or malformed falls back to the
    // derivation rather than to teal, which would half-theme the app.
    const supplied = parseHex(accent[key])
    vars[ACCENT_VAR[key]] = toHex(supplied ?? derived[key])
  }
  return vars
}

/**
 * The tab icon, drawn from the brand.
 *
 * index.html ships a hardcoded teal "Rx" mark, which is exactly the kind of thing
 * that makes a white-label deployment stop being white-label: the reseller renames
 * the product everywhere except the one place a user looks at all day. A supplied
 * logo wins; otherwise the mark text is drawn on the accent, so the favicon
 * follows the theme for free.
 */
export function faviconDataUri(brand: BrandProfile, accentBase: string): string {
  if (brand.logoUrl) return brand.logoUrl
  const mark = (brand.markText || DEFAULT_BRAND.markText).slice(0, 2)
  // Two characters need a smaller face than one, or the glyphs touch the corners.
  const size = mark.length > 1 ? 15 : 19
  const escaped = mark.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${accentBase}"/>` +
    `<text x="16" y="16" fill="#fff" font-family="system-ui,sans-serif" font-size="${size}"` +
    ` font-weight="600" text-anchor="middle" dominant-baseline="central">${escaped}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** The tab title. The tagline earns its place: two products from one reseller
 *  are otherwise indistinguishable in a row of pinned tabs. */
export function documentTitle(brand: BrandProfile): string {
  const name = brand.productName.trim() || DEFAULT_BRAND.productName
  const tagline = brand.tagline?.trim()
  return tagline ? `${name} — ${tagline}` : name
}

/* The colour index.html shipped, per document, so removing an override can put
   it back. Reading it from computed style instead would return the empty string
   under jsdom and blank the tag. */
const ORIGINAL_FAVICON = new WeakMap<Document, string>()
const ORIGINAL_THEME_COLOR = new WeakMap<Document, string>()

/* The ramp the stylesheet ships, per themed element, captured before the first
   override lands on it — after that, computed style answers with the override
   itself. */
const BUILT_IN_ACCENT = new WeakMap<HTMLElement, Record<string, string>>()

function captureBuiltInAccent(root: HTMLElement): void {
  if (BUILT_IN_ACCENT.has(root)) return
  const view = root.ownerDocument.defaultView
  if (!view) return

  const computed = view.getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const key of ACCENT_KEYS) {
    const value = computed.getPropertyValue(ACCENT_VAR[key]).trim()
    if (value) vars[ACCENT_VAR[key]] = value
  }
  BUILT_IN_ACCENT.set(root, vars)
}

/**
 * The built-in ramp, for a subtree that must show it while the document is
 * themed — the settings preview when the reseller clears or is refused a colour.
 *
 * A custom property set on the root is inherited by every element below it and
 * cannot be un-inherited, so the preview has to re-declare these explicitly or
 * it silently keeps showing the accent that is already saved.
 *
 * Empty until a brand has been applied to that element, which leaves the caller
 * inheriting — correct, because nothing is overriding the stylesheet yet.
 */
export function builtInAccentVars(root: HTMLElement): Record<string, string> {
  return BUILT_IN_ACCENT.get(root) ?? {}
}

/**
 * Writes a brand onto the document: accent overrides, title, theme colour.
 *
 * Every one of the five properties is either set or REMOVED on each call, never
 * left as it was. Switching from a themed profile to a default one has to
 * restore the built-in ramp completely; a surviving --accent-10 would leave a
 * reseller's hover on the product's own button.
 */
export function applyBrandToDocument(brand: BrandProfile, root: HTMLElement): void {
  // Before the first write, while computed style still answers with the ramp
  // tokens.css declares rather than with an override.
  captureBuiltInAccent(root)

  const vars = accentVars(brand.accent)

  for (const key of ACCENT_KEYS) {
    const name = ACCENT_VAR[key]
    const value = vars[name]
    if (value === undefined) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }

  const doc = root.ownerDocument
  doc.title = documentTitle(brand)

  const accentBase = vars[ACCENT_VAR.base] ?? BUILT_IN_ACCENT.get(root)?.[ACCENT_VAR.base] ?? '#0D9488'
  const icon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) {
    if (!ORIGINAL_FAVICON.has(doc)) ORIGINAL_FAVICON.set(doc, icon.href)
    icon.href = faviconDataUri(brand, accentBase)
  }

  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) {
    if (!ORIGINAL_THEME_COLOR.has(doc)) ORIGINAL_THEME_COLOR.set(doc, meta.content)
    meta.content = vars[ACCENT_VAR.base] ?? ORIGINAL_THEME_COLOR.get(doc) ?? meta.content
  }
}

/**
 * The credit line at the foot of a receipt or invoice — the whole white-label
 * promise, in one function so the thermal slip and the A4 sheet cannot differ.
 *
 * Three states, and the Settings copy already described all three before any of
 * them worked:
 *
 *  - A `documentFooter` the reseller typed WINS outright. It is their line about
 *    their product, and `hidePoweredBy` is not about it.
 *  - With none set, documents carry the vendor credit — which is what the toggle
 *    beside it promises in so many words, and what nothing printed.
 *  - `hidePoweredBy` removes that credit and only that. A reseller selling this
 *    as their own gets paper with no trace of the vendor on it.
 *
 * Null means print nothing, so a caller can render the element conditionally
 * rather than emitting an empty line that still costs a row of thermal paper.
 */
export function documentCredit(brand: BrandProfile | null | undefined): string | null {
  if (!brand) return null
  const own = brand.documentFooter?.trim()
  if (own) return own
  return brand.hidePoweredBy ? null : `Powered by ${DEFAULT_BRAND.productName}`
}
