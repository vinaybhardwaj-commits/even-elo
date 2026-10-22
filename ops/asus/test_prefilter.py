#!/usr/bin/env python3
"""Synthetic-byte tests for studio-ech-prefilter.py (no network except loopback). Also usable as a client:

  test_prefilter.py client PORT TARGET KIND     # CONNECT TARGET via 127.0.0.1:PORT, send a synthetic hello of KIND, print the outcome
KIND: hrr-ech (clean hello, the far side's answer, then a second hello with ECH) | plain | ech | ech-draft02 | ech-draftff02 | garbage | oversize | truncated | dup | fragmented | noext
Outcomes: "dropped" (connection closed with no TLS reply), "reply:<first byte hex>" (the far side answered), "refused".
"""
import asyncio
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


HRR_RANDOM = bytes.fromhex("cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c")


def hrr_record():
    """A server HelloRetryRequest: ServerHello with the fixed HRR random, supported_versions 1.3 and a key_share selected group."""
    exts = ext(43, b"\x03\x04") + ext(51, b"\x00\x1d")
    body = b"\x03\x03" + HRR_RANDOM + b"\x20" + b"\x01" * 32 + b"\x13\x01" + b"\x00" + struct.pack(">H", len(exts)) + exts
    return record(b"\x02" + len(body).to_bytes(3, "big") + body)


CCS = b"\x14\x03\x03\x00\x01\x01"


