import { expect, test } from '@playwright/test'

test.describe('Settings', () => {
  test('sections navigate without leaving the page', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    /* Every panel, named. The count on its own said nothing about WHICH sections
       were there — a rename or a swap kept it passing — so both are asserted. */
    const SECTIONS = [
      'Pharmacy', 'Branches', 'Branding', 'Invoice & GST', 'Price list', 'Printing', 'Payments',
      'Data & backup',
    ]
    expect(await nav.getByRole('button').count()).toBe(SECTIONS.length)
    for (const name of SECTIONS) {
      await expect(nav.getByRole('button', { name })).toBeVisible()
    }

    await nav.getByRole('button', { name: 'Branding' }).click()
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  })

  test('the statutory panel shows what legally prints on a bill', async ({ page }) => {
    await page.goto('/settings')
    // GSTIN and the drug licence are required on every retail drug bill, and an
    // operator has to be able to verify them without opening a database.
    // The label and the value both carry the word, hence .first().
    await expect(page.getByText('GSTIN').first()).toBeVisible()
    await expect(page.getByText('Drug licence').first()).toBeVisible()
  })
})

test.describe('White-label branding panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Branding' }).click()
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible()
  })

  test('renaming the product renames the shell and the tab', async ({ page }) => {
    const name = page.getByLabel(/product name/i)
    await name.fill('MediCounter')
    await page.getByRole('button', { name: /save branding/i }).click()

    // The sidebar brand block sits ALONGSIDE the nav, not inside it, so assert on
    // the shell as a whole. Both it and the tab title read the profile — neither
    // is a literal anywhere in the source.
    await expect(page).toHaveTitle(/MediCounter/, { timeout: 10_000 })
    await expect(page.getByText('MediCounter').first()).toBeVisible()

    // Reset reverts the FORM and flags "Unsaved changes"; it deliberately does not
    // persist on one click. Wiping a reseller's identity should not be a
    // single-click action with no confirmation step.
    await page.getByRole('button', { name: /reset to default/i }).click()
    await expect(page.getByText(/unsaved changes/i)).toBeVisible()
    await expect(page).toHaveTitle(/MediCounter/)

    await page.getByRole('button', { name: /save branding/i }).click()
    await expect(page).toHaveTitle(/RxBill/, { timeout: 10_000 })
  })


  test('the document footer reaches the PAPER, not just the form', async ({ page }) => {
    /* The setting existed, saved, and reached nothing: `documentFooter` and
       `hidePoweredBy` were in the contract and on this form from the start while
       neither print sheet read them. A reseller could type their name, save,
       print, and find it nowhere on the bill — which is the one thing a
       white-label buyer is actually paying for. */
    await page.getByLabel(/document footer/i).fill('Powered by MedSoft')
    await page.getByRole('button', { name: /save branding/i }).click()
    await expect(page.getByText(/everything is saved/i)).toBeVisible({ timeout: 10_000 })

    await page.goto('/sales')
    /* Scoped to the register by name. The Sales redesign put an analytics band
       above it, so an unscoped `grid` and a positional row no longer land on an
       invoice — the assertion below is unchanged, only the way it reaches a bill. */
    const register = page.getByRole('grid', { name: 'Invoice register' })
    await expect(register).toBeVisible({ timeout: 15_000 })
    await register.getByRole('row').filter({ hasText: /RX\d|KT\d/ }).first().click()
    await expect(page.getByRole('button', { name: 'Reprint' })).toBeVisible()

    /* Attached, not visible. The receipt renders into a portal on <body> that
       print.css reveals only on paper — asserting visibility here would be
       asserting that the receipt is wrongly on screen. */
    await expect(page.getByText('Powered by MedSoft')).toBeAttached({ timeout: 10_000 })
  })

  test('hiding the powered-by line leaves no trace of the vendor on a bill', async ({ page }) => {
    await page.getByLabel(/hide the powered-by line/i).check()
    await page.getByRole('button', { name: /save branding/i }).click()
    await expect(page.getByText(/everything is saved/i)).toBeVisible({ timeout: 10_000 })

    await page.goto('/sales')
    /* Scoped to the register by name. The Sales redesign put an analytics band
       above it, so an unscoped `grid` and a positional row no longer land on an
       invoice — the assertion below is unchanged, only the way it reaches a bill. */
    const register = page.getByRole('grid', { name: 'Invoice register' })
    await expect(register).toBeVisible({ timeout: 15_000 })
    await register.getByRole('row').filter({ hasText: /RX\d|KT\d/ }).first().click()
    await expect(page.getByRole('button', { name: 'Reprint' })).toBeVisible()

    await expect(page.getByText(/powered by/i)).toHaveCount(0)
  })

  test('the favicon is drawn from the brand, not hardcoded in index.html', async ({ page }) => {
    const href = await page.evaluate(
      () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '',
    )
    expect(href).toContain('data:image/svg+xml')
  })
})
