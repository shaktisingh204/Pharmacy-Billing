import { expect, test } from '@playwright/test'

/**
 * Moving stock between branches.
 *
 * The assertions are about the two things that make this correct rather than
 * merely present: the DOCUMENT is decided by GST (one GSTIN means one legal
 * person and no supply), and BOTH SIDES move — stock that leaves one shop and
 * arrives nowhere is the failure nothing else in the app would notice.
 */

const branch = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /— change branch$/ })

test.describe('branch transfers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('heading', { level: 1, name: 'Inventory' }))
      .toBeVisible({ timeout: 20_000 })
  })

  test('says it is a CHALLAN and why, before anything moves', async ({ page }) => {
    await page.getByRole('button', { name: 'Send to branch' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.getByLabel('To branch').selectOption({ index: 1 })
    await page.getByLabel('Why it is moving').fill('Kothrud is short before the weekend')
    await page.getByRole('textbox', { name: /to send$/ }).first().fill('2')

    // Both branches share a GSTIN, so this is one legal person moving its own
    // stock — not a supply, and no tax.
    await expect(page.getByText('Delivery challan')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/one legal person/)).toBeVisible()
    await expect(page.getByText(/no tax is charged/)).toBeVisible()
  })

  test('refuses to move stock out of a building unexplained', async ({ page }) => {
    await page.getByRole('button', { name: 'Send to branch' }).click()
    await page.getByLabel('To branch').selectOption({ index: 1 })
    await page.getByRole('textbox', { name: /to send$/ }).first().fill('2')
    await expect(page.getByText('Say why the stock is moving')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  })

  test('BOTH SIDES MOVE — it leaves one shelf and arrives on the other', async ({ page }) => {
    await page.getByRole('button', { name: 'Send to branch' }).click()
    await page.getByLabel('To branch').selectOption({ index: 1 })
    await page.getByLabel('Why it is moving').fill('Kothrud is short before the weekend')

    const row = page.getByRole('row')
      .filter({ has: page.getByRole('textbox', { name: /to send$/ }) }).first()
    const batchNo = (await row.getByRole('cell').nth(1).innerText()).trim()
    await row.getByRole('textbox', { name: /to send$/ }).fill('2')

    /* Read straight out of IndexedDB, on BOTH sides.
       Verifying through two inventory searches and a branch switch tests the
       search box as much as the transfer; this asserts the one invariant that
       matters — stock that leaves one shop arrives at the other, as the SAME
       batch. A decrement without its matching increment is stock that has gone
       nowhere, and nothing else in the app would ever notice. */
    const held = async () => page.evaluate(async (no: string) => {
      const req = indexedDB.open('rxbill')
      const db: IDBDatabase = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
      })
      return new Promise<Record<number, number>>((ok) => {
        const rq = db.transaction('batches', 'readonly').objectStore('batches').getAll()
        rq.onsuccess = () => {
          const out: Record<number, number> = {}
          for (const b of rq.result as Array<{ storeId: number; batchNo: string; qtyOnHand: string }>) {
            if (b.batchNo !== no) continue
            out[b.storeId] = (out[b.storeId] ?? 0) + Number(b.qtyOnHand)
          }
          ok(out)
        }
      })
    }, batchNo)

    const before = await held()
    expect(before[1], 'the head shop holds this batch').toBeGreaterThan(2)

    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(/sent to/)).toBeVisible({ timeout: 20_000 })

    await expect.poll(async () => (await held())[2] ?? 0, { timeout: 20_000 }).toBe(2)
    const after = await held()
    expect(after[1]).toBe((before[1] ?? 0) - 2)
    // Nothing was created or lost in the move: the chain holds what it held.
    expect((after[1] ?? 0) + (after[2] ?? 0)).toBe(before[1] ?? 0)
  })

  test('the RECEIVING branch can see where its stock came from', async ({ page }) => {
    // Both directions on one register. Without the incoming side a receiving
    // shop can only explain its stock one batch's movement history at a time.
    await page.getByRole('button', { name: 'Send to branch' }).click()
    await page.getByLabel('To branch').selectOption({ index: 1 })
    await page.getByLabel('Why it is moving').fill('Kothrud is short before the weekend')
    await page.getByRole('textbox', { name: /to send$/ }).first().fill('2')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(/sent to/)).toBeVisible({ timeout: 20_000 })

    // Outgoing, from the shop that sent it.
    const register = page.getByRole('list', { name: 'Branch transfers' })
    await expect(register.getByText(/^TRF/).first()).toBeVisible({ timeout: 20_000 })
    await expect(register.getByText(/to Sanjeevani Medical — Kothrud/)).toBeVisible()
    await expect(register.getByText('Delivery challan').first()).toBeVisible()

    // Incoming, from the shop that received it.
    await page.getByRole('button', { name: /— change branch$/ }).click()
    await page.getByRole('list', { name: 'Branches' }).getByRole('button', { name: /Kothrud/ })
      .click()
    await expect(page.getByText(/Now billing for/)).toBeVisible({ timeout: 20_000 })
    await page.goto('/inventory')
    await expect(register.getByText(/from Sanjeevani Medical Store/))
      .toBeVisible({ timeout: 20_000 })
  })
})
