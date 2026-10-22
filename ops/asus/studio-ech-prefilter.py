#!/usr/bin/env python3
"""ClientHello pre-filter in front of Squid (OPS-PLAN R3-3, fable 5.1 ruling R3-3.1).

The agent's only egress path is agent -> this filter (127.0.0.1:8888) -> Squid (127.0.0.1:8889). Squid 6 cannot match
ClientHello extensions, so this filter does: each connection must open with `CONNECT host:port HTTP/1.x`; the request is
forwarded to Squid unchanged; once Squid has answered 200, the client's first TLS record(s) are read and parsed, and the
connection is dropped if the ClientHello

  - carries extension 0xfe0d (encrypted_client_hello) or the draft variants 0xfe02 / 0xff02, or
  - is malformed (any length that does not add up, duplicate extension, trailing bytes, not a TLS 1.x handshake record), or
  - is larger than MAX_HELLO bytes, or does not arrive within HELLO_TIMEOUT seconds.

It then keeps framing everything the client sends as TLS records for the life of the tunnel and applies the same ClientHello check to
every later handshake record that looks like a ClientHello (type 1, length <= 0xFFFF) - the second ClientHello after a HelloRetryRequest,
sent after the server's reply or pipelined right behind the first. A bad record header, or a ClientHello that is malformed or carries
a banned extension, drops the tunnel. (Ciphertext that merely starts with 0x01 and a small length - a TLS 1.2 Finished - is a ~1.5e-5
false positive per TLS 1.2 handshake; TLS 1.3 never sends a handshake-type record after its second flight.) A tunnel with no bytes in
either direction for IDLE_SECONDS is closed so idle tunnels cannot hold the MAX_CONNS slots.

Everything else is relayed byte for byte, hello included. Nothing is decrypted or rewritten. Python standard library only;
no files, no sockets other than the loopback listener and the loopback upstream. Log lines (stdout -> journal) carry the
verdict, the reason and the CONNECT target, never payload bytes.
"""
import asyncio
import os
import re

LISTEN = ("127.0.0.1", int(os.environ.get("PREFILTER_LISTEN_PORT", "8888")))
UPSTREAM = ("127.0.0.1", int(os.environ.get("PREFILTER_UPSTREAM_PORT", "8889")))
BLOCKED_EXT = {0xFE0D: "encrypted_client_hello", 0xFE02: "ech_draft", 0xFF02: "ech_draft"}
MAX_HELLO = 16384          # handshake body bytes; a TLS record carries at most 2^14, so one record covers a normal hello
MAX_FIRST_RECORDS = 8      # the first hello may span at most this many records (enforced), so buffering is bounded by MAX_BUFFER
MAX_BUFFER = MAX_HELLO + 4 + 5 * MAX_FIRST_RECORDS
MAX_RECORD = 16640         # TLS 1.3 ciphertext record limit (2^14 + 256), for records after the first hello
MAX_HEAD = 8192            # CONNECT request / Squid response head
HEAD_TIMEOUT = 10.0
HELLO_TIMEOUT = 10.0
UPSTREAM_TIMEOUT = 30.0
MAX_CONNS = 64
IDLE_SECONDS = float(os.environ.get("PREFILTER_IDLE_SECONDS", "300"))  # no bytes either way for this long -> tunnel closed
IDLE_CHECK = 10.0
CONNECT_RE = re.compile(rb"CONNECT [!-~]{1,255} HTTP/1\.[01]\r\n")

NEED_MORE, OK, BAD = "need-more", "ok", "bad"


def parse_client_hello(buf):
    """Returns (NEED_MORE, None), (OK, [extension types]) or (BAD, reason) for the bytes read so far."""
    body = bytearray()
    pos = 0
    want = None  # total handshake message length (4-byte header + body) once known
    nrec = 0
    while want is None or len(body) < want:
        if len(buf) - pos < 5:
            return NEED_MORE, None
        rtype, vmaj, vmin = buf[pos], buf[pos + 1], buf[pos + 2]
        rlen = (buf[pos + 3] << 8) | buf[pos + 4]
        nrec += 1
        if nrec > MAX_FIRST_RECORDS:
            return BAD, "too-many-records"
        if rtype != 0x16:
            return BAD, "not-handshake-record"
        if vmaj != 3 or vmin > 4:
            return BAD, "bad-record-version"
        if rlen == 0 or rlen > MAX_HELLO:
            return BAD, "bad-record-length"
        if len(buf) - pos - 5 < rlen:
            if len(buf) > MAX_BUFFER:
                return BAD, "oversize"
            return NEED_MORE, None
        body += buf[pos + 5:pos + 5 + rlen]
        pos += 5 + rlen
        if want is None and len(body) >= 4:
            if body[0] != 1:
                return BAD, "not-client-hello"
            hlen = int.from_bytes(body[1:4], "big")
            if hlen > MAX_HELLO:
                return BAD, "oversize"
            want = 4 + hlen
        if len(body) > MAX_BUFFER:
            return BAD, "oversize"
    if len(body) != want or pos != len(buf):
        return BAD, "trailing-bytes"
    return _parse_body(bytes(body[4:]))