class Stream(unittest.TestCase):
    """What the filter does with client bytes AFTER the first ClientHello (HelloRetryRequest second hello, pipelined hellos)."""

    def feed(self, *chunks):
        cs, out = pf.ClientStream(), b""
        for c in chunks:
            o, why = cs.feed(c)
            if why:
                return out, why
            out += o
        return out, None

    def test_clean_second_hello_passes_byte_for_byte(self):
        data = CCS + make("plain")
        out, why = self.feed(data)
        self.assertIsNone(why)
        self.assertEqual(out, data)

    def test_second_hello_with_ech_after_hrr_is_dropped(self):
        for k in ("ech", "ech-draft02", "ech-draftff02", "fragmented"):
            out, why = self.feed(CCS + make(k))
            self.assertEqual(why[0], "ech", k)
            self.assertNotIn(b"\x16", out[:0] or b"")  # nothing of the hello was released
            self.assertEqual(out, b"", k)

    def test_second_hello_split_over_tcp_segments_and_records(self):
        full = CCS + make("ech")
        for cut in (3, 7, 12, 40, len(full) - 1):
            out, why = self.feed(full[:cut], full[cut:])
            self.assertEqual(why[0] if why else None, "ech", cut)
        frag = make("fragmented")
        out, why = self.feed(frag[:20], frag[20:])
        self.assertEqual(why[0], "ech")

    def test_first_half_of_a_split_hello_is_withheld_until_the_whole_passes(self):
        hs = handshake(hello_body([sni_ext("api.typesafe.ai"), ext(0xFE0D, b"\x00" * 40)]))
        recs = record(hs[:30]) + record(hs[30:])
        cs = pf.ClientStream()
        o, why = cs.feed(recs[: 5 + 30])
        self.assertEqual((o, why), (b"", None))
        o, why = cs.feed(recs[5 + 30:])
        self.assertEqual((o, why[0]), (b"", "ech"))

    def test_malformed_second_hello_and_bad_records_dropped(self):
        self.assertEqual(self.feed(make("dup"))[1][0], "malformed:duplicate-extension")
        self.assertEqual(self.feed(b"GET / HTTP/1.1\r\n\r\n")[1][0], "malformed:bad-record-header")
        self.assertEqual(self.feed(b"\x17\x03\x03\xff\xff")[1][0], "malformed:bad-record-length")
        self.assertEqual(self.feed(make("plain") + b"\x00" * 5)[1][0], "malformed:bad-record-header")
        self.assertEqual(self.feed(record(handshake(hello_body([sni_ext("a")])) + b"\x00"))[1][0], "malformed:trailing-bytes")

    def test_application_data_ccs_and_non_hello_handshakes_pass(self):
        app = b"\x17\x03\x03" + struct.pack(">H", 100) + b"\x01" * 100
        done = record(b"\x14\x00\x00\x0c" + b"\x07" * 12)           # a plaintext Finished-shaped handshake message
        cke = record(b"\x10\x00\x00\x42" + b"\x05" * 0x42)           # ClientKeyExchange
        cipher_like = b"\x16\x03\x03" + struct.pack(">H", 40) + b"\x01\xff\xff\xff" + b"\x09" * 36   # ciphertext starting 0x01 with a huge "length"
        data = CCS + app + done + cke + cipher_like + app
        out, why = self.feed(data)
        self.assertIsNone(why)
        self.assertEqual(out, data)

    def test_first_hello_may_not_use_more_than_eight_records(self):
        hs = handshake(hello_body([sni_ext("api.typesafe.ai")]))
        recs = b"".join(record(hs[i:i + 8]) for i in range(0, len(hs), 8))
        self.assertGreater(len(recs) // 13, pf.MAX_FIRST_RECORDS)
        self.assertEqual(pf.parse_client_hello(recs), (pf.BAD, "too-many-records"))
        two = record(hs[:30]) + record(hs[30:])
        self.assertEqual(pf.parse_client_hello(two)[0], pf.OK)


class Live(unittest.IsolatedAsyncioTestCase):
    """The filter in-process between a client and a stub 'squid' that answers CONNECT with 200 and then plays a TLS server."""

    async def asyncSetUp(self):
        self.saved = (pf.UPSTREAM, pf.sem, pf.IDLE_SECONDS, pf.IDLE_CHECK)
        self.rx = []
        self.stub_conns = []
        self.hrr = False
        self.stub = await asyncio.start_server(self._stub, "127.0.0.1", 0)
        pf.UPSTREAM = ("127.0.0.1", self.stub.sockets[0].getsockname()[1])
        pf.sem = asyncio.Semaphore(4)
        self.srv = await asyncio.start_server(pf.handle, "127.0.0.1", 0)
        self.port = self.srv.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.srv.close()
        self.stub.close()
        pf.UPSTREAM, pf.sem, pf.IDLE_SECONDS, pf.IDLE_CHECK = self.saved

    async def _stub(self, r, w):
        self.stub_conns.append(w)
        await r.readuntil(b"\r\n\r\n")
        w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        first = True
        try:
            while True:
                d = await r.read(65536)
                if not d:
                    break
                self.rx.append(d)
                if first and self.hrr:
                    w.write(hrr_record())
                first = False
        except ConnectionError:
            pass

    async def open(self, target="api.typesafe.ai:443"):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
        self.assertTrue(head.startswith(b"HTTP/1.1 200"))
        return r, w

    async def closed(self, r, within=5):
        try:
            return await asyncio.wait_for(r.read(65536), within) == b""
        except ConnectionError:
            return True

    async def test_ch1_clean_hrr_ch2_with_ech_is_dropped_and_never_reaches_the_server(self):
        self.hrr = True
        r, w = await self.open()
        ch1 = make("plain")
        w.write(ch1)
        got = await asyncio.wait_for(r.readexactly(len(hrr_record())), 5)
        self.assertEqual(got, hrr_record())          # CH1 and the HRR crossed untouched
        w.write(CCS + make("ech"))
        self.assertTrue(await self.closed(r))
        await asyncio.sleep(0.2)
        self.assertEqual(b"".join(self.rx), ch1)      # the stub server never saw CH2

    async def test_ch1_clean_hrr_ch2_clean_passes_byte_for_byte(self):
        self.hrr = True
        r, w = await self.open()
        ch1, ch2 = make("plain"), CCS + make("plain")
        w.write(ch1)
        await asyncio.wait_for(r.readexactly(len(hrr_record())), 5)
        w.write(ch2)
        await asyncio.sleep(0.3)
        self.assertEqual(b"".join(self.rx), ch1 + ch2)
        w.close()

    async def test_second_hello_pipelined_behind_the_first_without_waiting_for_the_server(self):
        r, w = await self.open()
        ch1 = make("plain")
        w.write(ch1)
        await asyncio.sleep(0.2)
        w.write(make("ech"))
        self.assertTrue(await self.closed(r))
        self.assertEqual(b"".join(self.rx), ch1)

    async def test_idle_tunnel_is_closed_and_frees_its_slot(self):
        pf.IDLE_SECONDS, pf.IDLE_CHECK = 0.6, 0.1
        pf.sem = asyncio.Semaphore(2)
        a = await self.open()
        a[1].write(make("plain"))
        b = await self.open()
        b[1].write(make("plain"))
        await asyncio.sleep(0.2)
        # both slots are held by idle tunnels: a third connection is refused at once
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"CONNECT api.typesafe.ai:443 HTTP/1.1\r\n\r\n")
        self.assertTrue(await self.closed(r, 2))
        # after the idle timeout both are closed by the filter and a new tunnel gets a slot
        self.assertTrue(await self.closed(a[0], 4))
        self.assertTrue(await self.closed(b[0], 4))
        c = await self.open()
        c[1].close()

    async def test_traffic_in_either_direction_keeps_a_tunnel_alive(self):
        pf.IDLE_SECONDS, pf.IDLE_CHECK = 0.6, 0.1
        r, w = await self.open()
        w.write(make("plain"))
        for _ in range(8):                      # 1.6 s with a byte every 0.2 s: longer than IDLE_SECONDS
            await asyncio.sleep(0.2)
            w.write(b"\x17\x03\x03\x00\x01\x00")
        await asyncio.sleep(0.3)
        self.assertEqual(len(b"".join(self.rx)), len(make("plain")) + 8 * 6)
        w.close()


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
        if kind == "hrr-ech":  # clean hello, wait for whatever the far side answers, then a second hello carrying ECH
            s.sendall(make("plain", target.split(":")[0]))
            if not s.recv(4096):
                print("dropped")
                return 0
            s.sendall(make("ech", target.split(":")[0]))
            d = s.recv(4096)
            print("reply:%02x" % d[0] if d else "dropped-after-first-reply")
            return 0
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
