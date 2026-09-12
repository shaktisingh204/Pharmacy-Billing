import { expect, test } from '@playwright/test'

/**
 * Printing settings.
 *
 * A real serial port cannot be driven from a headless browser, so what is
 * asserted here is everything around it: that the panel is no longer a
 * placeholder, that it degrades honestly where WebSerial does not exist, and
 * that the two settings which actually break a printer are present and
 * explained. The byte generation itself is covered exhaustively in unit tests,
 * which is where those bugs live.
 */
test.describe('printing settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Printing' }).click()
    await expect(page.getByRole('heading', { name: 'Printing', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('is a real panel, not a "coming soon"', async ({ page }) => {
    await expect(page.getByText(/Full fidelity|coming soon/i)).toHaveCount(0)
    await expect(page.getByRole('radiogroup', { name: 'Roll width' })).toBeVisible()
  })

  test('offers the roll widths the receipt renderer actually supports', async ({ page }) => {
    for (const label of ['58 mm', '80 mm']) {
      await expect(page.getByRole('radio', { name: new RegExp(label) }).first()).toBeVisible()
    }
  })

  test('explains the rupee sign, which is what looks broken on a new printer', async ({ page }) => {
    // ₹ was adopted in 2010 and is in none of the classic printer character
    // sets. The setting is worthless without the reason beside it.
    await expect(page.getByText(/adopted in 2010/)).toBeVisible()
    const toggle = page.getByRole('checkbox', { name: /Print Rs instead of ₹/ })
    await expect(toggle).toBeChecked()
  })

  test('says plainly that nobody loses a bill when the printer fails', async ({ page }) => {
    await expect(page.getByText(/falls\s+back to the browser dialog/)).toBeVisible()
  })

  test('the roll width survives a reload', async ({ page }) => {
    await page.getByRole('radio', { name: /58 mm/ }).click()
    await expect(page.getByRole('radio', { name: /58 mm/ })).toHaveAttribute('aria-checked', 'true')

    await page.reload()
    await page.getByRole('button', { name: 'Printing' }).click()
    await expect(page.getByRole('radio', { name: /58 mm/ }))
      .toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
  })
})
