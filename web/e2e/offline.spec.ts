import { expect, test } from '@playwright/test'

/**
 * Billing through an outage.
 *
 * This is the product's central claim — "a pharmacy counter must keep billing
 * through an internet outage" is written into the database module's own comment —
 * and until now nothing verified it. A claim like that is not the sort of thing
 * to discover is false on the afternoon the shop wifi dies with eight people in
 * the queue.
 *
 * WHAT THIS COVERS AND WHAT IT CANNOT. The context is put genuinely offline, so
 * every request the page makes fails, and a sale still has to complete end to
 * end with a gapless invoice number. What it does NOT cover is a COLD BOOT with
 * no network, which needs the service worker — and the worker deliberately does
 * not register against the dev server this suite runs on (Vite's HMR client and
 * a worker that intercepts navigations fight each other). That half is held by
 * the guardrail that checks the worker's cache manifest covers every built
 * asset, and it is stated here rather than left as a silent gap.
 */

async function completeSale(page: import('@playwright/test').Page, term: string) {
  const search = page.getByRole('combobox', { name: 'Medicine search' })
  await expect(search).toBeFocused()
  await search.pressSequentially(term, { delay: 40 })
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-line-id]')).toHaveCount(1)

  await page.keyboard.press('Control+Enter')
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible()
  await page.keyboard.press('Control+s')

  const toast = page.getByText(/Saved RX/)
  await expect(toast).toBeVisible({ timeout: 15_000 })
  const text = await toast.innerText()
  await expect(page.locator('[data-line-id]')).toHaveCount(0)
  return /RX\/\d+\/(\d+)/.exec(text)?.[1] ?? text
}

test.describe('billing with the network down', () => {
  test('completes a sale with every request failing', async ({ page, context }) => {
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeFocused()

    /* Pulled AFTER the app is up, which is the real scenario: the till was
       opened at nine and the router died at two. */
    await context.setOffline(true)

    // The shell says so, in words. An operator who cannot tell is an operator
    // who reassures a customer their UPI payment went through.
    await expect(page.getByText('Offline')).toBeVisible()

    await completeSale(page, 'dolo')
  })

  test('numbers three offline bills gaplessly, with no duplicates', async ({ page, context }) => {
    /* Gapless numbering is the property that cannot be repaired afterwards. A
       duplicate invoice number is two bills claiming to be one document, and a
       gap is a number an auditor asks about and nobody can answer for. */
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeFocused()
    await context.setOffline(true)

    const numbers: number[] = []
    for (const term of ['dolo', 'pan', 'cro']) {
      numbers.push(Number(await completeSale(page, term)))
    }

    expect(new Set(numbers).size, 'duplicate invoice number').toBe(3)
    expect(numbers[1]).toBe(numbers[0]! + 1)
    expect(numbers[2]).toBe(numbers[1]! + 1)
  })

  test('the offline bills are still there after the network returns', async ({ page, context }) => {
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeFocused()

    await context.setOffline(true)
    const invoiceNo = await completeSale(page, 'dolo')
    await context.setOffline(false)

    /* The register is read from IndexedDB, so the bill has to be there whether
       or not anything ever reaches a server. A sale that vanishes when the link
       comes back is worse than one that never happened: the money was taken and
       the strip was handed over. */
    await page.goto('/sales')
    const register = page.getByRole('grid', { name: 'Invoice register' })
    await expect(register).toBeVisible({ timeout: 20_000 })
    await expect(register.getByText(new RegExp(`${invoiceNo}$`)).first()).toBeVisible()
  })

  test('says it is offline everywhere, not only on the till', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 })
    await context.setOffline(true)

    // The chip lives in the shell, so it has to be true on every screen.
    await expect(page.getByText('Offline')).toBeVisible()
    await page.goto('/sales').catch(() => { /* a hard navigation may fail offline; that is the point */ })
    await context.setOffline(false)
  })
})
