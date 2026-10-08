import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** In-memory stand-in for the portal_login_failures table plus the two other tables login reads. */
const db = vi.hoisted(() => ({
  failures: [] as Array<{ id: string; kind: string; key: string; at: number }>,
  nextId: 1,
  /** Microtask yields before each query answers, so concurrent requests interleave. */
  yields: 0,
  physician: null as null | Record<string, unknown>,
  throwOnFailuresRead: false,
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    for (let y = 0; y < db.yields; y++) await Promise.resolve();
    const q = Array.from(strings).join("?");
    if (q.includes("account_failures")) {
      if (db.throwOnFailuresRead) throw new Error('relation "portal_login_failures" does not exist');
      const [a, , i] = values as [string, number, string, number];
      const since = Date.now() - 15 * 60 * 1000;
      const n = (kind: string, key: string) =>
        db.failures.filter((f) => f.kind === kind && f.key === key && f.at > since).length;
      return [{ account_failures: n("account", a), ip_failures: n("ip", i) }];
    }
    if (q.includes("INSERT INTO portal_login_failures")) {
      const [a, i] = values as [string, string];
      const rows = [
        { id: String(db.nextId++), kind: "account", key: a, at: Date.now() },
        { id: String(db.nextId++), kind: "ip", key: i, at: Date.now() },
      ];
      db.failures.push(...rows);
      return rows.map((r) => ({ id: r.id }));
    }
    if (q.includes("DELETE FROM portal_login_failures WHERE id = ANY")) {
      const [ids] = values as [string[]];
      db.failures = db.failures.filter((f) => !ids.includes(f.id));
      return [];
    }
    if (q.includes("DELETE FROM portal_login_failures")) return [];
    if (q.includes("FROM physicians")) return db.physician ? [db.physician] : [];
    if (q.includes("audit_log_v2")) return [];
    throw new Error(`unexpected query: ${q.slice(0, 80)}`);
  },
}));

