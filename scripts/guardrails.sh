#!/usr/bin/env bash
# Mechanised design and correctness rules. Each of these is a decision that is
# expensive to walk back, so it fails the build rather than a code review.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# Comments and lines marked `guardrail-ignore` are not code. Without this the
# rules match their own documentation.
code_only() { grep -vE "^[^:]+:[0-9]+:[[:space:]]*([*]|//|#)" | grep -v 'guardrail-ignore'; }

report() { # $1=rule  $2=explanation
  echo "GUARDRAIL FAILED: $1" >&2
  echo "  $2" >&2
  fail=1
}

# ---------------------------------------------------------------- money -----
# IEEE-754 rounds ties to even; the statutory rule rounds 50 paise UP. Money
# arithmetic lives in src/domain and crates/domain, never in a view.
if hits=$(grep -rn --include='*.ts' --include='*.tsx' '\.toFixed(' web/src 2>/dev/null | code_only); then
  report ".toFixed( is banned in web/src" \
    "Render money through <Money>/<Qty> (src/lib/format.ts). Found:
$hits"
fi

# --------------------------------------------------------------- focus ------
# The focus ring is load-bearing in a keyboard-first app. base.css is the single
# place allowed to reset it, and only paired with a :focus-visible rule.
if hits=$(grep -rn --include='*.css' --include='*.tsx' 'outline:\s*none\|outline-none' web/src \
          | grep -v 'design/base.css' | code_only); then
  report "outline:none outside design/base.css" \
    "Removing the focus ring makes the app unusable without a mouse. Found:
$hits"
fi

# ---------------------------------------------------------- axum routing ----
# axum 0.8 uses /{id}; the 0.7 /:id syntax panics at startup, not compile time.
if hits=$(grep -rn --include='*.rs' 'route("[^"]*/:' crates 2>/dev/null | code_only); then
  report "axum 0.7 path syntax /:param" \
    "axum 0.8 requires /{param}. This panics at startup, not at compile time. Found:
$hits"
fi

# -------------------------------------------------------- domain purity -----
# crates/domain must stay a pure value library so it can be property-tested and
# reused by the offline path without dragging in a runtime.
if command -v cargo >/dev/null 2>&1; then
  # --prefix none gives a flat "name version" list; the default prefix draws
  # UNICODE box characters, which an ASCII pattern silently never matches.
  if impure=$(cargo tree -p rxbill-domain --edges normal --prefix none 2>/dev/null \
              | grep -E '^(sqlx|axum|tokio|hyper|tower)[ -]' | sort -u); then
    report "crates/domain is no longer pure" \
      "It must not depend on sqlx, axum or tokio. Found:
$impure"
  fi
fi

# --------------------------------------------------------- PG16 target ------
# The psql client on PATH is newer than the 16.x server and will happily accept
# syntax the server rejects at runtime.
if [ -d migrations ]; then
  if hits=$(grep -rniE 'uuidv7\(|json_table|merge .*returning' migrations 2>/dev/null | code_only); then
    report "post-PG16 syntax in migrations" \
      "The dev/prod server is PostgreSQL 16. Found:
$hits"
  fi
fi

if [ "$fail" -eq 0 ]; then echo "guardrails: all checks passed"; fi
exit "$fail"
