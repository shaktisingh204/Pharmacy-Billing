# Invariants

Every rule here has a **mechanism** (the thing that makes violating it fail) and a
**gate** (the thing that fails if the mechanism is removed). "Be careful" is not a
mechanism. Rows marked _pending_ land in the phase named.

The point of the register is that dropping a `CHECK` turns CI red, rather than
turning up in a GST filing eighteen months later.

| # | Invariant | Mechanism | Gate | Status |
|---|-----------|-----------|------|--------|
| I1 | Money is never IEEE-754 | PG `NUMERIC` domains; `rust_decimal` in Rust; decimal strings on the wire | `scripts/guardrails.sh` bans `.toFixed(` in `web/src` | **active** |
| I2 | The focus ring is never suppressed | `:focus-visible` contract in `design/base.css` | `guardrails.sh` bans `outline:none` elsewhere | **active** |
| I3 | `crates/domain` stays pure | No sqlx/axum/tokio in its manifest | `guardrails.sh` runs `cargo tree --prefix none` | **active** |
| I4 | Migrations target PostgreSQL 16 | Review | `guardrails.sh` bans `uuidv7()`, `JSON_TABLE`, `MERGE…RETURNING` | **active** |
| I5 | axum 0.8 path syntax | `/{id}`, never `/:id` (the old form panics at startup, not compile time) | `guardrails.sh` grep | **active** |
| I6 | `store_id` on every transactional row | Column + FK in migration 0001; RLS `FORCE` | `tests/sql/invariants.sql` | _Phase 4_ |
| I7 | MRP is part of batch identity | `UNIQUE (store_id, medicine_id, normalized_batch_no, expiry_date, mrp_per_pack)` | constraint-exists assertion | _Phase 4_ |
| I8 | Output GST resolves by invoice date | `tax_rates` + `EXCLUDE USING gist` on overlapping ranges | two-date SQL assertion | _Phase 4_ |
| I9 | No `gst_rate` column on `medicines` | Schema review | `invariants.sql` asserts the column is absent | _Phase 4_ |
| I10 | Line arithmetic foots exactly | `CHECK (taxable + cgst + sgst + igst = line_total)` | property test, 10k pairs | _Phase 4_ |
| I11 | A full pack at MRP totals the printed MRP | Residual tax arithmetic in `domain::gst` | golden fixture | _Phase 4_ |
| I12 | IGST XOR (CGST + SGST) | `CHECK` | `invariants.sql` | _Phase 4_ |
| I13 | Round-off bounded ±0.50 | `CHECK` | `invariants.sql` | _Phase 4_ |
| I14 | Stock never goes negative | `CHECK (qty_on_hand >= 0)` + conditional-`UPDATE` decrement as the ONLY primitive | two-racing-transactions test | _Phase 5_ |
| I15 | FEFO never uses `SKIP LOCKED` | `FOR NO KEY UPDATE` on sorted, deduped batch ids | code review + concurrency test | _Phase 5_ |
| I16 | The stock ledger is append-only | `REVOKE UPDATE, DELETE` + `RAISE` trigger | `invariants.sql` | _Phase 4_ |
| I17 | Ledger reconciles to `batches.qty_on_hand` | Nightly job; surfaced as a UI health chip | reconciliation returns zero rows | _Phase 8_ |
| I18 | Invoice numbers are gapless per (store, FY, terminal) | `doc_series` counter row, `UPDATE … RETURNING` taken LAST before COMMIT | 50-concurrent-sales window-function assertion | _Phase 5_ |
| I19 | Landed cost divides by (paid + free) | Generated column | 10+1 scheme golden fixture | _Phase 4_ |
| I20 | Posted documents are immutable | No update path; corrections are credit/debit notes | route × role test; no edit affordance in the UI | _Phase 5_ |
| I21 | Returns reverse the ORIGINAL tax | Reversal reads the snapshotted line, never today's rate | 3-of-10 return fixture | _Phase 5_ |
| I22 | An approver is never the requester | `CHECK (approver_id <> requester_id)` | `invariants.sql` | _Phase 5_ |
| I23 | Every route is permission-gated | `Require<const P>` extractor — an ungated route fails to compile | parameterised route × role test over the whole router | _Phase 5_ |
| I24 | Erasure is redaction-with-retention | `legal_holds` blocks the purge job unconditionally | DSAR test against a customer with H1 register rows | _Phase 5_ |

## Locking rules (Phase 5)

- Batch ids are **sorted and deduplicated** before locking. Unsorted acquisition
  deadlocks multi-line bills.
- Lock with `FOR NO KEY UPDATE`. Plain `FOR UPDATE` blocks the `FOR KEY SHARE`
  taken by the line's FK insert and serialises unrelated sales.
- Never derive available stock from `SUM(qty_delta)` at sale time: under READ
  COMMITTED two concurrent sales read the same sum and both succeed.
- `SKIP LOCKED` is correct for `job_queue`. On FEFO batch selection it would
  silently dispense the wrong batch.
- Take the document number **last**, immediately before COMMIT.
