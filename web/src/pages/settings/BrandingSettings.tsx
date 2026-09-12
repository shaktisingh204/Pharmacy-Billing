import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CircleCheck, ImageOff, Palette, Receipt, RotateCcw, Store, Trash2, TriangleAlert, Upload,
} from 'lucide-react'
import type { BrandProfile } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { ErrorState, SkeletonRows } from '@/components/states'
import {
  DEFAULT_BRAND,
  MIN_BASE_CONTRAST,
  accentVars,
  builtInAccentVars,
  checkAccent,
  contrastOnWhite,
  currentAccentBase,
  deriveAccent,
  formatRatio,
  normalizeHex,
} from '@/brand/applyBrand'
import { brandQueryKey, brandQueryOptions } from '@/brand/useBrand'
import { PanelHeader, Section } from './SettingsForm'
import { WhiteLabelPreview } from './WhiteLabelPreview'

/**
 * Where a reseller rebrands the product without touching the code.
 *
 * The panel is deliberately opinionated about what it will accept. A reseller is
 * looking at their logo, not at a contrast checker, and the failure mode is not
 * "slightly off brand" — it is a counter full of primary buttons nobody can
 * read, discovered by a pharmacist at 9pm. So the accent is checked before it
 * can be saved, and the check is explained in words rather than shown as a red
 * ring on a field.
 *
 * Everything the reseller can change is previewed at real size, against the real
 * components, because a swatch tells you nothing about what a button looks like.
 */

/**
 * 64KB, and the panel says so out loud.
 *
 * The logo is a data URI stored inside the profile, so it is carried by every
 * getBrand() and re-parsed on every boot. A 400KB PNG here is a 400KB PNG on the
 * critical path of a till that has to open in under a second.
 */
const LOGO_MAX_BYTES = 64 * 1024
const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp'

const NAME_MAX = 32
const MARK_MAX = 3

interface Draft {
  productName: string
  markText: string
  logoUrl: string | null
  /** Empty means "no override" — the built-in ramp, not a colour. */
  accentBase: string
  tagline: string
  documentFooter: string
  hidePoweredBy: boolean
}

type FieldName = 'productName' | 'markText' | 'accentBase'

/** Reading order: submit focuses the first invalid field going down the form. */
const FIELD_ORDER: FieldName[] = ['productName', 'markText', 'accentBase']

