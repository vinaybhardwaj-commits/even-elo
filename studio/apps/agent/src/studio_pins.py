"""Pinned Neon addresses: connections must not need DNS on the agent host.

If the pins file exists (env STUDIO_NEON_PINS, default /run/studio-agent/neon-pins.json) it holds
{"host": ["ip", ...]}. For a pinned host the connection gets hostaddr=<first ip, IPv4 preferred>
while host= stays the hostname, so libpq connects to the IP but still uses the name for TLS SNI
and certificate verification (sslmode is untouched). With STUDIO_REQUIRE_PINS=1 a host without a
pin FAILS CLOSED (PinError) instead of being resolved. Under REQUIRE the DSN must also name exactly one
host explicitly (multi-host, service= and host-less DSNs are refused, unix-socket paths excepted) and
PGHOST/PGHOSTADDR/PGSERVICE/PGSERVICEFILE from the environment are ignored (removed), so nothing outside
the DSN and the pins file can steer the address. The pins file must be a regular file, not a symlink,
owned by root and not group/world-writable, else it is refused (PinError under REQUIRE, ignored otherwise). No pins file and REQUIRE unset: unchanged
behaviour (dev/CI). Unix-socket paths and IP-literal hosts never need DNS and are left alone.
"""

from __future__ import annotations

import ipaddress
import json
import os
import stat
from pathlib import Path
from typing import Optional

from psycopg.conninfo import conninfo_to_dict, make_conninfo

DEFAULT_PINS_PATH = "/run/studio-agent/neon-pins.json"
TRUSTED_UID = 0  # the pins file must be owned by this uid (root); tests override the module constant
LIBPQ_ENV_OVERRIDES = ("PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")


class PinError(RuntimeError):
    """No pinned address for a host while pins are required (message carries no host or secret)."""


def pins_path(env=os.environ) -> Path:
    return Path(env.get("STUDIO_NEON_PINS") or DEFAULT_PINS_PATH)


def _require(env) -> bool:
    return env.get("STUDIO_REQUIRE_PINS") == "1"


def _file_trusted(path: Path) -> bool:
    """Regular file (not a symlink), owned by TRUSTED_UID, not writable by group or others."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid == TRUSTED_UID and not (st.st_mode & 0o022)


def load_pins(env=os.environ) -> Optional[dict[str, list[str]]]:
    path = pins_path(env)
    if not path.exists() and not path.is_symlink():
        return None
    if not _file_trusted(path):
        if _require(env):
            raise PinError("pins file is a symlink, not root-owned, or group/world-writable")
        return None
    try:
        raw = json.loads(path.read_text())
        return {str(h).lower(): [str(i) for i in ips] for h, ips in raw.items()}
    except (OSError, ValueError, AttributeError, TypeError):
        if _require(env):
            raise PinError("pins file unreadable") from None
        return None


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value.strip("[]"))
        return True
    except ValueError:
        return False


def _prefer_v4(ips: list[str]) -> Optional[str]:
    valid = [i for i in ips if _is_ip(i)]
    v4 = [i for i in valid if ipaddress.ip_address(i).version == 4]
    return (v4 or valid or [None])[0]


def pinned_conninfo(dsn: str, env=os.environ) -> str:
    """Return dsn (url or conninfo) with hostaddr set from the pins file; see module docstring."""
    params = conninfo_to_dict(dsn)
    host = (params.get("host") or "").strip()
    require = _require(env)
    if require:
        # Nothing but the DSN and the pins file may steer the address: libpq would otherwise read
        # these from the process environment (and a service file can set host/hostaddr too).
        for name in LIBPQ_ENV_OVERRIDES:
            os.environ.pop(name, None)
        if params.get("service"):
            raise PinError("service= DSNs are refused when pins are required")
        if not host:
            raise PinError("DSN without an explicit host is refused when pins are required")
        if "," in host or "," in (params.get("hostaddr") or ""):
            raise PinError("multi-host DSNs are refused when pins are required")
    if params.get("hostaddr") or not host or host.startswith("/") or "," in host:
        return dsn  # explicit hostaddr, socket or (outside REQUIRE) other forms: no DNS decision to make here
    if _is_ip(host):
        # An IP literal needs no DNS; pin it as hostaddr too so PGHOSTADDR (already removed under REQUIRE) can't matter.
        return make_conninfo(dsn, hostaddr=host.strip("[]")) if require else dsn
    pins = load_pins(env)
    ip = _prefer_v4(pins.get(host.lower(), [])) if pins else None
    if ip:
        return make_conninfo(dsn, hostaddr=ip)  # host stays: SNI + certificate verification
    if require:
        raise PinError("no pinned address for the database host; refusing to resolve DNS")
    return dsn
