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
  local method="${4:-GET}"

  local code
  if [ "$method" = "POST" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "$url")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  fi
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

# ELO.2 — case lifecycle + position picker
check "GET /input/cases"                      "$BASE_URL/input/cases"
check "GET /input/cases/upload"               "$BASE_URL/input/cases/upload"
check "GET /admin/cases"                      "$BASE_URL/admin/cases"
check "GET /api/cases"                        "$BASE_URL/api/cases"
check "GET /api/cases?status=all"             "$BASE_URL/api/cases?status=all"
check "GET /api/cases/[invalid] (400)"        "$BASE_URL/api/cases/not-a-uuid" 400
check "POST /api/recompute/[invalid] (400)"   "$BASE_URL/api/recompute/not-a-uuid" 400 POST

# ELO.3b — engine API + batch recompute
check "POST /api/admin/recompute (no args)"   "$BASE_URL/api/admin/recompute" 400 POST
check "POST /api/admin/recompute?vc=invalid"  "$BASE_URL/api/admin/recompute?vc=not-a-uuid" 400 POST
check "POST /api/admin/recompute?all=true"    "$BASE_URL/api/admin/recompute?all=true" 200 POST

echo "─────────────────────────────────────"
echo "  $PASS passed · $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
