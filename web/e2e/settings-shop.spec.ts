import { expect, test } from '@playwright/test'

/**
 * The three panels this wave added, and the header that routes to them.
 *
 * What is asserted here is the part that would cost a shop something: a refusal
 * that has to fire (a GSTIN filed against the wrong state, two branches issuing
 * one invoice series, a file that is not a backup), and the fact that a copy of
 * the database can actually leave the machine.
 */

const nav = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Settings sections' })

test.describe('Pharmacy, now editable', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Pharmacy', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('is a form, not a read-only card', async ({ page }) => {
    await expect(page.getByLabel('Pharmacy name')).toBeEditable()
    await expect(page.getByLabel('GSTIN')).toBeEditable()
    await expect(page.getByRole('textbox', { name: 'Drug licence 1' })).toBeEditable()
  })

  test('saves a change to what prints at the head of a bill', async ({ page }) => {
    await page.getByLabel('Phone').fill('+91 98220 40000')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/everything is saved/i)).toBeVisible()
  })

  test('REFUSES a state code the GSTIN disagrees with, and says what breaks', async ({ page }) => {
    // Both fields look correct on their own. The bill would be taxed against one
    // state and filed against the other, and no screen would look wrong.
    await page.getByLabel('State code').fill('29')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/taxed against one state and filed against the other/))
      .toBeVisible({ timeout: 10_000 })
  })

  test('refuses to leave the shop without a drug licence', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Drug licence 1' }).fill('')
    await page.getByRole('textbox', { name: 'Drug licence 2' }).fill('')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/without a drug licence number is not a compliant bill/))
      .toBeVisible({ timeout: 10_000 })
  })

  test('shows the bill head at the real roll width', async ({ page }) => {
    // An address that reads perfectly in a form field can be three wrapped
    // fragments on 42 columns of paper.
    await expect(page.getByText('How this prints')).toBeVisible()
    await expect(page.getByText(/at its real width of 42 characters/)).toBeVisible()
  })
})

test.describe('the setup header', () => {
  test('counts what is still missing and routes to the panel that fixes it', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

    // A fresh machine has taken no backup and has no printer set up. Both are
    // per-device, so both are outstanding on a seeded demo shop.
    const strip = page.getByLabel('Outstanding setup')
    await expect(strip).toBeVisible({ timeout: 15_000 })
    await expect(strip.getByRole('button', { name: 'Recent backup' })).toBeVisible()

    await strip.getByRole('button', { name: 'Recent backup' }).click()
    await expect(page.getByRole('heading', { name: 'Data & backup', level: 2 })).toBeVisible()
  })
})

