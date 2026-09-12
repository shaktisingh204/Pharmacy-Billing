import { Building2, CalendarClock, FileBadge, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { Field, Section, StoreForm, inputClass } from './SettingsForm'
import type { FormContext } from './SettingsForm'

/**
 * The pharmacy's own identity — and it is EDITABLE now.
 *
 * It was read-only, with a comment saying a panel that tells the truth beats an
 * editable one that has not been wired to validation. The validation exists
 * (`api/storeSettings.ts`), so the honest thing is no longer a locked panel: a
 * shop that moves premises, adds a second drug licence or corrects a mistyped
 * GSTIN should not need a developer.
 *
 * What is on this panel is exactly what PRINTS AT THE HEAD OF A BILL, plus the
 * two numbers a Drug Inspector asks for. So the panel shows that head as it will
 * print, live, beside the fields — because the failure this screen is actually
 * guarding against is not an invalid GSTIN (the adapter refuses those) but a
 * correct-looking address that reads as nonsense once it is centred on a 42-column
 * roll.
 */
export function StoreSettings() {
  return (
    <StoreForm
      title="Pharmacy"
      intro="Who this shop is on paper. Everything here prints at the head of every bill, and the two statutory numbers are what an inspector checks."
    >
      {(ctx) => (
        <>
          <Section
            title="Identity"
            icon={Building2}
            description="The name and address of these premises, as they should appear on a customer's bill."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Pharmacy name"
                name="name"
                failedField={ctx.failedField}
                hint="Set in the largest type on the receipt."
              >
                <input
                  aria-label="Pharmacy name"
                  value={ctx.store.name}
                  onChange={(e) => ctx.set('name', e.target.value)}
                  className={inputClass(ctx.failedField === 'name')}
                />
              </Field>
              <Field
                label="Tagline"
                hint="One line under the name. Leave empty to drop it from the bill."
              >
                <input
                  aria-label="Tagline"
                  value={ctx.store.tagline ?? ''}
                  onChange={(e) => ctx.set('tagline', e.target.value)}
                  className={inputClass()}
                />
              </Field>
            </div>

            <Field
              label="Address"
              name="addressLine"
              failedField={ctx.failedField}
              hint="Street and premises. A bill that does not say where it was issued is not traceable to this shop."
            >
              <input
                aria-label="Address"
                value={ctx.store.addressLine}
                onChange={(e) => ctx.set('addressLine', e.target.value)}
                className={inputClass(ctx.failedField === 'addressLine')}
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_120px]">
              <Field label="City" name="city" failedField={ctx.failedField}>
                <input
                  aria-label="City"
                  value={ctx.store.city}
                  onChange={(e) => ctx.set('city', e.target.value)}
                  className={inputClass(ctx.failedField === 'city')}
                />
              </Field>
              <Field label="State" name="state" failedField={ctx.failedField}>
                <input
                  aria-label="State"
                  value={ctx.store.state}
                  onChange={(e) => ctx.set('state', e.target.value)}
                  className={inputClass(ctx.failedField === 'state')}
                />
              </Field>
              <Field
                label="State code"
                name="stateCode"
                failedField={ctx.failedField}
                hint="Two digits."
              >
                <input
                  aria-label="State code"
                  value={ctx.store.stateCode}
                  onChange={(e) => ctx.set('stateCode', e.target.value)}
                  maxLength={2}
                  inputMode="numeric"
                  className={cn('num text-left', inputClass(ctx.failedField === 'stateCode'))}
                />
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Phone"
                name="phone"
                failedField={ctx.failedField}
                hint="How a customer reaches the shop about what they were dispensed."
              >
                <input
                  aria-label="Phone"
                  value={ctx.store.phone}
                  onChange={(e) => ctx.set('phone', e.target.value)}
                  className={inputClass(ctx.failedField === 'phone')}
                />
              </Field>
              <Field
                label="Email"
                name="email"
                failedField={ctx.failedField}
                hint="Optional. Not printed on a thermal bill; it goes on the A4 tax invoice."
              >
                <input
                  aria-label="Email"
                  value={ctx.store.email ?? ''}
                  onChange={(e) => ctx.set('email', e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass(ctx.failedField === 'email')}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Statutory"
            icon={ShieldCheck}
            description="Both of these are legally required on a retail drug bill. Neither is decoration."
          >
            <Field
              label="GSTIN"
              name="gstin"
              failedField={ctx.failedField}
              hint={
                <>
                  Fifteen characters, and what a return is filed against. Its first two characters
                  are the state — they have to match the state code above, or bills are taxed
                  against one state and filed against the other.
                </>
              }
            >
              <input
                aria-label="GSTIN"
                value={ctx.store.gstin}
                onChange={(e) => ctx.set('gstin', e.target.value)}
                maxLength={15}
                autoComplete="off"
                spellCheck={false}
                className={cn('mono uppercase', inputClass(ctx.failedField === 'gstin'))}
              />
            </Field>

            <LicenceList ctx={ctx} />
          </Section>

          <Section
            title="Near-expiry windows"
            icon={CalendarClock}
            description="The day counts Inventory and Medicines colour a batch at. They nest: a batch inside the smallest window is inside all of them."
          >
            <BucketList ctx={ctx} />
          </Section>

          <BillHead ctx={ctx} />
        </>
      )}
    </StoreForm>
  )
}

/* -------------------------------------------------------- drug licences --- */

function LicenceList({ ctx }: { ctx: FormContext }) {
  const list = ctx.store.dlNos.length > 0 ? ctx.store.dlNos : ['']
  const write = (next: string[]) => ctx.set('dlNos', next)

  return (
    <div className="min-w-0">
      <span className={cn('micro-label', ctx.failedField === 'dlNos' && 'text-danger-11')}>
        Drug licence numbers
      </span>
      <p className="mt-1 max-w-[70ch] text-xs text-fg-subtle">
        {/* A shop routinely holds two: 20B to sell allopathic drugs and 21B to
            stock them. Both print, so both are held as a list rather than as one
            free-text line somebody has to remember to separate with a slash. */}
        Most shops hold two — a 20B to sell and a 21B to stock. Every number here prints on every
        bill; a retail drug bill without one is not a compliant bill.
      </p>

      <ul className="mt-2.5 flex flex-col gap-2">
        {list.map((dl, i) => (
          // The index IS the identity here: the values are editable and two blank
          // rows are legitimately indistinguishable.
          // eslint-disable-next-line react/no-array-index-key
          <li key={i} className="flex items-center gap-2">
            <input
              aria-label={`Drug licence ${i + 1}`}
              value={dl}
              placeholder="MH-PN2-20B"
              onChange={(e) => write(list.map((v, j) => (j === i ? e.target.value : v)))}
              className={cn('mono', inputClass(ctx.failedField === 'dlNos'))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove drug licence ${i + 1}`}
              disabled={list.length === 1 && dl.trim() === ''}
              onClick={() => write(list.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      <Button className="mt-2.5" onClick={() => write([...list, ''])}>
        <Plus /> Add a licence number
      </Button>
    </div>
  )
}

/* ------------------------------------------------------ expiry windows ---- */

const BUCKET_TONE: Record<number, string> = {
  30: 'var(--status-expiry-30)',
  60: 'var(--status-expiry-60)',
  90: 'var(--status-expiry-90)',
  180: 'var(--status-expiry-180)',
}

function BucketList({ ctx }: { ctx: FormContext }) {
  const list = ctx.store.nearExpiryBuckets
  const write = (next: number[]) => ctx.set('nearExpiryBuckets', next)

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-end gap-3">
        {list.map((days, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="flex items-end gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="micro-label">Window {i + 1}</span>
              <span className="flex items-center gap-2">
                <input
                  aria-label={`Near-expiry window ${i + 1} in days`}
                  type="number"
                  min={1}
                  max={730}
                  value={days}
                  onChange={(e) => write(list.map((v, j) => (j === i ? Number(e.target.value) : v)))}
                  className={cn('num w-[104px] text-right', inputClass(ctx.failedField === 'nearExpiryBuckets'))}
                />
                <span className="text-sm text-fg-muted">days</span>
              </span>
            </label>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove near-expiry window ${i + 1}`}
              disabled={list.length === 1}
              onClick={() => write(list.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={list.length >= 6}
          onClick={() => write([...list, Math.max(1, Math.round((Math.min(...list) || 60) / 2))])}
        >
          <Plus /> Add a window
        </Button>
        <span className="text-xs text-fg-subtle">
          Saved widest first. The day close warns at the smallest window and the dashboard counts
          up to the widest.
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {[...list].sort((a, b) => b - a).map((d) => (
          <span
            key={d}
            className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-2xs font-medium"
            style={{
              color: BUCKET_TONE[d] ?? 'var(--fg-muted)',
              backgroundColor: `color-mix(in srgb, ${BUCKET_TONE[d] ?? 'var(--fg-muted)'} 12%, transparent)`,
            }}
          >
            <CalendarClock size={12} strokeWidth={2.25} aria-hidden />
            {d} days
          </span>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- bill head --- */

/**
 * What the fields above become on the roll.
 *
 * Set on the receipt's own character grid at 42 columns, because that is the
 * question this panel cannot otherwise answer: an address that reads perfectly
 * in a form field can be three wrapped lines of fragments on paper, and nobody
 * discovers it until a customer is holding one.
 */
function BillHead({ ctx }: { ctx: FormContext }) {
  const s = ctx.store
  const lines = [
    s.name.toUpperCase(),
    ...(s.tagline ? [s.tagline] : []),
    s.addressLine,
    `${s.city}, ${s.state}`,
    `Ph ${s.phone}`,
    `GSTIN ${s.gstin}`,
    ...(s.dlNos.filter((d) => d.trim() !== '').length > 0
      ? [`DL ${s.dlNos.filter((d) => d.trim() !== '').join(' / ')}`]
      : []),
  ]

  return (
    <Section
      title="How this prints"
      icon={FileBadge}
      description="The head of an 80 mm bill, at its real width of 42 characters. A line longer than the roll wraps here exactly as it will on paper."
    >
      <div className="rounded-[var(--radius-lg)] border border-dashed border-border bg-subtle p-4">
        <pre className="mono overflow-x-auto text-2xs leading-[1.6] text-fg">
{lines.map((line) => centre(line, 42)).join('\n')}
{'\n'}{'-'.repeat(42)}
        </pre>
      </div>
    </Section>
  )
}

/** Centre in `cols` cells, wrapping on words the way the receipt grid does. */
function centre(text: string, cols: number): string {
  const words = text.split(' ')
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    const candidate = row === '' ? word : `${row} ${word}`
    if (candidate.length > cols && row !== '') {
      rows.push(row)
      row = word
    } else {
      row = candidate
    }
  }
  if (row !== '') rows.push(row)
  return rows
    .map((r) => ' '.repeat(Math.max(0, Math.floor((cols - r.length) / 2))) + r)
    .join('\n')
}
