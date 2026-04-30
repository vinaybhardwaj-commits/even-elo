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

# ELO.0 — single endpoint, expand per sprint.
check "GET /"                            "$BASE_URL/"

echo "─────────────────────────────────────"
echo "  $PASS passed · $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
