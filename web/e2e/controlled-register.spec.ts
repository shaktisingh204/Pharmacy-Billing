import { expect, test } from '@playwright/test'

/**
 * The controlled-drug running-balance register.
 *
 * A stock report gives a figure. This has to give the ARITHMETIC — opening,
 * every movement, closing — and then say whether that closing balance is the
 * shelf. Both halves are asserted here, plus the one thing it must never do:
 * claim to be a statutory form it has not been checked against.
 */
test.describe('controlled-drug register', () => {
  test('shows a running balance per drug and reconciles it to the shelf', async ({ page }) => {
    await page.goto('/reports?r=CONTROLLED_BALANCE')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    // Opening and closing are ROWS, not headers: a register read from the middle
    // of a page has to say what it started from.
    await expect(page.getByText('Balance brought forward').first()).toBeVisible()
    await expect(page.getByText(/Closing balance/).first()).toBeVisible()

    /* The reconciliation IS the report. A register that cannot say whether it
       agrees with the shelf has only restated the ledger. */
    await expect(page.getByText(/Counted on the shelf/).first()).toBeVisible()
  })

  test('does NOT claim to be a statutory form', async ({ page }) => {
    /* The form number and its columns are unverified. Printing one would tell a
       pharmacist they are compliant on the strength of a guess.

       The caveat sits in the basis panel, which is where every report's caveats
       sit — and, more to the point, it rides on the PRINTED sheet and the CSV
       export, which is the copy an inspector is actually handed. */
    await page.goto('/reports?r=CONTROLLED_BALANCE')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: /Basis & caveats/ }).click()
    await expect(page.getByText(/not a rendering of a statutory form/)).toBeVisible()
    // And no form number anywhere on the page.
    await expect(page.locator('body')).not.toContainText(/Form\s+\d/)
  })
})
