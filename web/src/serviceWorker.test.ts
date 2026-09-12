import { describe, expect, it } from 'vitest'
// `?raw` rather than node:fs: this file is compiled with the browser tsconfig,
// and adding Node's types to it would leak `process` and friends into app code.
import SW from '../public/sw.js?raw'

/**
 * The service worker decides what is cached by matching asset FILENAMES, and it
 * is the only code in the app whose correctness depends on how the bundler names
 * things. That coupling is invisible and it has already been wrong once: the
 * first version looked for a lowercase hex hash, while Rolldown emits base64-ish
 * ones like `db-DT85gwXl.js` and `index--_1w-Ici.js`. It matched nothing —
 * everything worked online, and the first offline boot found an empty cache.
 *
 * So the pattern is read out of the worker itself and run against the real build
 * output. A bundler upgrade that changes the naming fails here rather than at a
 * counter during a power cut.
 */

function hashedAssetPattern(): RegExp {
  const line = /const isHashedAsset[\s\S]*?&&\s*(\/.*\/)\.test/.exec(SW)
  if (!line?.[1]) throw new Error('isHashedAsset pattern not found in public/sw.js')
  const body = line[1].slice(1, line[1].lastIndexOf('/'))
  return new RegExp(body)
}

describe('the service worker', () => {
  it('does not skipWaiting — a till mid-sale must not have its chunks swapped', () => {
    // The running document holds references to hashed chunks a new build no
    // longer has, so an update that activates underneath a half-finished bill
    // breaks the next lazy route, which at a counter is the payment screen.
    expect(SW).not.toMatch(/^\s*self\.skipWaiting\(\)/m)
    // It activates only when asked.
    expect(SW).toMatch(/SKIP_WAITING/)
  })

  it('never caches the API — a stale figure that looks live is how a till oversells', () => {
    expect(SW).toMatch(/\/api\//)
  })

  it('matches the shapes the bundler actually emits', () => {
    /* Real names from a real build. Rolldown's hashes are base64-ish: mixed
       case, and `-` and `_` both appear — `index--_1w-Ici.js` has two hyphens
       and an underscore in a row. The lowercase-hex pattern this started as
       matched none of them.

       The exhaustive check against every file in `dist/assets` lives in
       `scripts/guardrails.sh`, which runs after a build; this covers the shapes
       without needing one. */
    const pattern = hashedAssetPattern()
    for (const name of [
      'db-DT85gwXl.js', 'index--_1w-Ici.js', 'index-DAOkvbG5.css',
      'gst-BnRamXOL.js', 'ThermalReceipt-CKQVVkBa.js',
    ]) {
      expect(pattern.test(`/assets/${name}`), name).toBe(true)
    }
  })

  it('rejects things that are NOT content-addressed assets', () => {
    const pattern = hashedAssetPattern()
    for (const path of ['/index.html', '/sw.js', '/api/v1/health', '/assets/short-ab.js']) {
      expect(pattern.test(path), path).toBe(false)
    }
  })
})
