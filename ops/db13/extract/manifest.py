"""Pinned query manifest. `python -m extract.manifest write|check` (run from ops/db13)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .queries import all_queries, sha

MANIFEST = Path(__file__).with_name("manifest.json")


def generate() -> dict:
    return {"version": 1, "queries": {k: sha(v) for k, v in sorted(all_queries().items())}}


def load() -> set[str]:
    return set(json.loads(MANIFEST.read_text())["queries"].values())


if __name__ == "__main__":
    if sys.argv[1:] == ["write"]:
        MANIFEST.write_text(json.dumps(generate(), indent=1) + "\n")
    elif sys.argv[1:] == ["check"]:
        sys.exit(0 if json.loads(MANIFEST.read_text()) == generate() else 1)
    else:
        sys.exit("usage: manifest write|check")
