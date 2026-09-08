# RxBill

Pharmacy billing and inventory management. A keyboard-first, POS-style app for
retail pharmacy counters: React + TypeScript on the front, Rust + PostgreSQL
behind it.

The billing screen is the product. Everything else supports it.

## Quick start

```bash
make setup        # web deps + create the rxbill database
make dev-api      # :8080
make dev-web      # :5173, proxies /api to :8080
```

Then open <http://localhost:5173/_design> — the design gate — before anything else.

## Where things live

| Path | What |
|---|---|
| `contract/` | `openapi.yaml` (source of truth) and golden tax/FEFO fixtures |
| `web/` | React SPA. `src/design` tokens, `src/domain` the TS money engine |
| `crates/domain` | Pure Rust money/GST/FEFO core — no sqlx, axum or tokio |
| `crates/db` `crates/services` `crates/api` `crates/jobs` | Data, transactions, HTTP, worker |
| `migrations/` `seed/` | Schema and reference data |
| `docs/INVARIANTS.md` | Every correctness rule, its mechanism, and the gate that enforces it |
| `docs/UNVERIFIED.md` | Legal thresholds and versions that are NOT yet verified |
| `scripts/guardrails.sh` | The mechanised design and correctness rules |

## Two engines, one set of fixtures

Offline billing needs a client-side quote engine, so money arithmetic exists in
both TypeScript and Rust. They are kept honest by `contract/fixtures/*.json`:
both must reproduce every fixture exactly, and CI fails if either diverges.

Online, the server's `POST /sales/quote` is authoritative. Offline, the TS engine
computes and the server re-computes on resync, flagging divergence rather than
silently accepting it.

## This machine

- PostgreSQL **16.14** (Homebrew) — target PG16 syntax only; the `psql` client on
  PATH is newer and will accept syntax the server rejects.
- No container runtime. `#[sqlx::test]` against the local server is the
  integration-test harness; there is no compose file by design.
- `psql` needs an explicit `-d`: bare `psql` fails with
  `FATAL: database "<user>" does not exist`.
- `DATABASE_URL` must name a role explicitly — sqlx does not fall back to the OS
  user and will try to connect as `anonymous`.
- **The Xcode licence is unaccepted.** `/usr/bin/cc` AND `/usr/bin/make` are both
  `xcrun` shims that refuse to run until it is, so `make` fails before it can even
  read the Makefile. One-time fix, either of:

  ```bash
  sudo xcodebuild -license accept
  sudo xcode-select -s /Library/Developer/CommandLineTools
  ```

  Until then, use the Command Line Tools copy directly — it needs no licence and
  the Makefile already points the Rust build at its compiler:

  ```bash
  /Library/Developer/CommandLineTools/usr/bin/make doctor
  ```
