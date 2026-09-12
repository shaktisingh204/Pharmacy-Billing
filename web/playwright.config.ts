import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  /* One retry locally too. Each test context seeds its own IndexedDB copy of the
     demo database, so six cold workers contend for disk and a slow-but-correct
     save can miss its deadline. The mock backend is the cause; a real server has
     no per-context seed. A retry keeps a flake from reading as a regression. */
  retries: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  /*
   * 10s, against Playwright's 5s default.
   *
   * Every test context gets a fresh IndexedDB and re-seeds the whole demo
   * database — ~1,600 medicines, 2,500 batches and 8,500 priced invoices — before
   * the shell can paint. Six workers do that concurrently, and a cold first paint
   * lands around 2s on an idle machine and well past 5s under that load.
   *
   * Measured, not guessed: once booted, a client-side navigation to the heaviest
   * page (Reports) resolves in ~60ms and a full reload in ~125ms. The budget is
   * for seeding, which the real server does not do at all.
   */
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // The design floor: a 1366x768 physical all-in-one leaves ~640px of
      // usable viewport. If it does not work here, it does not work.
      name: 'pos-1366',
      /* The owner's phone surface is phone-only by design, so it runs in its
         own project rather than being asserted at a till width it will never
         be opened at. */
      testIgnore: /owner-mobile\.spec\.ts/,
      /*
   * 10s, against Playwright's 5s default.
   *
   * Every test context gets a fresh IndexedDB and re-seeds the whole demo
   * database — ~1,600 medicines, 2,500 batches and 8,500 priced invoices — before
   * the shell can paint. Six workers do that concurrently, and a cold first paint
   * lands around 2s on an idle machine and well past 5s under that load.
   *
   * Measured, not guessed: once booted, a client-side navigation to the heaviest
   * page (Reports) resolves in ~60ms and a full reload in ~125ms. The budget is
   * for seeding, which the real server does not do at all.
   */
  expect: { timeout: 10_000 },

  use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 640 } },
    },
    {
      name: 'desktop-1600',
      testIgnore: /owner-mobile\.spec\.ts/,
      /*
   * 10s, against Playwright's 5s default.
   *
   * Every test context gets a fresh IndexedDB and re-seeds the whole demo
   * database — ~1,600 medicines, 2,500 batches and 8,500 priced invoices — before
   * the shell can paint. Six workers do that concurrently, and a cold first paint
   * lands around 2s on an idle machine and well past 5s under that load.
   *
   * Measured, not guessed: once booted, a client-side navigation to the heaviest
   * page (Reports) resolves in ~60ms and a full reload in ~125ms. The budget is
   * for seeding, which the real server does not do at all.
   */
  expect: { timeout: 10_000 },

  use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } },
    },
    {
      /*
       * A real phone, not a narrow desktop window.
       *
       * 390x844 is the iPhone 12/13/14 class and the smallest screen this app
       * is asked to be useful on. The touch flags are set explicitly rather than
       * taken from an `iPhone` device profile: those run WebKit, and the rest of
       * this suite runs Chromium — a second browser engine downloaded for four
       * tests buys a portability check nobody asked for and costs every CI run.
       * Chromium's own mobile emulation gives the touch behaviour and the pixel
       * ratio, which is what these assertions are actually about.
       */
      name: 'phone-390',
      testMatch: /owner-mobile\.spec\.ts/,
      expect: { timeout: 10_000 },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
})
