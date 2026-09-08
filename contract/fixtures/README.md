# Golden fixtures

Machine-readable vectors that **both** money engines must reproduce exactly:

- `web/src/domain/` (TypeScript — used by the mock backend and by offline billing)
- `crates/domain/` (Rust — the server, from Phase 4)

Offline billing means a client-side quote engine is permanent, not scaffolding, so
two implementations of the same arithmetic exist by design. These files are what
stops them drifting: CI fails if either produces a different answer.

`tax-vectors.json` is deliberately plain JSON with decimal **strings** so a Rust
test can `serde_json` it without a shared schema.
