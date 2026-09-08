# seed/

Demo master data for development, screenshots and tests.

## What this is NOT

**This is not a drug database.** Nothing in `medicines.ts` came from a primary
source. It exists so the billing screen has something realistic to render, and
for no other purpose.

- **Brand ↔ manufacturer pairings are approximations.** The brand names and the
  companies are real; the specific pairings, and the compositions attached to
  them, were written from memory and are wrong in places. A brand that changed
  hands, a strength that was never marketed, a salt combination that does not
  exist — assume all three are present.
- **Prices are invented.** MRPs are plausible for the Indian retail market at
  roughly ₹30 for a strip of Dolo 650, not accurate for any product, any pack or
  any date. PTR and landed cost are derived from MRP by applying a made-up
  retailer margin, not taken from any price list.
- **HSN codes are unverified.** Which tariff heading a formulation sits under —
  and therefore which GST slab it attracts — is a tax determination this repo has
  not made. See `docs/UNVERIFIED.md`, rows *"Which HSN codes (3003/3004/3005/3822…)
  sit in which slab"* and *"Current GST slab list"*.
- **Schedule classifications are unverified.** The `H`/`H1`/`X` assignments are
  what a working pharmacist would probably guess, which is not the same as what
  the gazette says. `docs/UNVERIFIED.md` records that *"The Schedule H1 substance
  list and its length"* must come from the gazette before it drives anything.
  Schedule H1 and Schedule X are the two that carry a statutory register, so
  getting them wrong in production is a licensing problem, not a data problem.
- **Barcodes are fabricated.** They use the GS1 India `890` prefix and carry a
  correctly computed EAN-13 check digit, so a scanner will accept them. The
  company prefixes are made up and may collide with a real product's number.

Before any of this is used for a real store, every HSN code, every GST rate and
every schedule classification must be re-derived from primary sources and the
matching rows in `docs/UNVERIFIED.md` closed with a date and a citation.

## What is in it

`medicines.ts` exports:

| Export | What |
|---|---|
| `SEED_MEDICINES: SeedMedicine[]` | ~1,600 SKUs, expanded from a curated table of ~375 real Indian retail brands across strength and pack variants |
| `generateBatches(medicines, today)` | ~2,470 opening-stock batches, 1–3 per medicine, expiries spread relative to `today` |

`SeedMedicine` is `Medicine` without the fields the store assigns (`id`,
`storeId`, `isActive`) plus `barcodes`. `generateBatches` takes the medicines
*after* ids have been assigned and returns `Omit<Batch, 'id' | 'storeId'>`.

```ts
import { SEED_MEDICINES, generateBatches } from '../../seed/medicines'

const medicines = SEED_MEDICINES.map((m, i) => ({ ...m, id: i + 1 }))
const batches = generateBatches(medicines, new Date())
```

The data is shaped to exercise the paths that are easy to leave untested:

- **~60% of SKUs have a barcode.** The rest have none, because most Indian strips
  genuinely do not, and the UI has an explicit no-barcode path.
- **~6.6% of medicines have zero sellable stock**, and ~150 more sit below their
  reorder level — the out-of-stock, short-book and reorder paths.
- **Over 600 medicines carry two live batches at different printed MRPs.** This
  is the case the batch-chip strip and the `MIXED_MRP` reprice warning exist for;
  60 of them are forced onto the highest-ranked medicines so a demo cannot come
  up without it.
- **Expiries are spread** ~3% already expired, ~5% within 30 days, ~6% within 60,
  ~7% within 90, ~13% within 180, the rest beyond — so every near-expiry bucket
  in `web/src/lib/expiry.ts` has real rows behind it.
- **169 Schedule H1 SKUs and 5 Schedule X SKUs**, so the register-capture and
  blocking-warning paths have data.
- **Four purchase GST rates** (0/5/12/18) and 18 distinct HSN codes, so the
  multi-rate tax breakup on the bill is never a single row.
- `saleStep` is `"0.5"` on 117 tablet SKUs (thyroid, steroid and some
  psychiatric) where half-tablet dispensing is routine, and some of their batches
  carry a `.5` remainder.

## Rules the generator holds to

- **Money is emitted as strings.** All arithmetic runs on scaled integers inside
  the file; `mrpPerUnit` is derived from `mrpPerPack` by integer division and is
  correct to 4 decimal places by construction, never re-derived from a float.
  `.toFixed()` is not used (invariant I1).
- **Expiry is the last day of the printed month.** `11/27` is `2027-11-30`, and
  February is right in leap years. Buckets are built by classifying real
  month-end dates rather than by snapping a day offset, which would silently move
  dates across bucket boundaries and skew the mix. Because month-ends are 28–31
  days apart and a bucket is 30 days wide, a bucket can hold no month-end at all
  on some seeding dates (nothing expires 61–90 days after 2026-03-01); such a
  bucket borrows from its nearest populated neighbour, so the mix shifts by one
  band on those days rather than dumping the whole share years into the future.
- **`(medicine, batchNo, expiry, MRP)` is unique**, matching invariant I7 — MRP
  is part of batch identity.
- **The PRNG is seeded.** `Math.random()` is never called: two runs produce
  byte-identical output, so fixtures and screenshots stay reproducible. Editing
  the `BRANDS` table reshuffles everything downstream of the edit, which is
  expected — re-baseline any snapshot that depends on it.
