#!/usr/bin/env python3
"""Synthetic-byte tests for studio-ech-prefilter.py (no network except loopback). Also usable as a client:

  test_prefilter.py client PORT TARGET KIND     # CONNECT TARGET via 127.0.0.1:PORT, send a synthetic hello of KIND, print the outcome
KIND: plain | ech | ech-draft02 | ech-draftff02 | garbage | oversize | truncated | dup | fragmented | noext
Outcomes: "dropped" (connection closed with no TLS reply), "reply:<first byte hex>" (the far side answered), "refused".
"""
import importlib.util
import os
import socket
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("prefilter", os.path.join(HERE, "studio-ech-prefilter.py"))
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)


def ext(t, data=b""):
    return struct.pack(">HH", t, len(data)) + data


def sni_ext(name):
    n = name.encode()
    return ext(0, struct.pack(">HBH", len(n) + 3, 0, len(n)) + n)


def hello_body(exts, session=b"\x01" * 32, compression=b"\x00"):
    suites = b"\x13\x01\x13\x02\xc0\x2f\x00\xff"
    b = b"\x03\x03" + b"\x42" * 32 + bytes([len(session)]) + session
    b += struct.pack(">H", len(suites)) + suites + bytes([len(compression)]) + compression
    if exts is not None:
        e = b"".join(exts)
        b += struct.pack(">H", len(e)) + e
    return b


def handshake(body):
    return b"\x01" + len(body).to_bytes(3, "big") + body


def record(payload, minor=1):
    return b"\x16\x03" + bytes([minor]) + struct.pack(">H", len(payload)) + payload


def make(kind, host="api.typesafe.ai"):
    sni = sni_ext(host)
    sv = ext(43, b"\x02\x03\x04")
    if kind == "plain":
        return record(handshake(hello_body([sni, sv, ext(10, b"\x00\x02\x00\x1d")])))
    if kind == "noext":
        return record(handshake(hello_body(None)))
    if kind == "ech":  # a GREASE-shaped ECH extension: outer type 0, config_id, 32-byte enc, payload
        return record(handshake(hello_body([sni, sv, ext(0xFE0D, b"\x00\x00\x01\x00\x01\xb7\x00\x20" + b"\x07" * 32 + b"\x00\xa0" + b"\x09" * 160)])))
    if kind == "ech-draft02":
        return record(handshake(hello_body([sni, ext(0xFE02, b"\x01\x02")])))
    if kind == "ech-draftff02":
        return record(handshake(hello_body([ext(0xFF02, b"\x01\x02"), sni])))
    if kind == "garbage":
        return b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"
    if kind == "oversize":
        return record(handshake(hello_body([sni, ext(21, b"\x00" * 20000)]))[:16384]) + record(b"\x00" * 16384)
    if kind == "truncated":
        return record(handshake(hello_body([sni, sv])))[:-7]
    if kind == "dup":
        return record(handshake(hello_body([sni, sni])))
    if kind == "fragmented":  # one hello split over two records, ECH in the second half
        hs = handshake(hello_body([sni, sv, ext(0xFE0D, b"\x00" * 40)]))
        return record(hs[:30]) + record(hs[30:])
    raise SystemExit("unknown kind " + kind)


class Parse(unittest.TestCase):
    def ok(self, data, has=None):
        st, info = pf.parse_client_hello(data)
        self.assertEqual(st, pf.OK, info)
        if has is not None:
            self.assertEqual(sorted(info), sorted(has))

    def bad(self, data, why=None):
        st, info = pf.parse_client_hello(data)
        self.assertEqual(st, pf.BAD, info)
        if why:
            self.assertEqual(info, why)

    def test_plain_ok(self):
        self.ok(make("plain"), [0, 43, 10])

    def test_no_extensions_ok(self):
        self.ok(make("noext"), [])

    def test_ech_types_found(self):
        for k, t in (("ech", 0xFE0D), ("ech-draft02", 0xFE02), ("ech-draftff02", 0xFF02)):
            st, info = pf.parse_client_hello(make(k))
            self.assertEqual(st, pf.OK)
            self.assertIn(t, info)
            self.assertTrue([x for x in info if x in pf.BLOCKED_EXT])

    def test_fragmented_ech_found(self):
        st, info = pf.parse_client_hello(make("fragmented"))
        self.assertEqual(st, pf.OK)
        self.assertIn(0xFE0D, info)

    def test_every_prefix_is_need_more_or_bad_never_ok(self):
        full = make("plain")
        for n in range(len(full)):
            st, _ = pf.parse_client_hello(full[:n])
            self.assertNotEqual(st, pf.OK, n)

    def test_malformed(self):
        self.bad(make("garbage"), "not-handshake-record")
        self.bad(make("dup"), "duplicate-extension")
        self.bad(make("oversize"))
        self.bad(make("plain") + b"\x00", "trailing-bytes")
        self.bad(b"\x16\x03\x01\x00\x00", "bad-record-length")
        self.bad(b"\x16\x02\x01\x00\x10" + b"\x00" * 16, "bad-record-version")
        self.bad(record(b"\x02\x00\x00\x00"), "not-client-hello")
        # extensions block length that disagrees with the hello length
        body = hello_body([sni_ext("a.b")])
        self.bad(record(handshake(body + b"\x00")))
        # extension that overruns its block
        e = struct.pack(">HH", 0, 50) + b"x" * 5
        self.bad(record(handshake(hello_body(None) + struct.pack(">H", len(e)) + e)), "extension-overruns")
        # session id longer than 32
        self.bad(record(handshake(b"\x03\x03" + b"\x00" * 32 + b"\x40" + b"\x00" * 80)), "bad-session-id")

    def test_hello_length_over_cap(self):
        self.bad(b"\x16\x03\x01\x40\x01" + b"\x01\xff\xff\xff" + b"\x00" * 100, None)


def client(port, target, kind):
    s = socket.create_connection(("127.0.0.1", port), timeout=20)
    s.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    head = b""
    try:
        while b"\r\n\r\n" not in head:
            c = s.recv(4096)
            if not c:
                print("refused")
                return 3
            head += c
    except (ConnectionError, socket.timeout):
        print("refused")
        return 3
    if b" 200" not in head.split(b"\r\n")[0]:
        print("refused")
        return 3
    try:
        s.sendall(make(kind, target.split(":")[0]))
        d = s.recv(4096)
    except (ConnectionError, socket.timeout):
        d = b""
    print("reply:%02x" % d[0] if d else "dropped")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "client":
        sys.exit(client(int(sys.argv[2]), sys.argv[3], sys.argv[4]))
    unittest.main()
