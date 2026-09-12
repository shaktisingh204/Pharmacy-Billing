import { CalendarRange, Hash, Scale } from 'lucide-react'
import { Field, Section, StoreForm, Toggle, inputClass } from './SettingsForm'

/**
 * Invoice &amp; GST.
 *
 * Two of these fields are unlike every other setting in the app: the invoice
 * prefix and the financial-year start decide DOCUMENT NUMBERS, and a document
 * number is the one thing everything downstream assumes is unique and unbroken.
 * The adapter refuses to change either once documents exist in the year, and the
 * refusal says how many and why — so the control is shown rather than hidden,
 * because a field that vanishes teaches nothing.
 *
 * The filing thresholds are here for the reason they were made settings in the
 * first place: they are unverified law, and a notification should be an edit
 * rather than a deploy. Until this panel existed, that was only half true.
 */
export function InvoiceSettings() {
  return (
    <StoreForm
      title="Invoice & GST"
      intro="The number series, how tax rounds, and the thresholds the filing check applies. The series fields are locked once documents exist in the financial year."
    >
      {({ store, set, setFiling, failedField }) => (
        <>
          <Section
            title="Numbering"
            icon={Hash}
            description="Both of these decide DOCUMENT NUMBERS, and a document number is the one thing everything downstream assumes is unique and unbroken."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Invoice prefix"
                name="invoicePrefix"
                failedField={failedField}
                hint="Becomes part of every invoice number. Locked once the year has documents in it — two prefixes inside one financial year cannot be reported as either one series or two."
              >
                <input
                  aria-label="Invoice prefix"
                  value={store.invoicePrefix}
                  onChange={(e) => set('invoicePrefix', e.target.value)}
                  maxLength={6}
                  className={inputClass(failedField === 'invoicePrefix')}
                />
              </Field>

              <Field
                label="Financial year starts"
                name="financialYearStartMonth"
                failedField={failedField}
                hint="April for most Indian businesses. Moving it once numbers have been given out can re-issue one."
              >
                <select
                  aria-label="Financial year starts"
                  value={store.financialYearStartMonth}
                  onChange={(e) => set('financialYearStartMonth', Number(e.target.value))}
                  className={inputClass(failedField === 'financialYearStartMonth')}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>

          <Section
            title="At the counter"
            icon={Scale}
            description="How a bill settles, and which batches the counter is allowed to reach for."
          >
            <div className="flex flex-col gap-3">
              <Toggle
                checked={store.roundOffEnabled}
                onChange={(v) => set('roundOffEnabled', v)}
                label="Round bills to the nearest rupee"
                hint="The round-off is printed as its own line, never absorbed into a total."
              />
              <Toggle
                checked={store.allowNegativeStock}
                onChange={(v) => set('allowNegativeStock', v)}
                label="Allow a sale when the shelf says empty"
                hint="Off by default. Only for a shop whose shelf is routinely ahead of its data." 
              />
              <Field
                label="Stop auto-allocating a batch this many days before expiry"
                name="expiryGuardDays"
                failedField={failedField}
                hint="The counter can still pick such a batch by hand; it just will not be chosen for them."
              >
                <input
                  aria-label="Expiry guard days"
                  type="number"
                  min={0}
                  max={365}
                  value={store.expiryGuardDays}
                  onChange={(e) => set('expiryGuardDays', Number(e.target.value))}
                  className={`num text-right ${inputClass(failedField === 'expiryGuardDays')} w-[140px]`}
                />
              </Field>
            </div>
          </Section>

          {/* Said plainly, because the alternative is a screen that looks like it
              knows the law. Every figure here is recorded as unverified in
              docs/UNVERIFIED.md and the filing check prints the one it used. */}
          <Section
            title="Filing thresholds"
            icon={CalendarRange}
            description="Settings, not law. Nothing is filed on them — they only decide what the filing check counts and warns about. Sources disagree on the B2CL figure, so it ships at the higher of the two."
          >
            <div className="grid gap-5 sm:grid-cols-3">
              <Field
                label="B2CL minimum"
                name="b2clMinimum"
                failedField={failedField}
                hint="Inter-state counter bills at or above this are counted as B2CL."
              >
                <input
                  aria-label="B2CL minimum"
                  value={store.filing.b2clMinimum}
                  onChange={(e) => setFiling('b2clMinimum', e.target.value as never)}
                  inputMode="decimal"
                  className={`num ${inputClass(failedField === 'b2clMinimum')}`}
                />
              </Field>
              <Field
                label="Rule 46 minimum"
                name="rule46Minimum"
                failedField={failedField}
                hint="Above this, an unnamed counter bill raises a warning."
              >
                <input
                  aria-label="Rule 46 minimum"
                  value={store.filing.rule46Minimum}
                  onChange={(e) => setFiling('rule46Minimum', e.target.value as never)}
                  inputMode="decimal"
                  className={`num ${inputClass(failedField === 'rule46Minimum')}`}
                />
              </Field>
              <Field
                label="HSN digits"
                name="hsnDigits"
                failedField={failedField}
                hint="Depends on annual turnover, which this app does not hold."
              >
                <select
                  aria-label="HSN digits"
                  value={store.filing.hsnDigits}
                  onChange={(e) => setFiling('hsnDigits', Number(e.target.value) as never)}
                  className={inputClass(failedField === 'hsnDigits')}
                >
                  {[4, 6, 8].map((d) => <option key={d} value={d}>{d} digits</option>)}
                </select>
              </Field>
            </div>
          </Section>
        </>
      )}
    </StoreForm>
  )
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const
