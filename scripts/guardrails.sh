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

if [ "$fail" -eq 0 ]; then 
# ------------------------------------------------------- service worker -----
# The worker decides what to cache by matching asset FILENAMES, which couples it
# to the bundler's hash format — invisibly. It has been wrong once already: a
# lowercase-hex pattern against Rolldown's base64-ish hashes matched nothing, so
# everything worked online and the first offline boot found an empty cache.
# Only checked when a build exists; `npm run build` then this is the full check.
if [ -d web/dist/assets ]; then
  missed=$(node -e '
    const fs = require("fs");
    const sw = fs.readFileSync("web/public/sw.js", "utf8");
    const m = /const isHashedAsset[\s\S]*?&&\s*(\/.*\/)\.test/.exec(sw);
    if (!m) { console.log("PATTERN_NOT_FOUND"); process.exit(0); }
    const re = new RegExp(m[1].slice(1, m[1].lastIndexOf("/")));
    process.stdout.write(
      fs.readdirSync("web/dist/assets").filter((n) => !re.test("/assets/" + n)).join(", "),
    );
  ' 2>/dev/null)
  if [ -n "$missed" ]; then
    report "the service worker would not cache every built asset" \
      "An offline boot would find these missing from the cache:
$missed"
  fi
fi

# --------------------------------------------------- float money arithmetic --
# `.toFixed(` was never the only way to do money in floats, and the gap was real:
# a dashboard "chain total" — a figure an owner quotes — summed branch takings as
# `acc.sales + Number(b.sales)` and passed every check here.
#
# Scoped to the ACCUMULATOR shape (`sum +`, `acc.field +`, `total +`) rather than
# to `Number(` generally: a sort comparator subtracting two `Number()`s produces
# an ordering, not money, and `2000 + Number(yy)` is a year. Those are correct and
# a rule that flags them is a rule people switch off.
if hits=$(grep -rnE '(sum|acc|total|running)[A-Za-z0-9_.]*[[:space:]]*\+[[:space:]]*Number\(' \
    --include='*.ts' --include='*.tsx' web/src 2>/dev/null \
    | grep -v '\.test\.' | code_only); then
  report "money summed as JS floats" \
    "Sum through src/domain/decimal (D.sum/D.add) and convert once with D.toNumber at a
chart or pixel boundary. Found:
$hits"
fi

# ------------------------------------------------- text painted below AA --
# An axe sweep of all thirteen routes found 57 contrast failures on the
# dashboard alone. Two patterns caused most of them, and both look harmless in a
# diff, so they are checked here rather than waiting for the slow suite.
#
# 1. A `-9` step used as a CHIP TONE. The -9 steps are FILLS — they clear the 3:1
#    bar SC 1.4.11 sets for a non-text boundary, and nothing more. `Chip` paints
#    its tone as text on a 12% tint of itself, so a -9 tone renders 12px words at
#    2.8-4.4:1. The -11 steps exist for exactly this and are verified against
#    both grounds in tokens.css.
if hits=$(grep -rnE "tone[:=][[:space:]]*[\"']var\\(--(danger|warning|success|info)-9\\)" \
    --include='*.ts' --include='*.tsx' web/src 2>/dev/null | code_only); then
  report "a fill colour used as chip text" \
    "Chip tones are TEXT. Use --<semantic>-11, which is contrast-verified for it.
A -9 step is for fills, borders and icons. Found:
$hits"
fi

# 2. An alpha modifier on a TEXT colour. `text-danger-11/70` is a token that was
#    measured against its background and then faded 30% away from it — every one
#    of these landed between 2.3:1 and 4.3:1. Dimming text is what --fg-muted and
#    --fg-subtle are for, and both clear AA.
if hits=$(grep -rnE 'text-(fg|accent|danger|warning|success|info)[a-z0-9-]*/[0-9]+' \
    --include='*.tsx' web/src 2>/dev/null | code_only); then
  report "text faded below its verified contrast" \
    "An alpha modifier undoes the contrast the token was chosen for. Use
--fg-muted or --fg-subtle for quieter text; both are verified AA. Found:
$hits"
fi

echo "guardrails: all checks passed"; fi
exit "$fail"
