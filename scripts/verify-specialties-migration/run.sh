#!/usr/bin/env bash
# Proves prisma/migrations/20261015230000_specialties_own_words on a THROWAWAY local Docker
# Postgres: fixture → run 1 → assertions → run 2 → byte-identical data → empty schema diff.
# Never points at anything but localhost. Usage: scripts/verify-specialties-migration/run.sh [port]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/scripts/verify-specialties-migration"
MIGRATION="${MIGRATION:-$ROOT/prisma/migrations/20261015230000_specialties_own_words/migration.sql}"
PORT="${1:-55433}"
NAME="nhp-pg-specialties-verify"
URL="postgresql://postgres:x@localhost:${PORT}/postgres"

if [ -e "$ROOT/.env" ]; then
  echo "refusing: $ROOT/.env exists (it may hold production credentials)" >&2
  exit 1
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run --rm -d --name "$NAME" -e POSTGRES_PASSWORD=x -p "${PORT}:5432" postgres:16 >/dev/null
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
sleep 1

psql_() { docker exec -i "$NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
counts() {
  psql_ -At -c "SELECT 'Specialty=' || (SELECT count(*) FROM \"Specialty\")
    || ' withParent=' || (SELECT count(*) FROM \"Specialty\" WHERE \"parentId\" IS NOT NULL)
    || ' SpecialtyAlias=' || (SELECT count(*) FROM \"SpecialtyAlias\")
    || ' PractitionerSpecialty=' || (SELECT count(*) FROM \"PractitionerSpecialty\")
    || ' Practitioner=' || (SELECT count(*) FROM \"Practitioner\")"
}
assert_() {
  local out
  out="$(psql_ < "$DIR/assert.sql" 2>&1)" || { echo "ASSERTION FAILED: $out" >&2; exit 1; }
  echo "$out" | grep -o 'ALL ASSERTIONS PASSED'
}
snapshot() {
  docker exec "$NAME" pg_dump -U postgres -d postgres --data-only --inserts \
    -t '"Specialty"' -t '"SpecialtyAlias"' -t '"PractitionerSpecialty"' -t '"Practitioner"' 2>/dev/null \
    | grep '^INSERT' | sort
}

psql_ -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'
(cd "$ROOT" && env -u DATABASE_URL hhe_directory_DATABASE_URL="$URL" hhe_directory_DATABASE_URL_UNPOOLED="$URL" \
  npx prisma db push --skip-generate --schema prisma/schema.prisma >/dev/null)

psql_ < "$DIR/fixture.sql"
echo "before:     $(counts)"

psql_ < "$MIGRATION"
echo "after run1: $(counts)"
assert_
snapshot > /tmp/nhp-specialties-run1.sql

psql_ < "$MIGRATION"
echo "after run2: $(counts)"
snapshot > /tmp/nhp-specialties-run2.sql
if diff -q /tmp/nhp-specialties-run1.sql /tmp/nhp-specialties-run2.sql >/dev/null; then
  echo "second run: no-op (data byte-identical, $(wc -l < /tmp/nhp-specialties-run1.sql) rows compared)"
else
  echo "second run CHANGED data" >&2
  diff /tmp/nhp-specialties-run1.sql /tmp/nhp-specialties-run2.sql >&2 || true
  exit 1
fi
assert_

DIFF="$(cd "$ROOT" && env -u DATABASE_URL hhe_directory_DATABASE_URL="$URL" hhe_directory_DATABASE_URL_UNPOOLED="$URL" \
  npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script)"
if echo "$DIFF" | grep -qvE '^\s*(--.*)?$'; then
  echo "schema diff NOT empty:" >&2
  echo "$DIFF" >&2
  exit 1
fi
echo "schema diff: empty"
echo "OK"
