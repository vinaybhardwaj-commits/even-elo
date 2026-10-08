import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EVENTS, REF, fakeSql, json, signalObject, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));

import { POST } from "@/app/api/audit-findings/[reference]/ruling/route";
import { parseRulingBody, rulingKey } from "@/lib/audit-ruling";

interface Row {
  id: string;
  key: string;
  action: string;
  note: string;
  state: string;
  error: string | null;
}

let rows: Map<string, Row>;
let audits: Array<{ action: string; entity: string }>;
let inserts: number;
let cdmssStatus: string; // the thread's CURRENT status as CDMSS holds it
let signalActionCalls: Array<Record<string, unknown>>;
let signalActionMode: "ok" | "replay" | "conflict" | "down" | "bad_request";
const fetchMock = vi.fn();

function installSql() {
  h.sql = fakeSql((text, v) => {
    if (text.includes("FROM physicians WHERE cdmss_doctor_uid IS NOT NULL")) {
      return [{ id: "p-1", full_name: "Asha Rao", cdmss_doctor_uid: "D-100", cdmss_alias_uids: null }];
    }
    if (text.includes("INSERT INTO gov_interventions")) {
      inserts += 1;
      const key = String(v[6]);
      if (rows.has(key)) return [];
      const row: Row = { id: `iv-${rows.size + 1}`, key, action: String(v[5]), note: String(v[2]), state: "pending", error: null };
      rows.set(key, row);
      return [{ id: row.id }];
    }
    if (text.includes("FROM gov_interventions WHERE idempotency_key")) {
      const r = rows.get(String(v[0]));
      return r ? [{ id: r.id, cdmss_sync_state: r.state }] : [];
    }
    if (text.includes("SET cdmss_sync_state = 'synced'")) {
      for (const r of Array.from(rows.values())) if (r.id === v[0]) r.state = "synced";
      return [];
    }
    if (text.includes("SET cdmss_sync_error")) {
      for (const r of Array.from(rows.values())) if (r.id === v[1]) r.error = String(v[0]);
      return [];
    }
    if (text.includes("DELETE FROM gov_interventions")) {
      for (const [k, r] of Array.from(rows.entries())) if (r.id === v[0] && r.state !== "synced") rows.delete(k);
      return [];
    }
    if (text.includes("INSERT INTO audit_log_v2")) {
      audits.push({ action: String(v[1]), entity: String(v[2]) });
      return [];
    }
    return [];
  });
}

