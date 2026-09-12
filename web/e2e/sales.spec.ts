import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * The sale register's analytics header and its two registers.
 *
 * The assertions are about what the screen MEANS, not where it puts things: a
 * figure is comparable only against a stated period, a withheld cash figure has
 * to stay withheld, and a credit note is a document with a register of its own.
 */

test.describe('the analytics header', () => {
  test('states the period it is comparing against, and compares every figure', async ({ page }) => {
    /* `an=1` opens the band explicitly. It is a URL axis because a 1366x640
       counter panel opens collapsed by default — it cannot spend 200px on a
       header and still show a screenful of bills — and the test has to say
       which state it is asserting rather than depend on the viewport. */
    await page.goto('/sales?r=week&an=1')
    await expect(page.getByRole('heading', { level: 1, name: 'Sales' })).toBeVisible()

    // A number with no basis is not information. The band says which period it
    // is holding this one against, in words, before any percentage appears.
    await expect(page.getByText(/against the same days last week/i)).toBeVisible({ timeout: 15_000 })

    const takings = page.getByTestId('net-sales')
    await expect(takings).toBeVisible()
    await expect(takings).toContainText('₹')

    // Every card carries its own comparison, not just the hero.
    await expect(page.getByRole('heading', { name: 'Tender' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Trade by hour' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Who was billing' })).toBeVisible()
  })

  test('collapses to one line, and the URL remembers', async ({ page }) => {
    await page.goto('/sales?r=week&an=1')
    await expect(page.getByRole('heading', { name: 'Tender' })).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /hide analytics/i }).click()
    await expect(page.getByRole('heading', { name: 'Tender' })).toBeHidden()
    // Collapsed is not blank: the takings and the change against last week stay.
    await expect(page.getByText(/against the same days last week/i)).toBeVisible()
    expect(page.url()).toContain('an=0')

    // The view lives in the URL, so a reload lands on the same screen.
    await page.reload()
    await expect(page.getByRole('button', { name: /show analytics/i })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Tender' })).toBeHidden()
  })

  test('withholds today’s cash until the drawer has been counted', async ({ page }) => {
    // The blind count is only blind if the answer is not on the screen three
    // inches above the button that asks for it.
    await page.goto('/sales?r=today&an=1')
    await expect(page.getByRole('heading', { name: 'Tender' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('at close').first()).toBeVisible()
  })

  test('names who was on the counter and what they averaged', async ({ page }) => {
    await page.goto('/sales?r=month&an=1')
    await expect(page.getByRole('heading', { name: 'Who was billing' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Counter 1').first()).toBeVisible()
    await expect(page.getByText(/avg ₹/).first()).toBeVisible()
  })
})

test.describe('the export', () => {
  test('writes a file that carries its own period, filters and control totals', async ({ page }) => {
    await page.goto('/sales?r=today')
    await expect(page.getByRole('grid', { name: 'Invoice register' })).toBeVisible({ timeout: 15_000 })

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export csv/i }).click(),
    ])
    // The RESELLER's product name heads a file their customer forwards to an
    // accountant, and the period is in the name so two exports never collide.
    expect(download.suggestedFilename()).toMatch(/^rxbill-sale-register-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/)

    const file = await download.path()
    const text = readFileSync(file, 'utf8')
    // The BOM is not optional: without it Excel mangles every ₹ in the headers.
    expect(text.startsWith('﻿')).toBe(true)
    expect(text).toContain('Sale register')
    expect(text).toContain('"Period"')
    expect(text).toContain('Control total')
    expect(text).toContain('Reconciliation')
  })

  test('says in the file when a filter narrowed it', async ({ page }) => {
    await page.goto('/sales?r=month&mode=UPI')
    await expect(page.getByRole('grid', { name: 'Invoice register' })).toBeVisible({ timeout: 15_000 })

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export csv/i }).click(),
    ])
    const text = readFileSync(await download.path(), 'utf8')
    expect(text).toContain('upi bills only')
    // A filtered register is a subset by design, so the reconciliation that
    // could never balance is withheld rather than printed as a failure.
    expect(text).not.toContain('Reconciliation')
  })
})

test.describe('the returns register', () => {
  test('is a register of its own, alongside the bills', async ({ page }) => {
    await page.goto('/sales?r=month')
    await expect(page.getByRole('grid', { name: 'Invoice register' })).toBeVisible({ timeout: 15_000 })

    const returns = page.getByRole('tab', { name: /returns/i })
    await returns.click()
    await expect(returns).toHaveAttribute('aria-selected', 'true')
    expect(page.url()).toContain('tab=returns')
    // A different register, with its own columns — not the bills filtered down.
    await expect(page.getByText('Credit note', { exact: true })).toBeVisible()
    await expect(page.getByText('Against bill', { exact: true })).toBeVisible()
    await expect(page.getByRole('grid', { name: 'Invoice register' })).toBeHidden()
  })

  test('carries a posted credit note, and opens the bill it reverses', async ({ page }) => {
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    await page.getByRole('button', { name: /save & print/i }).click()
    const saved = page.getByText(/Saved RX/)
    await expect(saved).toBeVisible({ timeout: 15_000 })
    /* The bill has to be found by its OWN number: the register is seeded with
       months of history and a bill raised now lands among the day's trade. */
    const invoiceNo = (await saved.innerText()).match(/RX[\w-]+/)?.[0] ?? ''
    expect(invoiceNo).toMatch(/^RX/)

    await page.goto('/sales')
    await page.getByLabel('Find a bill').fill(invoiceNo)
    await page.getByRole('row').filter({ hasText: invoiceNo }).first().click()
    await page.getByRole('button', { name: 'Return' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').first().fill('1')
    await dialog.getByRole('textbox', { name: /why/i }).fill('Customer brought back an unopened strip')
    await dialog.getByRole('button', { name: /post|credit note/i }).last().click()
    await expect(page.getByText(/Credit note RX/)).toBeVisible({ timeout: 15_000 })

    await page.goto('/sales?tab=returns')
    const grid = page.getByRole('grid', { name: 'Credit note register' })
    await expect(grid).toBeVisible({ timeout: 15_000 })
    // The note names the bill it reverses. That link is the whole point of the
    // document, and it has to be readable without opening anything.
    const noteRow = grid.getByRole('row').filter({ hasText: invoiceNo }).first()
    await expect(noteRow).toBeVisible()
    // Where the goods went is a word and an icon, never a colour alone.
    await expect(noteRow.getByText('Restocked')).toBeVisible()

    // Opening a credit note opens the BILL: a reversal only means something
    // beside the sale it corrects.
    await noteRow.click()
    await expect(page.getByRole('complementary', { name: `Invoice ${invoiceNo}` })).toBeVisible()
  })
})