def _parse_body(b):
    n = len(b)
    if n < 2 + 32 + 1:
        return BAD, "short-hello"
    i = 2 + 32
    sid = b[i]
    i += 1
    if sid > 32 or i + sid > n:
        return BAD, "bad-session-id"
    i += sid
    if i + 2 > n:
        return BAD, "short-hello"
    cs = (b[i] << 8) | b[i + 1]
    i += 2
    if cs < 2 or cs % 2 or i + cs > n:
        return BAD, "bad-cipher-suites"
    i += cs
    if i + 1 > n:
        return BAD, "short-hello"
    cm = b[i]
    i += 1
    if cm < 1 or i + cm > n:
        return BAD, "bad-compression"
    i += cm
    if i == n:
        return OK, []  # no extensions at all (TLS 1.2 and older): cannot carry ECH
    if i + 2 > n:
        return BAD, "short-extensions"
    el = (b[i] << 8) | b[i + 1]
    i += 2
    if i + el != n:
        return BAD, "bad-extensions-length"
    seen = []
    while i < n:
        if i + 4 > n:
            return BAD, "truncated-extension"
        t = (b[i] << 8) | b[i + 1]
        ln = (b[i + 2] << 8) | b[i + 3]
        i += 4
        if i + ln > n:
            return BAD, "extension-overruns"
        if t in seen:
            return BAD, "duplicate-extension"
        seen.append(t)
        i += ln
    return OK, seen


def clean(b):
    return re.sub(r"[^A-Za-z0-9.:\[\]_-]", "?", b.decode("latin-1"))[:80]


def log(verdict, reason, target, extra=""):
    print(f"prefilter {verdict} reason={reason} target={target}{(' ' + extra) if extra else ''}", flush=True)


async def read_head(reader, pending=b""):
    """Read up to and including \\r\\n\\r\\n. Returns (head, rest) or raises."""
    buf = pending
    while b"\r\n\r\n" not in buf:
        if len(buf) > MAX_HEAD:
            raise ValueError("head-too-large")
        chunk = await reader.read(4096)
        if not chunk:
            raise ValueError("eof")
        buf += chunk
    k = buf.index(b"\r\n\r\n") + 4
    return buf[:k], buf[k:]


class ClientStream:
    """TLS record framing plus the ClientHello check for everything the client sends after its first hello."""

    def __init__(self):
        self.buf = bytearray()
        self.frag = None      # a ClientHello-shaped handshake message that spans records, until complete
        self.held = b""       # its records, withheld until the whole message has passed the check

    def feed(self, data):
        """Returns (bytes safe to forward, None), or (b"", (reason, extra)) when the tunnel must be dropped."""
        self.buf += data
        out = bytearray()
        while len(self.buf) >= 5:
            rtype, vmaj, vmin = self.buf[0], self.buf[1], self.buf[2]
            rlen = (self.buf[3] << 8) | self.buf[4]
            if rtype not in (0x14, 0x15, 0x16, 0x17) or vmaj != 3 or vmin > 4:
                return b"", ("malformed:bad-record-header", "")
            if rlen > MAX_RECORD or (rlen == 0 and rtype != 0x17):
                return b"", ("malformed:bad-record-length", "")
            if len(self.buf) < 5 + rlen:
                break
            why = self._record(rtype, bytes(self.buf[5:5 + rlen]))
            if why:
                return b"", why
            rec = bytes(self.buf[:5 + rlen])
            del self.buf[:5 + rlen]
            if self.frag is not None:
                self.held += rec
            else:
                out += self.held + rec
                self.held = b""
        return bytes(out), None

    def _record(self, rtype, p):
        if self.frag is not None:
            if rtype != 0x16:
                return ("malformed:hello-interrupted", "")
            self.frag += p
            return self._frag_check()
        if rtype != 0x16 or not p or p[0] != 1:
            return None
        if len(p) >= 4 and int.from_bytes(p[1:4], "big") > 0xFFFF:
            return None  # not ClientHello-shaped (e.g. ciphertext that happens to start with 0x01)
        self.frag = bytearray(p)
        return self._frag_check()

    def _frag_check(self):
        f = self.frag
        if len(f) < 4:
            return None  # even the handshake header is split over records: wait for the rest
        n = int.from_bytes(f[1:4], "big")
        if n > 0xFFFF:
            return ("malformed:oversize", "")
        if len(f) < 4 + n:
            return None
        if len(f) > 4 + n:
            return ("malformed:trailing-bytes", "")
        self.frag = None
        status, info = _parse_body(bytes(f[4:]))
        if status == BAD:
            return ("malformed:" + info, "")
        hit = [t for t in info if t in BLOCKED_EXT]
        if hit:
            return ("ech", "ext=" + ",".join(f"0x{t:04x}" for t in hit))
        return None