beforeEach(() => {
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  rows = new Map();
  audits = [];
  inserts = 0;
  cdmssStatus = "escalated";
  signalActionCalls = [];
  signalActionMode = "ok";
  h.user = staff.smh;
  installSql();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    const s = String(u);
    if (s.includes("/audit-signal/")) {
      return json(200, { ok: true, signal: signalObject({ status: cdmssStatus }), instances: [], events: EVENTS });
    }
    if (s.includes("/signal-action")) {
      const body = JSON.parse(String(init?.body));
      signalActionCalls.push(body);
      if (signalActionMode === "down") throw new Error("network down");
      if (signalActionMode === "conflict") return json(409, { ok: false, error: "signal is closed; closed is not allowed" });
      if (signalActionMode === "bad_request") return json(400, { ok: false, error: "action must be one of x" });
      return json(200, {
        ok: true,
        replayed: signalActionMode === "replay",
        status: "closed",
        signal: signalObject({ status: "closed", ruling: { action: body.action, note: body.note, actor: body.actor, gov_intervention_ref: body.gov_intervention_ref } }),
      });
    }
    return json(404, { ok: false });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const rule = (body: unknown) =>
  POST(
    new NextRequest(`https://governance.test/api/audit-findings/${REF}/ruling`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { reference: REF } },
  );

describe("ruling body", () => {
  it("requires a real action and a note, and refuses unknown fields", () => {
    expect(parseRulingBody({ action: "closed", note: "ok" }).ok).toBe(false); // 2 characters
    expect(parseRulingBody({ action: "closed", note: "   " }).ok).toBe(false);
    expect(parseRulingBody({ action: "nuke", note: "long enough" }).ok).toBe(false);
    expect(parseRulingBody({ action: "closed", note: "long enough", actor: "someone-else" }).ok).toBe(false);
    expect(parseRulingBody(null).ok).toBe(false);
    expect(parseRulingBody({ action: "dismissed", note: "  Not our patient.  " })).toEqual({ ok: true, action: "dismissed", note: "Not our patient." });
  });

  it("keys a decision by thread and action", () => {
    expect(rulingKey(REF, "closed")).toBe(`${REF}|closed`);
    expect(rulingKey(REF, "closed")).not.toBe(rulingKey(REF, "dismissed"));
  });
});

describe("ruling flow", () => {
  it("records one gov_interventions row first, then sends its id to signal-action with the actor and note", async () => {
    const res = await rule({ action: "acknowledged_by_governance", note: "Reviewed with the doctor." });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, replayed: false });
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.state).toBe("synced");
    expect(row.note).toContain("Reviewed with the doctor.");
    expect(signalActionCalls).toHaveLength(1);
    expect(signalActionCalls[0]).toMatchObject({
      reference: REF,
      action: "acknowledged_by_governance",
      note: "Reviewed with the doctor.",
      actor: "gov:benita@even.in",
      gov_intervention_ref: row.id,
    });
    // The row was written BEFORE the CDMSS call.
    const sqlOrder = (h.sql as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder;
    const signalActionOrder = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.findIndex((c) => String(c[0]).includes("/signal-action"))];
    expect(Math.min(...sqlOrder.slice(0, 3))).toBeLessThan(signalActionOrder);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling"]);
  });

  it("a repeat press reuses the same row and the same reference; CDMSS answers 200 replayed, shown as success", async () => {
    const first = await rule({ action: "closed", note: "Resolved with the doctor." });
    expect(first.status).toBe(200);
    signalActionMode = "replay";
    const second = await rule({ action: "closed", note: "Resolved with the doctor." });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, replayed: true });
    expect(rows.size).toBe(1);
    expect(signalActionCalls).toHaveLength(2);
    expect(signalActionCalls[1].gov_intervention_ref).toBe(signalActionCalls[0].gov_intervention_ref);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling"]); // the replay is not audited as a second ruling
  });

  it("a different note on a retry does not create a second row (the first decision stands)", async () => {
    await rule({ action: "closed", note: "First reason." });
    signalActionMode = "replay";
    await rule({ action: "closed", note: "Second reason, typed later." });
    expect(rows.size).toBe(1);
    expect(Array.from(rows.values())[0].note).toContain("First reason.");
  });

  it("two different actions on one thread are two decisions", async () => {
    await rule({ action: "acknowledged_by_governance", note: "Seen." });
    await rule({ action: "closed", note: "Finished." });
    expect(rows.size).toBe(2);
  });

  it("when CDMSS is unreachable the decision stays saved as pending, answers 502, and the retry is the SAME row", async () => {
    signalActionMode = "down";
    const failed = await rule({ action: "privilege_action", note: "Refer for review." });
    expect(failed.status).toBe(502);
    const fb = await failed.json();
    expect(fb.error).toBe("unavailable");
    expect(fb.message).toMatch(/will not be recorded twice/);
    expect(rows.size).toBe(1);
    const row = Array.from(rows.values())[0];
    expect(row.state).toBe("pending");
    expect(row.error).toBe("transport");

    signalActionMode = "ok";
    const retried = await rule({ action: "privilege_action", note: "Refer for review." });
    expect(retried.status).toBe(200);
    expect(rows.size).toBe(1);
    expect(inserts).toBe(2); // the second INSERT hit the unique key and returned nothing
    expect(signalActionCalls[1].gov_intervention_ref).toBe(signalActionCalls[0].gov_intervention_ref);
    expect(Array.from(rows.values())[0].state).toBe("synced");
  });

  it("409 from CDMSS: answers 409 with the CURRENT status, offers only what is still allowed, and removes the attempt's row", async () => {
    signalActionMode = "conflict";
    cdmssStatus = "closed"; // someone closed it first
    const res = await rule({ action: "acknowledged_by_governance", note: "Seen." });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "conflict", current_status: "closed", actions: [] });
    expect(body.message).toMatch(/changed since you opened it/);
    expect(rows.size).toBe(0);
    expect(audits.map((a) => a.action)).toEqual(["audit_ruling_refused"]);
  });

  it("409 on a thread that moved to 'ruled' still offers the actions allowed there", async () => {
    signalActionMode = "conflict";
    cdmssStatus = "ruled";
    const body = await (await rule({ action: "acknowledged_by_governance", note: "Seen." })).json();
    expect(body.current_status).toBe("ruled");
    expect(body.actions.map((a: { action: string }) => a.action)).toEqual(["privilege_action", "closed", "dismissed"]);
  });

  it("a 409 never deletes a row CDMSS already confirmed", async () => {
    await rule({ action: "closed", note: "Resolved." });
    expect(Array.from(rows.values())[0].state).toBe("synced");
    signalActionMode = "conflict";
    await rule({ action: "closed", note: "Resolved." });
    expect(rows.size).toBe(1);
  });

  it("passes a CDMSS 400 back as a 400 with its words, and leaves no row", async () => {
    signalActionMode = "bad_request";
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/action must be one of/);
    expect(rows.size).toBe(0);
  });

  it("refuses a missing note, an unknown action and an extra field before touching anything", async () => {
    for (const bad of [{ action: "closed" }, { action: "closed", note: " " }, { action: "erase", note: "long enough" }, { action: "closed", note: "long enough", actor: "x" }]) {
      const res = await rule(bad);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts).toBe(0);
  });

  it("404s a thread CDMSS does not know, with nothing recorded", async () => {
    fetchMock.mockImplementation(async () => json(404, { ok: false, error: "unknown reference" }));
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(404);
    expect(inserts).toBe(0);
  });

  it("does not send anything to CDMSS when the decision cannot be recorded", async () => {
    h.sql = fakeSql((text) => {
      if (text.includes("FROM physicians")) return [];
      if (text.includes("INSERT INTO gov_interventions")) throw new Error("db down");
      return [];
    });
    const res = await rule({ action: "closed", note: "Resolved." });
    expect(res.status).toBe(502);
    expect(signalActionCalls).toHaveLength(0);
  });
});
