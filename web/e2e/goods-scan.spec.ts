import { expect, test } from '@playwright/test'

/**
 * Scanning a carton at goods receipt.
 *
 * Batch and expiry are the most error-prone typing in the app, and both print on
 * the customer's bill. The scanner path is driven here by typing the payload
 * fast enough to trip the wedge heuristic, which is what a real scanner does.
 */

/** A GS1-128 payload: GTIN(01) · expiry(17) · batch(10). */
const GS1 = (gtin: string, yymmdd: string, batch: string) => `01${gtin}17${yymmdd}10${batch}`

/**
 * A wedge scan, dispatched IN THE PAGE.
 *
 * The detector classifies a burst by timing — mean inter-key gap ≤35ms — and
 * driving that with `keyboard.press` puts a CDP round-trip between every
 * character. On an idle machine that lands inside the window; under six parallel
 * workers it does not, and the test failed for want of CPU rather than for any
 * reason to do with scanning.
 *
 * Dispatching the keydowns from inside the page is also the truer reproduction:
 * a real wedge delivers the whole payload from the keyboard buffer in a few
 * milliseconds, which is exactly what this does. The production path under test
 * is unchanged — the same document-level keydown listener, the same heuristic.
 */
async function scan(page: import('@playwright/test').Page, payload: string) {
  await page.evaluate((text: string) => {
    for (const ch of text) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }, payload)
}

test.describe('goods receipt scanning', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/purchases')
    await expect(page.getByRole('heading', { level: 1, name: 'Purchases' }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('an unknown carton offers to be linked, and says what it is holding', async ({ page }) => {
    // A GTIN this shop has never received. The batch and expiry from the same
    // scan are held so that linking fills the whole row.
    await scan(page, GS1('09999999999999', '271130', 'ZZ99'))
    await expect(page.getByText(/is not linked to anything yet/))
      .toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('ZZ99')).toBeVisible()
    await expect(page.getByText('11/27')).toBeVisible()
    await expect(page.getByLabel('Link this carton to a medicine')).toBeVisible()
  })

  test('linking it fills the row — one scan and one pick, never a re-scan', async ({ page }) => {
    await scan(page, GS1('09999999999999', '271130', 'ZZ99'))
    await expect(page.getByLabel('Link this carton to a medicine'))
      .toBeVisible({ timeout: 15_000 })

    await page.getByLabel('Link this carton to a medicine').fill('Dolo')
    await page.getByRole('button', { name: /^Dolo 650/ }).first().click()

    await expect(page.getByText(/linked to that carton/)).toBeVisible({ timeout: 10_000 })
    /* The batch and expiry from the ORIGINAL scan land in the row. Asserted on
       the labelled cells rather than by display value: the grid holds several
       inputs and a bare value match is ambiguous about which cell it found. */
    await expect(page.getByLabel('Batch number').first()).toHaveValue('ZZ99', { timeout: 10_000 })
    await expect(page.getByLabel('Expiry, month and year').first()).toHaveValue('11/27')
    /* The medicine cell is not asserted separately: the GRN screen has another
       control by that name, so the locator is ambiguous — and the batch above
       can only have landed on a row that was already resolved to a medicine. */
  })

  test('a code matching nothing says so rather than doing nothing', async ({ page }) => {
    await scan(page, '5555555555555')
    await expect(page.getByText(/Nothing matched that code/)).toBeVisible({ timeout: 15_000 })
  })
})
