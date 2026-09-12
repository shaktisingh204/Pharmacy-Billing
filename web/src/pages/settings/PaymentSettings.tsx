import { MessageSquareQuote, QrCode } from 'lucide-react'
import { Field, Section, StoreForm, inputClass } from './SettingsForm'

/**
 * Payments.
 *
 * One field here reaches paper: the UPI id becomes the dynamic QR printed on
 * every bill, with the invoice number in its `tr` field so the bank statement
 * reconciles itself. A wrong one does not fail — it takes the customer's money
 * somewhere else entirely, and nobody finds out until the day's cash is counted.
 * So it is validated, and clearing it says what it removes.
 */
export function PaymentSettings() {
  return (
    <StoreForm
      title="Payments"
      intro="The UPI id printed as a QR on every bill, and the note that closes the receipt."
    >
      {({ store, set, failedField }) => (
        <>
          <Section
            title="UPI"
            icon={QrCode}
            description="The one field on this panel that reaches paper. It becomes the dynamic QR on every bill, carrying the invoice number so the bank statement reconciles itself."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="UPI ID"
                name="upiVpa"
                failedField={failedField}
                hint="Printed as a QR on every bill, carrying the invoice number so the bank statement reconciles itself. Leave empty for no QR."
              >
                <input
                  aria-label="UPI ID"
                  value={store.upiVpa ?? ''}
                  onChange={(e) => set('upiVpa', e.target.value)}
                  placeholder="sanjeevani@okhdfc"
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass(failedField === 'upiVpa')}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Receipt footer"
            icon={MessageSquareQuote}
            description="Most shops close a bill with their return policy and a storage line. It is the last thing a customer reads."
          >
            <Field
              label="The line that closes every bill"
              hint="Wrapped to the roll when it prints. Long is fine; it will not overflow."
            >
              <textarea
                aria-label="Receipt footer note"
                value={store.footerNote}
                onChange={(e) => set('footerNote', e.target.value)}
                rows={3}
                maxLength={240}
                className="rounded-[var(--radius-md)] border border-border bg-surface p-3 text-base hover:border-border-strong"
              />
            </Field>

            <div className="rounded-[var(--radius-lg)] border border-dashed border-border bg-subtle px-4 py-3 text-center">
              <span className="micro-label mb-1.5 block">As it closes the roll</span>
              <span className="mono block whitespace-pre-wrap text-2xs leading-[1.7] text-fg">
                {wrapToRoll(store.footerNote.trim() || 'Thank you · Visit again', 42)}
              </span>
            </div>
          </Section>

          <p className="max-w-[76ch] text-sm text-fg-subtle">
            {/* Which modes exist is not a setting: the tax and the day close both
                depend on the set being fixed, and a shop that could delete CASH
                would have a day close that cannot balance. */}
            Cash, UPI, card and khata are always available. Which modes a person may take is set
            per role on Users &amp; Roles, not here.
          </p>
        </>
      )}
    </StoreForm>
  )
}

/** Centre-wrapped the way the receipt's character grid does it. */
function wrapToRoll(text: string, cols: number): string {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    const next = row === '' ? word : `${row} ${word}`
    if (next.length > cols && row !== '') {
      rows.push(row)
      row = word
    } else {
      row = next
    }
  }
  if (row !== '') rows.push(row)
  return rows.join('\n')
}
