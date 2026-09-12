import { expect, test } from '@playwright/test'

/** The restructured POS: customer on the left, prescriber and medicines in the
 *  middle, a compact bill on the right. */
test.describe('Billing — customer, prescriber, substitutes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeVisible()
  })

  test('creates a customer inline and shows the allergy strip', async ({ page }) => {
    await page.getByLabel('Find customer').fill('9812345678')
    await page.getByRole('button', { name: /create/i }).first().click()

    // Inline, not a modal: the counter is mid-bill and a modal covers the cart.
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByLabel(/^name/i).first().fill('Anita Rane')
    await page.getByLabel(/phone/i).first().fill('98123')
    await page.getByRole('button', { name: /save & attach/i }).click()
    // A short phone is rejected: the phone IS the identity at an Indian counter,
    // and the message names the shortfall rather than just saying "invalid".
    await expect(page.getByText(/a phone number needs 10/i)).toBeVisible()

    await page.getByLabel(/phone/i).first().fill('9812345678')
    const allergy = page.getByLabel(/allerg/i).first()
    await allergy.fill('Penicillin')
    await allergy.press('Enter')
    await page.getByRole('button', { name: /save & attach/i }).click()

    // The name lands in the panel AND the confirmation toast, so scope to the first.
    await expect(page.getByText('Anita Rane').first()).toBeVisible()
    // A dispensing safety control: the allergen is spelled out, never colour alone.
    await expect(page.getByText(/allergic to/i)).toBeVisible()
    await expect(page.getByText('Penicillin').first()).toBeVisible()
  })

  test('Alt+O opens the prescriber picker and records the doctor', async ({ page }) => {
    await page.keyboard.press('Alt+o')
    await expect(page.getByText(/Dr\./).first()).toBeVisible()
    const first = page.getByText(/^Dr\. /).first()
    const name = (await first.innerText()).trim()
    await first.click()
    await expect(page.getByText(name).first()).toBeVisible()
  })

  test('F7 offers in-stock alternatives that share the composition', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo 650', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-line-id]')).toHaveCount(1)

    await page.keyboard.press('F7')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Substitution is a SALT match, so the composition must be on screen.
    await expect(dialog.getByText(/paracetamol/i).first()).toBeVisible()
    await page.keyboard.press('Escape')
    // Escape steps back exactly one level: the bill survives.
    await expect(page.locator('[data-line-id]')).toHaveCount(1)
  })

  test('the compact bill keeps the total and Pay above the fold', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    for (const term of ['dolo', 'pan 40', 'zincovit', 'shelcal', 'taxim-o']) {
      await search.pressSequentially(term, { delay: 60 })
      await expect(page.getByRole('option').first()).toBeVisible()
      await page.keyboard.press('Enter')
    }
    const pay = page.getByRole('button', { name: /^Pay/ })
    await expect(pay).toBeInViewport()

    const box = await pay.boundingBox()
    const vp = page.viewportSize()
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp!.height)
    // Round off is always shown, even at zero — an unexplained rupee is the most
    // common counter dispute there is.
    await expect(page.getByText('Round off')).toBeVisible()
  })

  test('the bill discount input refuses an impossible percentage', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    const disc = page.getByLabel(/bill discount/i).first()
    await disc.fill('150')
    await disc.blur()
    expect(Number(await disc.inputValue())).toBeLessThanOrEqual(100)
  })
})

test.describe('bill safety', () => {
  test('Pay is refused for a bill the server would reject', async ({ page }) => {
    // Regression: Pay was gated only on quoteError, so a blocking warning walked
    // the operator through tendering cash before postSale refused the bill —
    // money in the drawer and nothing to hand over.
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /^Pay/ })).toBeEnabled()
  })

  test('F4 hits the line discount in the grid and the bill discount outside it', async ({ page }) => {
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    // Focus rests in search: F4 is the BILL discount. (That input is named by a
    // <label for>, not an aria-label, so identify it by id.)
    await page.keyboard.press('F4')
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).toBe('bill-discount')

    // Focus inside a cart row: the same key is the LINE discount.
    await page.locator('[data-line-id]').first().locator('input').first().focus()
    await page.keyboard.press('F4')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''))
      .toMatch(/discount for/i)
  })
})

/** Total khata owed across the whole book, read straight out of IndexedDB. */
async function owed(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const req = indexedDB.open('rxbill')
    const db: IDBDatabase = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
    })
    return new Promise<number>((res) => {
      const rq = db.transaction('customers', 'readonly').objectStore('customers').getAll()
      rq.onsuccess = () =>
        res((rq.result as Array<{ outstanding: string }>)
          .reduce((sum, c) => sum + Number(c.outstanding), 0))
    })
  })
}

test.describe('khata', () => {
  test('a credit sale increases what the customer owes', async ({ page }) => {
    // Regression: db.customers was written only by the receipt path, so
    // `outstanding` could only ever go DOWN. A shop could sell on credit all week
    // and the balance would sit at zero, then one receipt would drive it negative.
    await page.goto('/customers')
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible()

    const owedBefore = await owed(page)

    await page.goto('/billing')
    await page.getByLabel('Find customer').fill('Ramesh')
    await page.getByText('Ramesh Kulkarni').first().click()

    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    await page.getByRole('button', { name: /Khata|Credit/ }).click()
    await page.getByRole('button', { name: /save & print/i }).click()
    await expect(page.getByText(/Saved RX/)).toBeVisible({ timeout: 15_000 })

    const owedAfter = await owed(page)

    expect(owedAfter).toBeGreaterThan(owedBefore)
  })

  test('cancelling a khata bill gives the money back', async ({ page }) => {
    // The mirror of the test above, and the reason it has to exist: the moment
    // postSale started RAISING the balance, a void that did not lower it began
    // billing the customer for a document that no longer exists — and because
    // receivableOf skips a VOIDED bill, the balance would not even age. It would
    // surface as "carried", the note that means "brought in from your previous
    // software", pointing at nothing.
    await page.goto('/billing')
    await page.getByLabel('Find customer').fill('Ramesh')
    await page.getByText('Ramesh Kulkarni').first().click()

    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 90 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    await page.getByRole('button', { name: /Khata|Credit/ }).click()
    await page.getByRole('button', { name: /save & print/i }).click()
    const saved = page.getByText(/Saved RX/)
    await expect(saved).toBeVisible({ timeout: 15_000 })
    /* The bill has to be found by its OWN number. The register is seeded with
       months of history and sorts newest-first by clock time, so a bill raised
       at 3pm lands below the seeded evening trade — `.first()` on a customer
       name picks some other bill of theirs, and the test then voids the wrong
       document and still passes. */
    const invoiceNo = (await saved.innerText()).match(/RX[\w-]+/)?.[0] ?? ''
    expect(invoiceNo).toMatch(/^RX/)

    const owedWithBill = await owed(page)

    await page.goto('/sales')
    await page.getByLabel('Find a bill').fill(invoiceNo)
    await page.getByRole('row').filter({ hasText: invoiceNo }).first().click()
    await page.getByRole('button', { name: 'Void' }).click()
    await page.getByLabel('Why is it being cancelled')
      .fill('Billed to the wrong customer; re-raised as a fresh bill')
    await page.getByRole('button', { name: 'Cancel this bill' }).click()
    await expect(page.getByText('Voided').first()).toBeVisible({ timeout: 15_000 })

    expect(await owed(page)).toBeLessThan(owedWithBill)
  })
})
