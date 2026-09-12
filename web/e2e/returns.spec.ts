import { expect, test } from '@playwright/test'

/**
 * Purchase return vs expiry claim.
 *
 * The assertions are about the SPLIT, not the layout: the two are separate
 * documents under CBIC Circular 72/46/2018 — a debit note reversing the credit
 * a bill gave, and a fresh outward invoice whose settlement arrives later and
 * usually short — and a screen that blurs them books claims as reductions of a
 * supplier's payable.
 */
test.describe('returns to a supplier', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/purchases?tab=returns')
    await expect(page.getByRole('radio', { name: /Return to supplier/ })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('names the two documents and says what each does to the tax', async ({ page }) => {
    await expect(page.getByText(/Reverses the input tax credit/)).toBeVisible()
    await expect(page.getByText(/fresh outward tax invoice/)).toBeVisible()
  })

  test('a debit note must name the bill it reduces; a claim need not', async ({ page }) => {
    // The refusal is stated before the button is pressed, not learned from a toast.
    await expect(page.getByText('A debit note has to name the bill it reduces', { exact: true })).toBeHidden()
    await expect(page.getByText('Choose a supplier', { exact: true })).toBeVisible()

    await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 })
    await expect(page.getByText('A debit note has to name the bill it reduces', { exact: true })).toBeVisible()

    // The claim side drops the requirement AND the control — a strip expiring
    // today was bought years ago and its bill may pre-date the software.
    await page.getByRole('radio', { name: /Issue breakage/ }).click()
    await expect(page.getByRole('combobox', { name: 'Against bill' })).toBeHidden()
    await expect(page.getByText('Nothing selected to send back', { exact: true })).toBeVisible()
  })

  test('posts an expiry claim and holds it open until the credit arrives', async ({ page }) => {
    await page.getByRole('radio', { name: /Issue breakage/ }).click()
    await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: 'Why it is going back' })
      .fill('Expired on the shelf; claiming against the manufacturer')

    // Soonest expiry first, so the top row is the oldest stock in the shop.
    const qty = page.getByRole('textbox', { name: /to send back$/ }).first()
    await qty.fill('1')

    const post = page.getByRole('button', { name: /Post expiry claim/i })
    await expect(post).toBeEnabled({ timeout: 10_000 })
    await post.click()
    await expect(page.getByText(/Expiry claim RX.*posted/)).toBeVisible({ timeout: 15_000 })

    // It lands in the claim book as OUTSTANDING — nothing has come back yet, and
    // that is a different fact from "settled at zero".
    await expect(page.getByRole('button', { name: 'Record their credit' }).first())
      .toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/1 awaiting credit/)).toBeVisible()
  })

  test('a short settlement is recorded as a shortfall, not written off quietly', async ({ page }) => {
    await page.getByRole('radio', { name: /Issue breakage/ }).click()
    await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: 'Why it is going back' }).fill('Breakage in transit, claiming it back')
    await page.getByRole('textbox', { name: /to send back$/ }).first().fill('2')

    const post = page.getByRole('button', { name: /Post expiry claim/i })
    await expect(post).toBeEnabled({ timeout: 10_000 })
    await post.click()
    await expect(page.getByText(/Expiry claim RX.*posted/)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Record their credit' }).first().click()
    await page.getByRole('textbox', { name: /^Credit received against/ }).fill('1')
    await page.getByRole('textbox', { name: /^Their credit note number/ }).fill('CN/2026/8871')
    await page.getByRole('button', { name: 'Record' }).click()

    // The gap is the breakage allowance. It is money the shop lost, and the
    // whole reason claim value and credit received are separate numbers.
    await expect(page.getByText(/short of the claim/)).toBeVisible({ timeout: 15_000 })
    /* The toast fires in `onSuccess`, BEFORE the claim book has refetched, so
       this figure is a beat behind it and needs its own wait. */
    await expect(page.getByText(/1 settled\./)).toBeVisible({ timeout: 15_000 })
  })

  test('a debit note reduces the payable; a claim deliberately does not', async ({ page }) => {
    /* The whole reason these are two document types. Booking a claim as a
       reduction of the supplier's bill understates the payable from the day it
       is raised until the manufacturer's credit turns up — and leaves the
       shortfall, the money actually lost to a breakage allowance, nowhere to
       live. */
    const payable = async (): Promise<number> => {
      await page.goto('/reports?r=SUPPLIER_OUTSTANDING')
      await expect(page.getByRole('grid')).toBeVisible({ timeout: 15_000 })
      const foot = await page.getByRole('grid').getByRole('row').last().innerText()
      /* Strip the Indian digit grouping FIRST. Without it "66,672.00" splits on
         its own comma and the comparison silently runs against 66 — which never
         moves, so the test passed or failed for reasons unrelated to the money. */
      const first = foot.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
      return Number(first?.[0] ?? '0')
    }

    const before = await payable()
    expect(before).toBeGreaterThan(0)

    // A claim: the payable must NOT move.
    await page.goto('/purchases?tab=returns')
    await page.getByRole('radio', { name: /Issue breakage/ }).click()
    await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 })
    await page.getByRole('textbox', { name: 'Why it is going back' })
      .fill('Expired on the shelf, claiming against the manufacturer')
    await page.getByRole('textbox', { name: /to send back$/ }).first().fill('1')
    let post = page.getByRole('button', { name: /Post expiry claim/i })
    await expect(post).toBeEnabled({ timeout: 10_000 })
    await post.click()
    await expect(page.getByText(/Expiry claim RX.*posted/)).toBeVisible({ timeout: 15_000 })

    expect(await payable()).toBe(before)

    // A debit note: the payable must fall.
    await page.goto('/purchases?tab=returns')
    const supplier = page.getByRole('combobox', { name: 'Supplier' })
    const bill = page.getByRole('combobox', { name: 'Against bill' })

    /* Walk to a supplier that HAS a bill on file. Not every seeded supplier
       does, and a debit note cannot be raised without one — which is the rule
       under test two tests up, not a fixture to fight here. */
    /* The whole walk polls, INCLUDING the supplier count.
       Read once straight after a navigation, that count is zero — React has not
       rendered the select yet — so the loop never ran a single iteration and
       reported "no supplier has a bill" without having looked at one. Both the
       list of suppliers and each supplier's bills are queries, and neither has
       landed on the first paint. */
    await expect.poll(
      async () => {
        const count = await supplier.locator('option').count()
        for (let i = 1; i < count; i++) {
          await supplier.selectOption({ index: i })
          if (await bill.locator('option').count() > 1) return true
        }
        return false
      },
      { message: 'no seeded supplier has a purchase bill', timeout: 20_000 },
    ).toBe(true)
    await bill.selectOption({ index: 1 })
    await page.getByRole('textbox', { name: 'Why it is going back' })
      .fill('Wrong strength delivered against the order')
    await page.getByRole('textbox', { name: /to send back$/ }).first().fill('1')
    post = page.getByRole('button', { name: /Post debit note/i })
    await expect(post).toBeEnabled({ timeout: 10_000 })
    await post.click()
    await expect(page.getByText(/Debit note RX.*posted/)).toBeVisible({ timeout: 15_000 })

    expect(await payable()).toBeLessThan(before)
  })
})
