import { expect, test } from '@playwright/test'

/**
 * Filing readiness.
 *
 * The screen's two commitments are what these assert: it asserts no law, and it
 * files nothing. A compliance panel that states an unverified threshold as fact
 * is worse than none, because it gets believed.
 */
test.describe('filing readiness', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/reports?r=GST_RATE_SUMMARY')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('says whether the period would be rejected, and shows the money', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /would be rejected|Nothing here would be rejected/ }),
    ).toBeVisible({ timeout: 20_000 })
    /* Scoped to the panel: the report table underneath has its own "Taxable ₹"
       column header, and an unscoped match finds both. */
    const panel = page.getByRole('region', { name: 'Filing readiness' })
    await expect(panel.getByText('Taxable', { exact: true })).toBeVisible()
    await expect(panel.getByText('CGST', { exact: true })).toBeVisible()
  })

  test('reports the document series as total, cancelled and net', async ({ page }) => {
    // Table 13 asks for exactly this, which is why a voided bill keeps its
    // number and stays in the book instead of being deleted.
    await expect(page.getByRole('heading', { name: 'Documents issued' }))
      .toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('columnheader', { name: 'Cancelled' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Net' })).toBeVisible()
  })

  test('NAMES every threshold it used and refuses to claim it files anything', async ({ page }) => {
    const reveal = page.getByRole('button', { name: /What this checked, and what it did not/ })
    await expect(reveal).toBeVisible({ timeout: 20_000 })
    await reveal.click()

    // The figure actually applied, not just the word "threshold".
    await expect(page.getByText(/B2CL threshold used: ₹250000\.00/)).toBeVisible()
    // And that the sources for it disagree, rather than asserting it as law.
    await expect(page.getByText(/conflict on this figure/)).toBeVisible()
    await expect(page.getByText(/generates no GSTR-1 JSON and files nothing/)).toBeVisible()
  })

  test('does not appear over a stock report, where it would be noise', async ({ page }) => {
    await page.goto('/reports?r=STOCK_VALUATION')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: /What this checked/ })).toHaveCount(0)
  })
})
