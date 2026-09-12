import { expect, test } from '@playwright/test'

test.describe('Inventory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible()
  })

  test('surfaces the ledger reconciliation, because a silent mismatch is the alarm', async ({ page }) => {
    // batches.qtyOnHand is concurrency truth; the append-only ledger is audit
    // truth. If they disagree, that has to be visible, not buried in a log line.
    await expect(page.getByText(/ledger balanced|discrepanc/i).first()).toBeVisible()
  })

  test('expiry buckets nest, and the page says so', async ({ page }) => {
    // "Within 180 days" contains "within 30". A reader who adds the cards together
    // double-counts, so the nesting is stated rather than left to be inferred.
    await expect(page.getByText(/Within 180 days/)).toBeVisible()
    await expect(page.getByText(/Within 30 days/)).toBeVisible()
    await expect(page.getByText(/nest|already contains/i).first()).toBeVisible()
  })

  test('values stock at cost and at MRP, not just one', async ({ page }) => {
    await expect(page.getByText(/Stock at cost/i)).toBeVisible()
    await expect(page.getByText(/Stock at MRP/i)).toBeVisible()
  })

  test('the batch grid is windowed', async ({ page }) => {
    await expect(page.getByRole('row').first()).toBeVisible()
    const rows = await page.getByRole('row').count()
    expect(rows).toBeGreaterThan(5)
    expect(rows).toBeLessThan(120)
  })

  test('THE VALUATION BASIS IS A CHOICE, and it is in the link', async ({ page }) => {
    // Landed cost and printed MRP differ by the whole margin, so a stock figure
    // quoted without its basis is not an answer. The basis is a view axis like
    // any other here: it lives in the URL, so a number that gets pasted into a
    // message arrives with the basis it was read on.
    await expect(page.getByRole('button', { name: /Stock at cost/ })).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: /Stock at MRP/ }).click()
    await expect(page).toHaveURL(/basis=mrp/)
    await expect(page.getByRole('button', { name: /Stock at MRP/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /Stock at cost/ })).toHaveAttribute('aria-pressed', 'false')
  })

  test('ages stock from the LEDGER, which is not the expiry question', async ({ page }) => {
    await page.getByRole('button', { name: 'Ageing', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Stock ageing' })).toBeVisible({ timeout: 20_000 })

    // A lot with two years to run that nothing has touched since March is dead
    // money, and no expiry report will ever mention it.
    await expect(page.getByText(/Sitting longer than 90 days/i)).toBeVisible({ timeout: 20_000 })

    // The opposite of the expiry board above: these bands are disjoint, so a
    // reader may add them. Saying so is what stops the two boards being read
    // with the same (wrong) rule.
    await expect(page.getByText(/Bands do not overlap/i)).toBeVisible()
    await expect(page.getByText(/Over 180 days/)).toBeVisible()
  })

  test('dead stock is money, valued, with the idle window as a control', async ({ page }) => {
    await page.getByRole('button', { name: 'Dead stock', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Dead stock' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Not moved in 90 days/i)).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: '30d', exact: true }).click()
    await expect(page).toHaveURL(/dd=30/)
    await expect(page.getByText(/Not moved in 30 days/i)).toBeVisible()

    // Dead is not expired, and the screen refuses to blur the two: there is no
    // write-off button here.
    await expect(page.getByText(/Dead is not expired/i)).toBeVisible()
  })

  test('the rack walk is ordered by the building, not by a number', async ({ page }) => {
    await page.getByRole('button', { name: 'Rack walk', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Rack walk' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/racks in use/i)).toBeVisible({ timeout: 20_000 })

    // A-10 must follow A-9, which a plain string sort gets backwards — and a
    // walk read in the wrong order is a walk done twice.
    const racks = await page.getByRole('list', { name: 'Racks' })
      .getByRole('button', { expanded: false }).allInnerTexts()
    const codes = racks.map((t) => (t.split('\n')[0] ?? '').trim()).filter((c) => /^[A-Z]+-\d+$/.test(c))
    expect(codes.length).toBeGreaterThan(3)
    const sorted = [...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    expect(codes).toEqual(sorted)
  })

  test('BULK SELECTION SAYS WHAT IT WILL ACT ON before it acts', async ({ page }) => {
    // A recall names a manufacturer and a date range, never a batch. Pulling
    // that shelf one row at a time is the difference between two minutes and
    // forty — so the grid selects, and the bar states the count and the money.
    const ticks = page.getByRole('checkbox', { name: /^Select .* batch / })
    await ticks.first().check()
    await ticks.nth(2).check()

    const bar = page.getByRole('region', { name: 'Selected batches' })
    await expect(bar).toBeVisible()
    await expect(bar.getByText(/2\s*batches selected/)).toBeVisible()
    await expect(bar.getByRole('button', { name: /Print labels/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /Quarantine or release/ })).toBeEnabled()
  })

  test('the selection is reachable from the keyboard, and Escape unwinds it', async ({ page }) => {
    // The grid is worked with two hands on the keyboard. A selection that can
    // only be made with a mouse is a selection the counter will not use.
    const bar = page.getByRole('region', { name: 'Selected batches' })
    await page.getByRole('grid').focus()
    await page.keyboard.press(' ')
    await expect(bar).toBeVisible()
    await expect(bar.getByText(/1\s*batch selected/)).toBeVisible()

    // Shift extends from the last tick rather than from wherever the highlight
    // has wandered to.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.down('Shift')
    await page.keyboard.press(' ')
    await page.keyboard.up('Shift')
    await expect(bar.getByText(/3\s*batches selected/)).toBeVisible()

    // Escape unwinds the widest claim first: the ticks, not the filters.
    await page.keyboard.press('Escape')
    await expect(bar).toHaveCount(0)
  })

  test('A BULK HOLD POSTS ONE ROW PER BATCH, and never a quantity', async ({ page }) => {
    const ticks = page.getByRole('checkbox', { name: /^Select .* batch / })
    await ticks.first().check()
    await ticks.nth(1).check()

    /* Read straight out of IndexedDB. The assertion that matters is not that a
       toast appeared but that both batches are actually held and that neither
       quantity moved: a quarantine blocks allocation, it does not write stock
       off, and a bulk path that quietly did both would be the worst bug on this
       screen. */
    const held = async () => page.evaluate(async () => {
      const req = indexedDB.open('rxbill')
      const db: IDBDatabase = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
      })
      return new Promise<Array<{ id: number; q: string; held: boolean }>>((ok) => {
        const rq = db.transaction('batches', 'readonly').objectStore('batches').getAll()
        rq.onsuccess = () => ok((rq.result as Array<{ id: number; qtyOnHand: string; isQuarantined: boolean; storeId: number }>)
          .filter((b) => b.storeId === 1)
          .map((b) => ({ id: b.id, q: b.qtyOnHand, held: b.isQuarantined })))
      })
    })

    const before = await held()
    const beforeHeld = before.filter((b) => b.held).length

    await page.getByRole('region', { name: 'Selected batches' })
      .getByRole('button', { name: /Quarantine or release/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Unexplained, nothing moves. The bar is the same as for a single batch: a
    // bulk action needs more justification, not less.
    await expect(page.getByRole('button', { name: /^Quarantine \d+$/ })).toBeDisabled()
    await page.getByLabel('Reason').fill('Recall notice from the distributor dated 04-09')
    const commit = page.getByRole('button', { name: /^Quarantine \d+$/ })
    await expect(commit).toBeEnabled()
    await commit.click()

    await expect(page.getByText(/batches quarantined|batch quarantined/)).toBeVisible({ timeout: 20_000 })

    await expect.poll(async () => (await held()).filter((b) => b.held).length, { timeout: 20_000 })
      .toBe(beforeHeld + 2)

    // Not one unit was written off.
    const after = await held()
    const byId = new Map(after.map((b) => [b.id, b.q]))
    expect(before.every((b) => byId.get(b.id) === b.q)).toBe(true)
  })
})

test.describe('Purchases — goods receipt', () => {
  test('cannot post a receipt before a supplier is chosen', async ({ page }) => {
    await page.goto('/purchases')
    await expect(page.getByRole('heading', { level: 1, name: 'Purchases' })).toBeVisible()
    // The tax split depends on the supplier's state, so pricing without one would
    // be a guess at whether this is CGST+SGST or IGST.
    await expect(page.getByRole('button', { name: /post goods receipt/i })).toBeDisabled()
    await expect(page.getByText(/Unpriced/i)).toBeVisible()
  })

  test('offers a total-match check against the printed bill', async ({ page }) => {
    await page.goto('/purchases')
    // The single control that catches a mistyped rate before it becomes landed cost.
    await expect(page.getByText(/total on the paper bill/i)).toBeVisible()
  })
})

test.describe('Suppliers', () => {
  test('leads with what is owed and how old it is', async ({ page }) => {
    await page.goto('/suppliers')
    await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible()
    await expect(page.getByText(/total payable/i)).toBeVisible()
    // The drug licence is legally required on every purchase bill.
    await expect(page.getByText(/drug licence/i).first()).toBeVisible()
  })

  test('never claims "nothing due" beside a non-zero balance', async ({ page }) => {
    await page.goto('/suppliers')
    // Rows are buttons, not grid cells — each one announces as an activatable
    // control rather than as a div impersonating a table row. `data-supplier-row`
    // is the stable hook the component provides for exactly this.
    await expect(page.locator('[data-supplier-row]').first()).toBeVisible()
    const contradiction = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-supplier-row]')]
      return rows.some((r) => {
        const t = r.textContent ?? ''
        if (!t.includes('Nothing due')) return false
        // The trailing outstanding figure on the row.
        const m = t.match(/([\d,]+\.\d{2})\s*$/)
        return m ? Number(m[1]!.replace(/,/g, '')) > 0 : false
      })
    })
    expect(contradiction, 'a row says "Nothing due" while carrying a balance').toBe(false)
  })
})
