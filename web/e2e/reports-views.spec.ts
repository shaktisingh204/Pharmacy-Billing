import { expect, test } from '@playwright/test'

/**
 * Saved views and comparison — the two things that turn a report screen into a
 * routine somebody can actually repeat.
 *
 * Both assertions below are about the same property: a saved view and a
 * comparison are the REPORT RUN AGAIN, never a stored number. So a saved view is
 * checked by what it puts back in the URL, and the comparison by the fact that
 * both periods are named on screen beside their figures.
 */
test.describe('reports — saved views', () => {
  test('a view keeps the report, the filter and the index, and re-opens them', async ({ page }) => {
    await page.goto('/reports?r=ITEM_SALES&g=company&f=Cipla')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Save view' }).click()
    const dialog = page.getByRole('dialog', { name: 'Save this view' })
    await dialog.getByLabel('Name this view').fill('Cipla, company-wise')
    await dialog.getByRole('button', { name: 'Save view' }).click()

    const saved = page.getByRole('button', { name: /^Cipla, company-wise Item-wise sales/ })
    await expect(saved).toBeVisible()

    // Somewhere else entirely, then back through the saved view.
    await page.goto('/reports?r=DAY_BOOK')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    await saved.click()

    await expect(page).toHaveURL(/r=ITEM_SALES/)
    await expect(page).toHaveURL(/f=Cipla/)
    await expect(page).toHaveURL(/g=company/)
  })

  test('the period is saved as a ROLLING preset, not as the dates it produced', async ({ page }) => {
    await page.goto('/reports?r=ITEM_SALES')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Save view' }).click()
    const dialog = page.getByRole('dialog', { name: 'Save this view' })
    await dialog.getByLabel('Name this view').fill('Rolling month')
    await dialog.getByRole('button', { name: 'Save view' }).click()

    // The default period IS this month, so the view has to store the preset —
    // opening it in October must give October, not September's dates.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('rxbill.reports.saved-views.v1'))
    expect(stored).toContain('"preset":"month"')
  })
})

test.describe('reports — comparison', () => {
  test('runs the previous period and names both, or refuses and says why', async ({ page }) => {
    await page.goto('/reports?r=ITEM_SALES')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Compare' }).click()
    await expect(page).toHaveURL(/[?&]c=1/)

    const panel = page.getByRole('region', { name: 'Period comparison' })
    await expect(panel).toBeVisible({ timeout: 20_000 })
    // Both periods are on the page: a delta with no ranges beside it is a claim.
    await expect(panel.getByRole('columnheader')).toHaveCount(3)

    /* Stock valuation reads the shelf as it stands NOW, so an earlier window
       would return today's figures under an older date. The control is refused
       rather than quietly producing a fabricated trend. */
    await page.goto('/reports?r=STOCK_VALUATION')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Compare' })).toBeDisabled()
  })
})

test.describe('reports — the chart', () => {
  test('plots the rows on screen and says what it left out', async ({ page }) => {
    await page.goto('/reports?r=ITEM_SALES')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    const chart = page.getByRole('region', { name: 'Chart' })
    await expect(chart).toBeVisible()
    await chart.getByLabel('Chart it by').selectOption({ label: 'Company' })
    // The caption is the honesty: a top-N chart that hides its tail lets the
    // reader conclude the top eight ARE the business.
    await expect(chart.getByText(/values on company/)).toBeVisible()
  })
})