function toDraft(brand: BrandProfile): Draft {
  return {
    productName: brand.productName,
    markText: brand.markText,
    logoUrl: brand.logoUrl,
    accentBase: brand.accent?.base ?? '',
    tagline: brand.tagline ?? '',
    documentFooter: brand.documentFooter ?? '',
    hidePoweredBy: brand.hidePoweredBy,
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toProfile(draft: Draft): BrandProfile {
  return {
    productName: draft.productName.trim(),
    markText: draft.markText.trim(),
    logoUrl: draft.logoUrl,
    // The full ramp is derived once, here, and stored. The shell then paints
    // exactly what this panel previewed rather than re-deriving it later.
    accent: draft.accentBase.trim() === '' ? null : deriveAccent(draft.accentBase.trim()),
    tagline: blankToNull(draft.tagline),
    documentFooter: blankToNull(draft.documentFooter),
    hidePoweredBy: draft.hidePoweredBy,
  }
}

/** The accent as the validator wants it: a base, with the rest left to derive. */
function pendingAccent(base: string): BrandProfile['accent'] {
  const trimmed = base.trim()
  return trimmed === '' ? null : { base: trimmed, hover: '', text: '', tint: '', ring: '' }
}

function validate(draft: Draft): Partial<Record<FieldName, string>> {
  const found: Partial<Record<FieldName, string>> = {}

  if (draft.productName.trim() === '') {
    found.productName = 'A product name is required — it names the app and every document.'
  } else if (draft.productName.trim().length > NAME_MAX) {
    found.productName = `At most ${NAME_MAX} characters; longer names truncate in the sidebar.`
  }

  const mark = draft.markText.trim()
  if (mark === '') found.markText = 'One to three characters.'
  else if (mark.length > MARK_MAX) found.markText = `At most ${MARK_MAX} characters.`

  const rejection = checkAccent(pendingAccent(draft.accentBase))[0]
  if (rejection) found.accentBase = rejection.reason

  return found
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

export function BrandingSettings() {
  const api = useApi()
  const qc = useQueryClient()
  const { data: loaded, isPending, error, refetch } = useQuery(brandQueryOptions(api))

  const [draft, setDraft] = useState<Draft | null>(null)
  const [lastLoaded, setLastLoaded] = useState<BrandProfile | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [logoError, setLogoError] = useState<string | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const fieldRefs = useRef<Partial<Record<FieldName, HTMLInputElement | null>>>({})

  /* Seed the draft from the loaded profile during render — never from an effect,
     which would paint one frame of empty inputs first. */
  if (loaded && loaded !== lastLoaded) {
    setLastLoaded(loaded)
    setDraft(toDraft(loaded))
    setErrors({})
  }

  /* Whatever accent is painted right now, captured once: it is the sensible
     starting point for the colour picker and it must not move under the user. */
  const [seedColour] = useState(() => currentAccentBase(document.documentElement))

  const save = useMutation({
    mutationFn: (profile: BrandProfile) => api.saveBrand(profile),
    onSuccess: (saved) => {
      // Writing through the shared key re-themes the shell without a refetch.
      qc.setQueryData(brandQueryKey, saved)
      toast.success('Branding saved', {
        description: 'The shell and every document printed from now on use it.',
      })
    },
    onError: (e: unknown) => {
      toast.error('Could not save branding', {
        description: e instanceof Error ? e.message : 'Try again.',
      })
    },
  })

  if (error) {
    return <ErrorState message="Branding could not be loaded." onRetry={() => void refetch()} />
  }
  if (isPending || !draft || !loaded) {
    return <div className="card m-5 p-4"><SkeletonRows rows={7} cols={3} /></div>
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(loaded))
  const accentTrimmed = draft.accentBase.trim()
  const accentRejection = checkAccent(pendingAccent(accentTrimmed))[0]
  const accentRatio = accentTrimmed === '' ? null : contrastOnWhite(accentTrimmed)
  /* An empty override means the built-in ramp — which has to be RE-DECLARED on
     the preview, not inherited: the root already carries the saved accent, so
     inheriting would show a reseller their old colour while the panel tells them
     they are back on the built-in one. */
  const pendingVars = accentVars(pendingAccent(accentTrimmed))
  const previewVars =
    Object.keys(pendingVars).length > 0 ? pendingVars : builtInAccentVars(document.documentElement)
  const parsedAccent = normalizeHex(accentTrimmed)
  /* The swatch only ever holds a complete colour. Feeding it a half-typed hex
     makes it snap to black between keystrokes, which reads as a bug. */
  const swatch = parsedAccent ?? seedColour ?? ''
  /* A colour is only ARGUED with once it is complete. Half of "#4338ca" is not a
     mistake, it is a person typing, and a red alert on every keystroke teaches
     people to ignore the one that matters. */
  const accentFails = parsedAccent !== null && accentRejection !== undefined
  const accentInvalid = accentFails || errors.accentBase !== undefined

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return

    const found = validate(draft)
    setErrors(found)
    const firstBad = FIELD_ORDER.find((f) => found[f])
    if (firstBad) {
      /* Refuse the save outright rather than dropping the offending field and
         writing the rest: a half-saved profile is how a reseller ends up
         convinced the accent "didn't stick". */
      fieldRefs.current[firstBad]?.focus()
      return
    }
    save.mutate(toProfile(draft))
  }

  function onPickLogo(file: File) {
    setLogoError(null)
    /* Base64 only ever inflates, so a file already over the cap cannot come back
       under it — and reading a 20MB pick to find that out freezes the tab on the
       machine least able to afford it. */
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(
        `${formatKb(file.size)}, and the cap is ${formatKb(LOGO_MAX_BYTES)}. ` +
          'Export it smaller, or use an SVG.',
      )
      return
    }

    const reader = new FileReader()
    reader.onerror = () => setLogoError('That file could not be read.')
    reader.onload = () => {
      const uri = typeof reader.result === 'string' ? reader.result : ''
      if (!uri.startsWith('data:image/')) {
        setLogoError('That is not an image file.')
        return
      }
      if (uri.length > LOGO_MAX_BYTES) {
        setLogoError(
          `${formatKb(uri.length)} once encoded, and the cap is ${formatKb(LOGO_MAX_BYTES)}. ` +
            'Export it smaller, or use an SVG.',
        )
        return
      }
      set('logoUrl', uri)
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="h-full">
      <form
        onSubmit={onSubmit}
        className="mx-auto grid max-w-[1240px] xl:grid-cols-[minmax(0,1fr)_392px]"
        style={{ gap: 'var(--card-gap)', padding: 'var(--card-px)' }}
      >
        <div className="flex min-w-0 flex-col" style={{ gap: 'var(--card-gap)' }}>
          <PanelHeader
            title="Branding"
            intro="Name, mark and colour are stored as data, not built into the app. A reseller changes them here; nothing is forked and nothing is redeployed."
          />

          <Section
            title="Identity"
            icon={Store}
            description="The name, mark and logo that carry through the shell, the browser tab and every document."
          >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field
                name="productName"
                label="Product name"
                required
                value={draft.productName}
                onChange={(v) => set('productName', v)}
                error={errors.productName}
                hint="Shown in the sidebar, the browser tab and on every document."
                maxLength={NAME_MAX + 8}
                inputRef={(el) => { fieldRefs.current.productName = el }}
              />
              <Field
                name="markText"
                label="Mark"
                required
                value={draft.markText}
                onChange={(v) => set('markText', v)}
                error={errors.markText}
                hint="1–3 characters."
                maxLength={MARK_MAX}
                className="text-center font-semibold"
                inputRef={(el) => { fieldRefs.current.markText = el }}
              />
            </div>

            <Field
              name="tagline"
              label="Tagline"
              value={draft.tagline}
              onChange={(v) => set('tagline', v)}
              hint="Sits under the name in the sidebar. Leave empty to drop the line."
              maxLength={48}
            />

            <div>
              <span className="micro-label mb-1 block">Logo</span>
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={cn(
                    'grid size-11 shrink-0 place-items-center overflow-hidden',
                    'rounded-[var(--radius-md)] border border-border-subtle bg-inset',
                  )}
                >
                  {draft.logoUrl ? (
                    <img src={draft.logoUrl} alt="" className="size-full object-contain" />
                  ) : (
                    <ImageOff size={18} className="text-fg-subtle" />
                  )}
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={() => fileInput.current?.click()}>
                    <Upload /> {draft.logoUrl ? 'Replace' : 'Upload'}
                  </Button>
                  {draft.logoUrl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => { set('logoUrl', null); setLogoError(null) }}
                    >
                      <Trash2 /> Remove
                    </Button>
                  ) : null}
                </div>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept={LOGO_ACCEPT}
                tabIndex={-1}
                aria-hidden
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onPickLogo(file)
                  // Re-picking the same file after a rejection must fire again.
                  e.target.value = ''
                }}
              />

              {logoError ? (
                <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger-11">
                  <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
                  {logoError}
                </p>
              ) : (
                <p className="mt-2 text-2xs text-fg-subtle">
                  PNG, JPEG, WebP or SVG, under {formatKb(LOGO_MAX_BYTES)}. It is stored inside the
                  profile as a data URI, so it loads with the app and works offline. When set it
                  replaces the drawn mark.
                  {draft.logoUrl ? ` Currently ${formatKb(draft.logoUrl.length)}.` : ''}
                </p>
              )}
            </div>
          </Section>

          <Section
            title="Accent"
            icon={Palette}
            description="One base colour. Hover, accent text, the selected-row tint and the focus ring are all derived from it and checked for contrast before they can be saved."
          >
            <div>
              <label htmlFor="brand-accentBase" className="micro-label mb-1 block">
                Base colour
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the base colour"
                  value={swatch}
                  disabled={swatch === ''}
                  onChange={(e) => set('accentBase', e.target.value)}
                  className={cn(
                    'size-9 shrink-0 cursor-pointer rounded-[var(--radius-md)]',
                    'border border-border bg-surface p-1 disabled:opacity-50',
                  )}
                />
                <input
                  id="brand-accentBase"
                  ref={(el) => { fieldRefs.current.accentBase = el }}
                  value={draft.accentBase}
                  onChange={(e) => set('accentBase', e.target.value)}
                  placeholder="Built-in"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={accentInvalid ? true : undefined}
                  aria-describedby="brand-accent-status"
                  className={cn(
                    'mono h-9 w-[9.5rem] rounded-[var(--radius-md)] border bg-surface px-2.5 text-base uppercase',
                    accentInvalid ? 'border-danger-9' : 'border-border hover:border-border-strong',
                  )}
                />
                {accentTrimmed === '' ? null : (
                  <Button type="button" variant="ghost" onClick={() => set('accentBase', '')}>
                    <RotateCcw /> Built-in accent
                  </Button>
                )}
              </div>

              {/* The contrast verdict, in words. A pass/fail dot would be the one
                  piece of this screen that says nothing to a colourblind reader. */}
              <div id="brand-accent-status" className="mt-2 max-w-[62ch]">
                {accentTrimmed === '' ? (
                  <p className="text-2xs text-fg-subtle">
                    Using the built-in accent. Hover, accent text, the selected-row tint and the
                    focus ring are derived from whatever base you set here.
                  </p>
                ) : parsedAccent === null ? (
                  <p
                    {...(errors.accentBase ? { role: 'alert' as const } : {})}
                    className={cn('text-2xs', errors.accentBase ? 'text-danger-11' : 'text-fg-subtle')}
                  >
                    Write the colour as #RGB or #RRGGBB.
                  </p>
                ) : accentRejection ? (
                  <p role="alert" className="flex items-start gap-1.5 text-xs text-danger-11">
                    <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
                    <span>
                      <strong className="font-medium">This colour cannot be saved.</strong>{' '}
                      {accentRejection.reason} White button text on it would be unreadable at the
                      counter, so the field is refused rather than shipped.
                    </span>
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-xs text-fg-muted">
                    <CircleCheck size={13} className="mt-px shrink-0 text-success-9" aria-hidden />
                    <span>
                      Contrast against white is{' '}
                      <span className="num font-medium text-fg">
                        {formatRatio(accentRatio ?? 0)}:1
                      </span>
                      , clear of the {formatRatio(MIN_BASE_CONTRAST)}:1 floor for white text on a
                      primary button.
                    </span>
                  </p>
                )}
              </div>
            </div>
          </Section>

          <Section
            title="Documents"
            icon={Receipt}
            description="The only branding a customer takes home. A thermal head prints black on white, so this is all of it."
          >
            <Field
              name="documentFooter"
              label="Document footer"
              value={draft.documentFooter}
              onChange={(v) => set('documentFooter', v)}
              hint="Printed at the foot of every receipt and invoice."
              maxLength={64}
            />

            <Toggle
              id="brand-hidePoweredBy"
              checked={draft.hidePoweredBy}
              onChange={(v) => set('hidePoweredBy', v)}
              label="Hide the powered-by line"
              hint={`Removes the line entirely, for a reseller selling this as their own product. Off, documents carry "Powered by ${DEFAULT_BRAND.productName}".`}
            />
          </Section>

          <div
            className="sticky bottom-0 z-10 -mx-[var(--card-px)] -mb-[var(--card-px)] mt-1 flex flex-wrap items-center gap-2 border-t border-border bg-raised/95 px-[var(--card-px)] py-3 backdrop-blur"
          >
            <span
              className={cn('me-auto text-sm', dirty ? 'font-medium text-warning-11' : 'text-fg-muted')}
              aria-live="polite"
            >
              {dirty ? 'Unsaved changes.' : 'Everything is saved.'}
            </span>
            <Button
              type="button"
              variant="ghost"
              title="Restores the built-in name, mark and accent. Takes effect when you save."
              onClick={() => { setDraft(toDraft(DEFAULT_BRAND)); setErrors({}); setLogoError(null) }}
            >
              <RotateCcw /> Reset to default
            </Button>
            <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save branding'}
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------------------ preview */}
        <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start">
          <WhiteLabelPreview
            draft={draft}
            accentVars={previewVars}
            accentRefused={accentFails}
          />
        </aside>
      </form>
    </div>
  )
}

