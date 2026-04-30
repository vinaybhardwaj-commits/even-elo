#!/usr/bin/env bash
# Even-ELO smoke matrix.
# Run after every push. Grows with each sprint that adds endpoints.

set -e

BASE_URL="${BASE_URL:-https://even-elo.vercel.app}"
PASS=0
FAIL=0

check() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"

  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$code" = "$expected" ]; then
    echo "  ✓ $label  [$code]"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label  [got $code, expected $expected]  $url"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Even-ELO smoke matrix · $BASE_URL"
echo "─────────────────────────────────────"

# ELO.0 — public surface
check "GET /"                                 "$BASE_URL/"

# ELO.1 — admin + DB-backed routes
check "GET /admin"                            "$BASE_URL/admin"
check "GET /admin/vcs"                        "$BASE_URL/admin/vcs"
check "GET /admin/positions"                  "$BASE_URL/admin/positions"
check "GET /api/admin/migrate (state)"        "$BASE_URL/api/admin/migrate"
check "GET /api/vcs"                          "$BASE_URL/api/vcs"
check "GET /api/vcs?status=all"               "$BASE_URL/api/vcs?status=all"
check "GET /api/positions"                    "$BASE_URL/api/positions"
check "GET /api/vcs/[invalid] (400)"          "$BASE_URL/api/vcs/not-a-uuid" 400

echo "─────────────────────────────────────"
echo "  $PASS passed · $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