vi.mock("@/lib/physician-auth", () => ({
  verifyPortalPin: vi.fn(async (pin: string) => {
    for (let y = 0; y < db.yields; y++) await Promise.resolve();
    return pin === "1234";
  }),
  createPhysicianToken: vi.fn(async () => "token"),
  setPhysicianCookie: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/portal/auth/login/route";
import { verifyPortalPin } from "@/lib/physician-auth";
import {
  ACCOUNT_FAILURE_LIMIT,
  IP_FAILURE_LIMIT,
  RATE_LIMIT_MESSAGE,
  clientIp,
  evaluateLoginLimit,
  hashLoginKey,
} from "@/lib/portal-login-limit";

function login(email: string, pin: string, ip = "203.0.113.7") {
  return POST(
    new NextRequest("https://doctors.test/api/portal/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
      body: JSON.stringify({ email, pin }),
    }),
  );
}

describe("evaluateLoginLimit (pure; counts include the current attempt)", () => {
  it("allows the 5th attempt per account and blocks the 6th", () => {
    expect(evaluateLoginLimit({ account: ACCOUNT_FAILURE_LIMIT, ip: 0 }).blocked).toBe(false);
    expect(evaluateLoginLimit({ account: ACCOUNT_FAILURE_LIMIT + 1, ip: 0 })).toEqual({ blocked: true, scope: "account" });
  });

  it("allows the 20th attempt per IP and blocks the 21st", () => {
    expect(evaluateLoginLimit({ account: 0, ip: IP_FAILURE_LIMIT }).blocked).toBe(false);
    expect(evaluateLoginLimit({ account: 0, ip: IP_FAILURE_LIMIT + 1 })).toEqual({ blocked: true, scope: "ip" });
  });

  it("hashes keys and separates the account and ip namespaces", () => {
    expect(hashLoginKey("account", "a@b.c")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLoginKey("account", "x")).not.toBe(hashLoginKey("ip", "x"));
    expect(hashLoginKey("account", "a@b.c")).not.toContain("a@b.c");
  });

  it("reads the first x-forwarded-for hop, then x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("POST /api/portal/auth/login rate limit (A3)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test";
    db.failures = [];
    db.throwOnFailuresRead = false;
    db.physician = {
      id: "p1",
      full_name: "Dr Example",
      email: "doc@example.test",
      portal_pin_hash: "hash",
      portal_access: true,
      portal_must_change_pin: false,
      current_status: "active",
    };
    vi.mocked(verifyPortalPin).mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the 6th attempt with 429 and a plain message, without checking the PIN", async () => {
    for (let n = 0; n < ACCOUNT_FAILURE_LIMIT; n++) {
      const res = await login("doc@example.test", "0000");
      expect(res.status).toBe(401);
    }
    vi.mocked(verifyPortalPin).mockClear();
    // Even the CORRECT pin is refused while locked: otherwise the lock does not stop guessing.
    const res = await login("doc@example.test", "1234");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: RATE_LIMIT_MESSAGE });
    expect(verifyPortalPin).not.toHaveBeenCalled();
  });

  it("lets the account in again once the 15-minute window has passed", async () => {
    for (let n = 0; n < ACCOUNT_FAILURE_LIMIT; n++) await login("doc@example.test", "0000");
    expect((await login("doc@example.test", "1234")).status).toBe(429);
    vi.setSystemTime(new Date("2026-10-08T10:16:00Z"));
    const res = await login("doc@example.test", "1234");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("a correct PIN succeeds but does NOT erase the failures already in the window", async () => {
    for (let n = 0; n < ACCOUNT_FAILURE_LIMIT - 1; n++) await login("doc@example.test", "0000");
    expect((await login("doc@example.test", "1234")).status).toBe(200);
    // Four failures stay on record; the success removed only its own attempt.
    expect(db.failures.filter((f) => f.kind === "account")).toHaveLength(ACCOUNT_FAILURE_LIMIT - 1);
    // So one more wrong PIN is tolerated (5th), and the next is refused (6th): history was kept.
    expect((await login("doc@example.test", "0000")).status).toBe(401);
    expect((await login("doc@example.test", "0000")).status).toBe(429);
  });

  it("a refused attempt leaves no row, so hammering a locked account does not extend the lock", async () => {
    for (let n = 0; n < ACCOUNT_FAILURE_LIMIT; n++) await login("doc@example.test", "0000");
    const before = db.failures.length;
    for (let n = 0; n < 10; n++) expect((await login("doc@example.test", "0000")).status).toBe(429);
    expect(db.failures).toHaveLength(before);
  });

  it("limits one IP to 20 failures across different accounts, and leaves other IPs alone", async () => {
    for (let n = 0; n < IP_FAILURE_LIMIT; n++) {
      db.physician = null; // unknown accounts still count as failed attempts
      const res = await login(`probe${n}@example.test`, "0000", "198.51.100.9");
      expect(res.status).toBe(401);
    }
    const blocked = await login("fresh@example.test", "0000", "198.51.100.9");
    expect(blocked.status).toBe(429);
    const other = await login("fresh@example.test", "0000", "198.51.100.10");
    expect(other.status).toBe(401);
  });

  it("does not count a request with missing fields", async () => {
    const res = await POST(
      new NextRequest("https://doctors.test/api/portal/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "doc@example.test" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(db.failures).toHaveLength(0);
  });

  it("stores digests, not the email or the IP", async () => {
    await login("Doc@Example.test", "0000", "203.0.113.7");
    expect(db.failures).toHaveLength(2);
    const dump = JSON.stringify(db.failures);
    expect(dump).not.toContain("example.test");
    expect(dump).not.toContain("203.0.113.7");
    expect(db.failures[0].key).toBe(hashLoginKey("account", "doc@example.test"));
  });

  it("fails open (and logs) when the table cannot be read, so a missing migration locks nobody out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.throwOnFailuresRead = true;
    const res = await login("doc@example.test", "1234");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("parallel attempts cannot slip past the limit (insert first, then count)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test";
    db.failures = [];
    db.nextId = 1;
    db.throwOnFailuresRead = false;
    db.physician = {
      id: "p1",
      full_name: "Dr Example",
      email: "doc@example.test",
      portal_pin_hash: "hash",
      portal_access: true,
      portal_must_change_pin: false,
      current_status: "active",
    };
    vi.mocked(verifyPortalPin).mockClear();
  });
  afterEach(() => {
    db.yields = 0;
  });

  for (const yields of [0, 1, 3, 7]) {
    it(`200 concurrent wrong-PIN requests for one account: at most 5 PINs are ever tested (yields=${yields})`, async () => {
      db.yields = yields;
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, n) => login("doc@example.test", String(1000 + n), `198.51.100.${n % 250}`)),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(ACCOUNT_FAILURE_LIMIT);
      expect(vi.mocked(verifyPortalPin).mock.calls.length).toBeLessThanOrEqual(ACCOUNT_FAILURE_LIMIT);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(200 - ACCOUNT_FAILURE_LIMIT);
    });
  }

  it("200 concurrent requests from one IP across different accounts: at most 20 get an answer other than 429", async () => {
    db.yields = 2;
    db.physician = null; // unknown accounts: each is a failed attempt that never reaches bcrypt
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, n) => login(`probe${n}@example.test`, "0000", "198.51.100.9")),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(IP_FAILURE_LIMIT);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(200 - IP_FAILURE_LIMIT);
  });

  it("the route records the attempt before it verifies the PIN", async () => {
    const order: string[] = [];
    vi.mocked(verifyPortalPin).mockImplementationOnce(async () => {
      order.push(`verify (rows on record: ${db.failures.length})`);
      return false;
    });
    await login("doc@example.test", "0000");
    expect(order).toEqual(["verify (rows on record: 2)"]);
  });

  it("the route source calls beginLoginAttempt before verifyPortalPin", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/portal/auth/login/route.ts"), "utf8");
    expect(src.indexOf("beginLoginAttempt(")).toBeGreaterThan(0);
    expect(src.indexOf("beginLoginAttempt(")).toBeLessThan(src.indexOf("verifyPortalPin(String"));
  });
});

describe("migration 034", () => {
  it("is appended after 033 and is idempotent DDL", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/migrations.ts"), "utf8");
    const at034 = src.indexOf('id: "034_portal_login_failures"');
    expect(at034).toBeGreaterThan(src.indexOf('id: "033_gov_ot_tracking_sheets"'));
    const block = src.slice(at034);
    expect(block).toContain("CREATE TABLE IF NOT EXISTS portal_login_failures");
    expect(block).toContain("CREATE INDEX IF NOT EXISTS idx_portal_login_failures_lookup");
  });
});