class IdleTimeout(Exception):
    pass


async def read_active(reader, act):
    """reader.read(), but raises IdleTimeout when the tunnel (act[0] = last byte in either direction) has been silent too long."""
    loop = asyncio.get_running_loop()
    while True:
        try:
            data = await asyncio.wait_for(reader.read(65536), IDLE_CHECK)
        except asyncio.TimeoutError:
            if loop.time() - act[0] > IDLE_SECONDS:
                raise IdleTimeout()
            continue
        act[0] = loop.time()
        return data


def abort(*writers):
    for w in writers:
        try:
            w.transport.abort()
        except (OSError, AttributeError):
            pass


async def pump(src, dst, act, peer, target, cs=None):
    """Relay src -> dst. With cs set (client side) the bytes are checked as TLS records first."""
    try:
        while True:
            data = await read_active(src, act)
            if not data:
                break
            if cs is not None:
                data, why = cs.feed(data)
                if why:
                    log("drop", why[0], target, (why[1] + " " if why[1] else "") + "phase=after-first-hello")
                    abort(dst, peer)
                    return
            if data:
                dst.write(data)
                await dst.drain()
    except IdleTimeout:
        log("drop", "idle-timeout", target)
        abort(dst, peer)
        return
    except (ConnectionError, OSError, asyncio.CancelledError):
        pass
    try:
        if dst.can_write_eof():
            dst.write_eof()
    except (OSError, RuntimeError):
        pass


def close(*writers):
    for w in writers:
        try:
            w.close()
        except OSError:
            pass


sem = None


async def handle(creader, cwriter):
    target = "-"
    up_r = up_w = None
    if sem.locked():
        log("drop", "too-many-connections", target)
        return close(cwriter)
    async with sem:
        try:
            try:
                head, rest = await asyncio.wait_for(read_head(creader), HEAD_TIMEOUT)
            except (ValueError, asyncio.TimeoutError, ConnectionError, OSError) as e:
                log("drop", "bad-request-head:" + type(e).__name__, target)
                return
            m = CONNECT_RE.match(head)
            if not m:
                log("drop", "not-connect", target)
                return
            target = clean(head.split(b" ", 2)[1])
            try:
                up_r, up_w = await asyncio.open_connection(*UPSTREAM)
            except OSError:
                log("drop", "upstream-unavailable", target)
                return
            up_w.write(head)
            await up_w.drain()
            try:
                rhead, rrest = await asyncio.wait_for(read_head(up_r), UPSTREAM_TIMEOUT)
            except (ValueError, asyncio.TimeoutError, ConnectionError, OSError):
                cwriter.transport.abort()  # Squid reset or went away (a denied CONNECT): the client gets the same plain reset
                return
            cwriter.write(rhead + rrest)
            await cwriter.drain()
            if not rhead.startswith((b"HTTP/1.1 200", b"HTTP/1.0 200")):
                return  # refused by Squid; no tunnel, nothing to inspect
            # the tunnel is open: the first TLS bytes must be a clean ClientHello without ECH
            buf = rest
            deadline = asyncio.get_running_loop().time() + HELLO_TIMEOUT
            while True:
                status, info = parse_client_hello(buf)
                if status == BAD:
                    log("drop", "malformed:" + info, target, f"bytes={len(buf)}")
                    return
                if status == OK:
                    break
                left = deadline - asyncio.get_running_loop().time()
                if left <= 0:
                    log("drop", "hello-timeout", target, f"bytes={len(buf)}")
                    return
                try:
                    chunk = await asyncio.wait_for(creader.read(4096), left)
                except asyncio.TimeoutError:
                    log("drop", "hello-timeout", target, f"bytes={len(buf)}")
                    return
                if not chunk:
                    log("drop", "eof-before-hello", target, f"bytes={len(buf)}")
                    return
                buf += chunk
            hit = [t for t in info if t in BLOCKED_EXT]
            if hit:
                log("drop", "ech", target, "ext=" + ",".join(f"0x{t:04x}" for t in hit))
                return
            up_w.write(buf)
            await up_w.drain()
            act = [asyncio.get_running_loop().time()]
            await asyncio.gather(pump(creader, up_w, act, cwriter, target, ClientStream()), pump(up_r, cwriter, act, up_w, target))
        except (ConnectionError, OSError):
            pass
        finally:
            close(cwriter)
            if up_w is not None:
                close(up_w)


async def main():
    global sem
    sem = asyncio.Semaphore(MAX_CONNS)
    server = await asyncio.start_server(handle, *LISTEN, limit=65536)
    print(f"prefilter listening on {LISTEN[0]}:{LISTEN[1]} upstream {UPSTREAM[0]}:{UPSTREAM[1]}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
