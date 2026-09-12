import { expect, test } from '@playwright/test'

/**
 * Help & Support, and the health check behind it.
 *
 * The button was a `<button>` with no onClick — worse than an absent one,
 * because it teaches the operator that clicking here has no effect. And `?` is
 * declared a GLOBAL shortcut while the cheat sheet was mounted only inside the
 * billing screen, so it did nothing on ten of the eleven pages that advertise it.
 */
test.describe('help and data health', () => {
  test('the Help button opens something', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Help & Support' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Help & Support' })).toBeVisible()
  })

  test('? opens the cheat sheet away from billing, as the shortcut claims', async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
  })

  test('reconciles the ledger against the shelf and says so plainly', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Help & Support' }).click()

    // Invariant I17. The seeded book is built by replaying real movements, so it
    // must balance — if this ever fails, the seed generator has broken the
    // ledger, which is exactly what the check exists to catch.
    await expect(page.getByText(/Stock ledger balanced/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/no discrepancies/)).toBeVisible()
  })

  test('offers the diagnostics as one copyable action', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Help & Support' }).click()
    const copy = page.getByRole('button', { name: /Copy diagnostics/ })
    await expect(copy).toBeEnabled({ timeout: 30_000 })
  })

  test('the help dialog does not let a shortcut fire underneath it', async ({ page }) => {
    // A modal is exclusive. Without that, F2 starts a new bill under the overlay.
    await page.goto('/dashboard')
    await page.getByRole('button', { name: 'Help & Support' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('F2')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})