test.describe('Branches', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await nav(page).getByRole('button', { name: 'Branches' }).click()
    await expect(page.getByRole('heading', { name: 'Branches', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('lists the chain and marks the branch this till bills for', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Sanjeevani Medical Store' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Kothrud/ })).toBeVisible()
    await expect(page.getByText('Billing here')).toHaveCount(1)
  })

  test('says plainly what a new branch inherits and what it does not', async ({ page }) => {
    // The support call every chain makes once: the branch opens with the whole
    // catalogue and reports zero stock.
    await expect(page.getByText('Stock and batches')).toBeVisible()
    await expect(page.getByText('Medicine master')).toBeVisible()
  })

  test('REFUSES a second branch on an invoice prefix already in use', async ({ page }) => {
    // Two branches on one prefix issue the same invoice number twice, in two
    // shops, and nothing downstream can tell the bills apart.
    await page.getByRole('button', { name: 'Open a branch' }).click()
    await page.getByLabel('New branch name').fill('Sanjeevani — Baner')
    await page.getByLabel('New branch address').fill('Shop 2, Baner Road')
    await page.getByLabel('New branch city').fill('Baner')
    await page.getByLabel('New branch phone').fill('+91 98220 42200')
    await page.getByLabel('New branch drug licences').fill('MH-PN7-220B')
    await page.getByLabel('New branch invoice prefix').fill('RX')

    await page.getByRole('button', { name: 'Open this branch' }).click()
    await expect(page.getByText(/already issues the RX series/)).toBeVisible()
  })

  test('opens a branch that is properly its own shop', async ({ page }) => {
    await page.getByRole('button', { name: 'Open a branch' }).click()
    await page.getByLabel('New branch name').fill('Sanjeevani — Baner')
    await page.getByLabel('New branch address').fill('Shop 2, Baner Road')
    await page.getByLabel('New branch city').fill('Baner')
    await page.getByLabel('New branch phone').fill('+91 98220 42200')
    await page.getByLabel('New branch drug licences').fill('MH-PN7-220B')
    await page.getByLabel('New branch invoice prefix').fill('BN')

    await page.getByRole('button', { name: 'Open this branch' }).click()
    await expect(page.getByRole('heading', { name: 'Sanjeevani — Baner' }))
      .toBeVisible({ timeout: 10_000 })

    // And the top-bar branch chip can reach it, which is the whole point of
    // opening one from here.
    await expect(page.getByText('BN/…')).toBeVisible()
  })

  test('edits a branch that is not the one this till is billing for', async ({ page }) => {
    await page.getByRole('button', { name: /Edit/ }).nth(1).click()
    const phone = page.getByLabel(/Phone for Sanjeevani Medical — Kothrud/)
    await phone.fill('+91 98220 41199')
    await page.getByRole('button', { name: /Save Sanjeevani Medical — Kothrud/ }).click()
    await expect(page.getByText(/Sanjeevani Medical — Kothrud saved/)).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('Data & backup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings')
    await nav(page).getByRole('button', { name: 'Data & backup' }).click()
    await expect(page.getByRole('heading', { name: 'Data & backup', level: 2 }))
      .toBeVisible({ timeout: 15_000 })
  })

  test('itemises what is stored rather than asserting that it is local', async ({ page }) => {
    await expect(page.getByText('Names, phone numbers and khata balances')).toBeVisible()
    await expect(page.getByText('Every bill, including cancelled ones')).toBeVisible()
    await expect(page.getByText(/machine's own lock screen is/)).toBeVisible()
  })

  test('writes a real backup file, named for the shop and the moment', async ({ page }) => {
    const started = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Back up now' }).click()
    const file = await started
    expect(file.suggestedFilename()).toMatch(/^rxbill-backup-sanjeevani-medical-store-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
  })

  test('taking a backup clears it off the header, without a reload', async ({ page }) => {
    /* The fact lives in localStorage, which nothing re-renders on. Without a
       subscription a pharmacist takes a backup, watches the file download, and
       is still told they have never taken one. */
    const strip = page.getByLabel('Outstanding setup')
    await expect(strip.getByRole('button', { name: 'Recent backup' })).toBeVisible()

    const started = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Back up now' }).click()
    await started

    await expect(strip.getByRole('button', { name: 'Recent backup' })).toHaveCount(0)
    await expect(page.getByText('no copy has left this machine')).toHaveCount(0)
  })

  test('refuses a file that is not a backup, in words a pharmacist can act on', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'accounts.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"ledger":[]}'),
    })
    await expect(page.getByText(/not an RxBill backup/)).toBeVisible()
  })

  test('refuses a backup written by a newer build rather than restoring part of it', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'newer.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'rxbill.backup', version: 99, tables: { stores: [] },
      })),
    })
    await expect(page.getByText(/newer version of RxBill/)).toBeVisible()
  })

  test('shows what a restore would replace before it replaces it', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'small.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'rxbill.backup',
        version: 1,
        createdAt: '2026-09-01T10:00:00.000Z',
        takenFrom: { storeId: 1, storeName: 'Sanjeevani Medical Store' },
        tables: { stores: [{ id: 1, name: 'Sanjeevani Medical Store' }] },
      })),
    })

    // A restore is a replacement. The table that is about to lose rows is the
    // one a person most needs to see, and the button stays inert until the word
    // is typed.
    await expect(page.getByText(/This machine currently holds more in/)).toBeVisible()
    const go = page.getByRole('button', { name: 'Replace everything' })
    await expect(go).toBeDisabled()
    await page.getByLabel('Type RESTORE to confirm').fill('RESTORE')
    await expect(go).toBeEnabled()
  })
})
