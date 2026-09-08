import { expect, test } from '@playwright/test'

/**
 * The POS is a keyboard instrument. These tests use ONLY keyboard events —
 * a `page.click()` anywhere in the core sale flow is a failure, because anything
 * that forces a reach for the mouse breaks the billing rhythm.
 */

test.describe('Billing / POS', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeFocused()
  })

  test('/ recalls focus to search without leaking the slash', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    // Move focus OUT of the input first: while it is focused, '/' must type
    // normally — a search box you cannot type a slash into is broken.
    await page.keyboard.press('Tab')
    await expect(search).not.toBeFocused()

    await page.keyboard.press('/')
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('')
  })

  test('/ types normally while the search box already has focus', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await expect(search).toBeFocused()
    await page.keyboard.press('/')
    await expect(search).toHaveValue('/')
  })

  test('completes a sale using only the keyboard', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })

    await search.pressSequentially('dolo', { delay: 40 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    // The row lands with a batch already chosen by FEFO — no modal, no click.
    const firstRow = page.locator('[data-line-id]').first()
    await expect(firstRow).toBeVisible()
    await expect(firstRow.locator('.mono').first()).not.toHaveText('—')

    // Focus returned to search, ready for the next scan.
    await expect(search).toBeFocused()

    await search.pressSequentially('pan', { delay: 40 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-line-id]')).toHaveCount(2)

    const total = page.getByText('Total', { exact: true }).locator('..').locator('.num')
    await expect(total).not.toHaveText('0.00')

    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()

    await page.keyboard.press('Control+s')
    await expect(page.getByText(/Saved RX/)).toBeVisible({ timeout: 10_000 })

    // Cart is cleared and focus is back at search for the next customer.
    await expect(page.locator('[data-line-id]')).toHaveCount(0)
    await expect(search).toBeFocused()
  })

  test('the bill foots: taxable + tax + round-off equals the total', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    // Two items so the bill mixes GST rates and the apportionment path is live.
    for (const term of ['dolo', 'shelcal']) {
      await search.pressSequentially(term, { delay: 30 })
      await expect(page.getByRole('option').first()).toBeVisible()
      await page.keyboard.press('Enter')
    }

    const num = async (testid: string) => {
      const el = page.getByTestId(testid)
      if ((await el.count()) === 0) return 0
      const text = await el.locator('.num').last().innerText()
      return Number(text.replace(/[₹,]/g, ''))
    }

    const taxable = await num('total-taxable')
    const cgst = await num('total-cgst')
    const sgst = await num('total-sgst')
    const igst = await num('total-igst')
    const roundOff = await num('total-roundoff')
    const net = Number((await page.getByTestId('total-net').innerText()).replace(/[₹,]/g, ''))

    expect(net).toBeGreaterThan(0)
    // The invariant the whole decimal layer exists to guarantee.
    expect(Math.abs(taxable + cgst + sgst + igst + roundOff - net)).toBeLessThan(0.005)
    expect(Math.abs(roundOff)).toBeLessThanOrEqual(0.5)
    // IGST xor CGST+SGST, never both.
    expect(igst === 0 || cgst + sgst === 0).toBe(true)
  })

  test('Escape steps back exactly one level from payment', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 40 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeHidden()
    // The bill survives: stepping back must never discard the cart.
    await expect(page.locator('[data-line-id]')).toHaveCount(1)
  })

  test('an out-of-stock hit sorts below the divider and never above dispensable stock', async ({ page }) => {
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('a', { delay: 30 })
    await expect(page.getByRole('option').first()).toBeVisible()

    const divider = page.getByText('Not in stock')
    if (await divider.count()) {
      const dividerBox = await divider.boundingBox()
      const firstOption = await page.getByRole('option').first().boundingBox()
      expect(firstOption!.y).toBeLessThan(dividerBox!.y)
    }
  })

  test('fits the 1366x768 POS floor with no horizontal page scroll', async ({ page }) => {
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })
})

