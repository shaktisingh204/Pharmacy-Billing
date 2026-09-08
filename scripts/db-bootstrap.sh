#!/usr/bin/env bash
# Creates the rxbill database and its extensions against the LOCAL Homebrew
# Postgres. There is no container runtime on this machine (docker, podman and
# colima are all absent), so this is the dev database.
#
# GOTCHA: bare `psql` fails with 'FATAL: database "<user>" does not exist' —
# every invocation below therefore passes -d explicitly.
set -euo pipefail

DB="${RXBILL_DB:-rxbill}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

if ! pg_isready -q; then
  echo "error: no PostgreSQL server is accepting connections." >&2
  echo "       start it with: brew services start postgresql@16" >&2
  exit 1
fi

server_version=$("${PSQL[@]}" -d postgres -tAc "SHOW server_version")
echo "server: PostgreSQL ${server_version}"
case "$server_version" in
  16.*) ;;
  *) echo "warning: this project targets PG16 syntax; server is ${server_version}." >&2 ;;
esac

if "${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB}'" | grep -q 1; then
  echo "database '${DB}' already exists"
else
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE ${DB}"
  echo "created database '${DB}'"
fi

"${PSQL[@]}" -d "${DB}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- session token hashing
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- typo-tolerant medicine search
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive usernames
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- tax-rate date-range EXCLUDE
CREATE EXTENSION IF NOT EXISTS btree_gin;
SQL

echo "extensions:"
"${PSQL[@]}" -d "${DB}" -tAc \
  "SELECT '  ' || extname || ' ' || extversion FROM pg_extension ORDER BY extname"
echo
echo "ready: DATABASE_URL=postgres://localhost:5432/${DB}"