export default BrandingSettings

/* ------------------------------------------------------------------ pieces */

function Field({
  name, label, value, onChange, error, hint, required, maxLength, className, inputRef,
}: {
  name: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string | undefined
  hint?: string
  required?: boolean
  maxLength?: number
  className?: string
  inputRef?: (el: HTMLInputElement | null) => void
}) {
  const id = `brand-${name}`
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="micro-label mb-1 block">
        {label}{required && <span className="text-danger-9"> *</span>}
      </label>
      <input
        id={id}
        ref={inputRef}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(
          'h-9 w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-base',
          error ? 'border-danger-9' : 'border-border hover:border-border-strong',
          className,
        )}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger-11">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-2xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

function Toggle({
  id, checked, onChange, label, hint,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onClick={() => onChange(!checked)}
        className={cn(
          'mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-[var(--radius-full)] p-0.5',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
          checked ? 'bg-accent-9' : 'bg-inset',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-4 rounded-[var(--radius-full)] bg-surface shadow-xs',
            'transition-transform duration-[var(--dur-fast)] ease-[var(--ease)]',
            checked && 'translate-x-4',
          )}
        />
      </button>
      {/* The hint sits OUTSIDE the label: inside it, it becomes part of the
          switch's accessible name and a screen reader reads the whole paragraph
          before saying "off". */}
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-base text-fg">{label}</label>
        {hint ? (
          <span id={`${id}-hint`} className="mt-0.5 block max-w-[62ch] text-2xs text-fg-subtle">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  )
}
