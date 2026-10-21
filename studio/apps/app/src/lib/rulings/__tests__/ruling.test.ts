// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { forwardRuling } from "../forward";
import { allowedRulingActions, parseRulingBody } from "../model";
import { POST } from "@/app/api/audit-findings/[reference]/ruling/route";

const REF = "EHRC-AUD-2026-0001";
const ok = async () => true;
const mk = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("ruling model", () => {
  it("mirrors the allowed actions per status", () => {
    expect(allowedRulingActions("closed")).toEqual([]);
    expect(allowedRulingActions("ruled")).toEqual(["privilege_action", "closed", "dismissed"]);
    expect(allowedRulingActions("escalated")).toHaveLength(4);
  });
  it.each([null, [], {}, { action: "closed" }, { action: "closed", note: "ab" }, { action: "delete", note: "valid note" }, { action: "closed", note: "valid note", x: 1 }, { action: "closed", note: "x".repeat(2001) }])("refuses %j", (b) => {
    expect(parseRulingBody(b).ok).toBe(false);
  });
  it("trims the note", () => expect(parseRulingBody({ action: "closed", note: "  fine  " })).toEqual({ ok: true, action: "closed", note: "fine" }));
});

describe("forwardRuling", () => {
  const base = { reference: REF, rawBody: { action: "dismissed", note: "not applicable" }, sessionCookie: "tok", base: "https://gov.invalid" };
  it("refuses without the second factor: nothing is forwarded (default verifier refuses)", async () => {
    const f = mk(200);
    expect(await forwardRuling({ ...base, fetchImpl: f as unknown as typeof fetch })).toEqual({ status: 403, body: { ok: false, error: "second_factor_required" } });
    expect(f).not.toHaveBeenCalled();
  });
  it("forwards to the existing even-elo route with the user's session cookie and only action+note", async () => {
    const f = mk(200, { ok: true, replayed: false, status: "closed", intervention_id: "secret-id" });
    const out = await forwardRuling({ ...base, secondFactor: ok, fetchImpl: f as unknown as typeof fetch });
    expect(out).toEqual({ status: 200, body: { ok: true, replayed: false, status: "closed" } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://gov.invalid/api/audit-findings/${REF}/ruling`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Cookie).toBe("epi_session=tok");
    expect(JSON.parse(String(init.body))).toEqual({ action: "dismissed", note: "not applicable" });
    expect(init.redirect).toBe("error");
  });
  it("validates before forwarding", async () => {
    const f = mk(200);
    for (const [patch, status] of [[{ reference: "../x" }, 400], [{ sessionCookie: null }, 401], [{ rawBody: { action: "closed" } }, 422]] as const) {
      expect((await forwardRuling({ ...base, ...patch, secondFactor: ok, fetchImpl: f as unknown as typeof fetch })).status).toBe(status);
    }
    expect(f).not.toHaveBeenCalled();
  });
  it.each([[409, 409, "conflict"], [401, 401, "unauthorized"], [403, 403, "forbidden"], [404, 404, "not_found"], [502, 502, "cdmss_unconfirmed"], [500, 502, "cdmss_unconfirmed"]])("maps upstream %i to fixed code", async (up, status, error) => {
    const out = await forwardRuling({ ...base, secondFactor: ok, fetchImpl: mk(up, { message: "UPSTREAM-TEXT" }) as unknown as typeof fetch });
    expect(out.status).toBe(status);
    expect(out.body.error).toBe(error);
    expect(JSON.stringify(out.body)).not.toContain("UPSTREAM");
  });
  it("transport failure is 502", async () => {
    const f = vi.fn(async () => { throw new Error("x"); });
    expect((await forwardRuling({ ...base, secondFactor: ok, fetchImpl: f as unknown as typeof fetch })).body.error).toBe("upstream_unreachable");
  });
});

describe("ruling route", () => {
  const call = (headers: Record<string, string>) =>
    POST(new NextRequest(`https://governance.evenos.app/studio/api/audit-findings/${REF}/ruling`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ action: "closed", note: "done here" }) }), { params: Promise.resolve({ reference: REF }) });
  it("401 without the proxy's actor headers", async () => expect((await call({ Cookie: "epi_session=t" })).status).toBe(401));
  it("403 second_factor_required today: the confirm path is closed", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await call({ "studio-internal-staff-id": "s", "studio-internal-staff-role": "super_admin", Cookie: "epi_session=t" });
    vi.unstubAllGlobals();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "second_factor_required" });
    expect(f).not.toHaveBeenCalled();
  });
});
