//! Pure domain core: money, GST, FEFO, expiry, pricing, landed cost, doc numbers.
//!
//! This crate has ZERO knowledge of sqlx, axum or tokio, enforced in CI by
//! `cargo tree -p rxbill-domain`. Everything here is a pure function over values,
//! written test-first against `contract/fixtures/*.json` — the SAME fixtures the
//! TypeScript engine in `web/src/domain` must reproduce byte-for-byte.
