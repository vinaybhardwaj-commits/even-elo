#!/bin/bash
# launchd entry point on the Mini. Logs counts only (stdout goes to the plist's log file).
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run --python 3.12 --with "psycopg[binary]" python -m extract.cli "${@:-scheduled}"