test.describe('cart grid layout', () => {
  test('the medicine column never collapses and the row never overflows its pane', async ({ page }) => {
    // Regression: fixed columns plus gaps exceeded the centre pane at 1366px, so
    // minmax(0,1fr) resolved the NAME column to 0px and the row painted over the
    // totals rail. Nothing errored — it was only visible in a screenshot.
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 120 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    const metrics = await page.evaluate(() => {
      const row = document.querySelector('[data-line-id] > div')
      if (!row) return null
      const cols = getComputedStyle(row).gridTemplateColumns.split(' ').map(parseFloat)
      return {
        nameCol: cols[1] ?? 0,
        rowWidth: row.getBoundingClientRect().width,
        paneWidth: row.parentElement?.parentElement?.parentElement?.getBoundingClientRect().width ?? 0,
      }
    })
    expect(metrics).not.toBeNull()
    expect(metrics!.nameCol).toBeGreaterThan(90)
    expect(metrics!.rowWidth).toBeLessThanOrEqual(metrics!.paneWidth + 1)

    // The brand name must actually be legible, not clipped to nothing.
    await expect(page.locator('[data-line-id]').first().getByText(/Dolo/i).first()).toBeVisible()
  })
})

test.describe('shortcut safety', () => {
  test('F2 inside the cart edits a cell instead of discarding the bill', async ({ page }) => {
    // Regression: the cart scope DECLARED cell.edit (F2) but did not implement it,
    // so F2 fell through to the billing scope's "new bill" and reset the cart with
    // no confirmation. A keystroke away from the grid destroyed the sale.
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 120 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-line-id]')).toHaveCount(1)

    await page.keyboard.press('F2')
    // The bill survives and focus lands on the quantity cell.
    await expect(page.locator('[data-line-id]')).toHaveCount(1)
    const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(focusedLabel).toMatch(/^Quantity for/)
  })

  test('an open dialog swallows keys the billing screen would otherwise act on', async ({ page }) => {
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 120 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    await page.keyboard.press('F3')
    await expect(page.getByRole('dialog')).toBeVisible()

    // F2 over the dialog must not reach "new bill" underneath.
    await page.keyboard.press('F2')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('[data-line-id]')).toHaveCount(1)
  })
})

test.describe('shortcuts reach the app from every focus position', () => {
  // Regression: both the search box and the cart cells called preventDefault on
  // EVERY Enter, so Ctrl+Enter was dead wherever focus actually rests. The e2e
  // above only ever pressed it from the search box, which is why it passed.
  for (const where of ['search', 'quantity cell', 'free cell', 'discount cell'] as const) {
    test(`Ctrl+Enter opens payment from the ${where}`, async ({ page }) => {
      await page.goto('/billing')
      const search = page.getByRole('combobox', { name: 'Medicine search' })
      await search.pressSequentially('dolo', { delay: 120 })
      await expect(page.getByRole('option').first()).toBeVisible()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-line-id]')).toHaveCount(1)

      const inputs = page.locator('[data-line-id]').first().locator('input')
      if (where === 'quantity cell') await inputs.nth(0).focus()
      if (where === 'free cell') await inputs.nth(1).focus()
      if (where === 'discount cell') await inputs.nth(2).focus()

      await page.keyboard.press('Control+Enter')
      await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    })
  }

  test('a complete sale writes an invoice, moves stock and clears the cart', async ({ page }) => {
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 120 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    const qty = page.locator('[data-line-id]').first().locator('input').first()
    await qty.fill('12')
    await qty.press('Tab')

    await page.keyboard.press('Control+Enter')
    await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
    await page.keyboard.press('Control+s')

    await expect(page.getByText(/Saved RX\d+-T1-\d{5}/)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-line-id]')).toHaveCount(0)
    await expect(search).toBeFocused()

    // The ledger is append-only truth: a sale must leave rows behind.
    const counts = await page.evaluate(async () => {
      const req = indexedDB.open('rxbill')
      const db: IDBDatabase = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      const count = (store: string, key?: string) =>
        new Promise<number>((res) => {
          const os = db.transaction(store, 'readonly').objectStore(store)
          const rq = key ? os.index('reason').count(key) : os.count()
          rq.onsuccess = () => res(rq.result as number)
        })
      return { invoices: await count('invoices'), saleLedger: await count('ledger', 'SALE') }
    })
    expect(counts.invoices).toBeGreaterThanOrEqual(1)
    expect(counts.saleLedger).toBeGreaterThanOrEqual(1)
  })
})
