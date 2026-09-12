import { expect, test } from '@playwright/test'

/**
 * The last two settings panels.
 *
 * Both were placeholders. One of them holds the filing thresholds, which the
 * previous wave shipped calling them "a setting, not a constant" — true only
 * once something can edit them.
 */
test.describe('Invoice & GST', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Invoice & GST' }).click()
    await expect(page.getByRole('heading', { name: 'Invoice & GST', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('is a real form, not a placeholder', async ({ page }) => {
    await expect(page.getByLabel('Invoice prefix')).toBeVisible()
    await expect(page.getByLabel('B2CL minimum')).toBeVisible()
  })

  test('REFUSES to change the prefix once the year has documents, and says why', async ({ page }) => {
    // Two prefixes inside one financial year cannot be reported as either one
    // series or two without a gap — and Table 13 asks for exactly that.
    await page.getByLabel('Invoice prefix').fill('SM')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/already been issued this financial year/))
      .toBeVisible({ timeout: 10_000 })
  })

  test('the filing thresholds are genuinely editable', async ({ page }) => {
    const b2cl = page.getByLabel('B2CL minimum')
    await b2cl.fill('100000.00')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 10_000 })

    // And the filing check picks the new figure up rather than the compiled one.
    await page.goto('/reports?r=GST_RATE_SUMMARY')
    await page.getByRole('button', { name: /What this checked/ }).click()
    await expect(page.getByText(/B2CL threshold used: ₹100000\.00/)).toBeVisible({ timeout: 20_000 })
  })

  test('refuses an amount that is not an amount, against the field', async ({ page }) => {
    await page.getByLabel('Rule 46 minimum').fill('fifty thousand')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/A threshold is an amount/)).toBeVisible({ timeout: 10_000 })
  })

  test('warns about what a change does elsewhere, before it is made', async ({ page }) => {
    await page.getByRole('checkbox', { name: /Allow a sale when the shelf says empty/ }).check()
    await expect(page.getByText(/removes the guard/)).toBeVisible()
  })
})

test.describe('Payments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Payments' }).click()
    await expect(page.getByRole('heading', { name: 'Payments', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('refuses a UPI id that would take money nowhere', async ({ page }) => {
    await page.getByLabel('UPI ID').fill('not-a-vpa')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/looks like name@bank/)).toBeVisible({ timeout: 10_000 })
  })

  test('saves a valid one, and says what clearing it would remove', async ({ page }) => {
    await page.getByLabel('UPI ID').fill('sanjeevani@okaxis')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 10_000 })

    await page.getByLabel('UPI ID').fill('')
    await expect(page.getByText(/removes the payment QR/)).toBeVisible()
  })
})
