import { expect, test } from '@playwright/test'

/**
 * The importer.
 *
 * The last test is the feature: an import that has to be resolved by hand the
 * first time must resolve itself the second. Every incumbent re-asks, which is
 * why a migration week is spent re-keying, which is why shops switch back.
 */

/* A distributor's export, complete with the letterhead they put on top, a
   quoted name carrying a comma, and a product that does not exist in our
   catalogue at all.
   The MRP on the Dolo line is one the 1x15 pack has actually been received at —
   "DOLO 650 TAB" names four pack sizes in this catalogue and only that MRP says
   which, which is exactly the disambiguation being exercised. */
const BILL = [
  'SANJIVANI PHARMA DISTRIBUTORS',
  'GSTIN: 27AACCS4471M1ZB',
  '',
  'PARTICULARS,B.NO,EXP DT,QNTY,FREE,M.R.P,RATE,DIS%,GST%,HSN',
  'DOLO 650 TAB,IMPB1,11/27,10,1,29.64,21.50,5,12,30049099',
  '"VITAMIN B1, B6, B12",IMPB2,12/27,5,0,120.00,88.00,0,12,30049099',
].join('\n')

async function openImport(page: import('@playwright/test').Page) {
  await page.goto('/purchases?tab=import')
  await expect(page.getByRole('combobox', { name: 'Supplier for the import' }))
    .toBeVisible({ timeout: 15_000 })
  await page.getByRole('combobox', { name: 'Supplier for the import' }).selectOption({ index: 1 })
  await page.getByRole('textbox', { name: 'Their bill number' }).fill('SPD/4471')
}

test.describe('importing a distributor bill', () => {
  test('reads past the letterhead and guesses the columns', async ({ page }) => {
    await openImport(page)
    await page.getByRole('textbox', { name: 'Paste the supplier bill' }).fill(BILL)

    // Straight to the column stage, with the guesses already made.
    await expect(page.getByRole('combobox', { name: 'Product name' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'MRP per pack' })).toHaveValue('5')
    await expect(page.getByRole('combobox', { name: 'Rate per pack' })).toHaveValue('6')
    // The sample value under each label is what catches a swapped mapping.
    await expect(page.getByText('29.64').first()).toBeVisible()
  })

  test('will not post while one line is still undecided', async ({ page }) => {
    await openImport(page)
    await page.getByRole('textbox', { name: 'Paste the supplier bill' }).fill(BILL)
    await page.getByRole('button', { name: /Match items/ }).click()

    // Dolo's pack is settled by its MRP; the vitamin is not in the catalogue.
    await expect(page.getByText(/1 to decide/)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /^Import \d+ lines?$/ })).toBeDisabled()
  })

  test('a skipped line is excluded out loud, not dropped silently', async ({ page }) => {
    await openImport(page)
    await page.getByRole('textbox', { name: 'Paste the supplier bill' }).fill(BILL)
    await page.getByRole('button', { name: /Match items/ }).click()
    await expect(page.getByText(/1 to decide/)).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /^Skip VITAMIN/ }).click()
    await expect(page.getByText(/1 skipped/)).toBeVisible()
    await expect(page.getByRole('button', { name: /^Import 1 line$/ })).toBeEnabled()
  })

  test('THE SECOND IMPORT RESOLVES ITSELF — the reason this feature exists', async ({ page }) => {
    await openImport(page)
    await page.getByRole('textbox', { name: 'Paste the supplier bill' }).fill(BILL)
    await page.getByRole('button', { name: /Match items/ }).click()
    await expect(page.getByText(/1 to decide/)).toBeVisible({ timeout: 10_000 })

    // Resolve the unknown line by hand, exactly once.
    /* A search box pre-filled with the supplier's own name, then a result. The
       operator types what they know; nothing is a dropdown of four hundred. */
    const search = page.getByRole('textbox', { name: /^Match VITAMIN/ })
    await search.fill('Becosules')
    await page.getByRole('button', { name: /^Becosules/ }).first().click()
    await expect(page.getByText(/this name will be remembered/)).toBeVisible()

    await page.getByRole('button', { name: /^Import 2 lines$/ }).click()
    await expect(page.getByText(/imported/)).toBeVisible({ timeout: 20_000 })

    // The same bill again. Nothing to decide, and the header says so.
    await openImport(page)
    await expect(page.getByText(/names remembered for this supplier/))
      .toBeVisible({ timeout: 10_000 })
    await page.getByRole('textbox', { name: 'Paste the supplier bill' }).fill(BILL)
    await page.getByRole('button', { name: /Match items/ }).click()

    await expect(page.getByText('remembered').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/to decide/)).toBeHidden()
    await expect(page.getByRole('button', { name: /^Import 2 lines$/ })).toBeEnabled()
  })
})
