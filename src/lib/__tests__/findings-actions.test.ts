import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  catErrorText,
  mapReactOutcome,
  mapRespondOutcome,
  normalizeComment,
  parseReactBody,
  parseRespondBody,
  COMMENT_MAX,
  type CatOutcome,
} from "../findings-actions";
import {
  normalizeReactions,
  toPortalPayload,
  toPortalSignal,
  type DoctorAuditSignal,
  type DoctorAuditsUpstream,
} from "../doctor-audits";

/**
 * WM2 v1 — reactions and responses on Findings.
 *
 * Two kinds of test here, and the split is deliberate. The mapping and the body rules are PURE, so
 * they are tested by calling them. The route and component guarantees — "the client's identity
 * fields are never read", "the flag hides both rows" — have no harness in this repo (no vitest
 * config, so no `@/` alias for a route import; no jsdom, so no render), and they are checked by
 * reading the source instead. A source check is weaker than a render, and it is written to fail
 * loudly if the shape it depends on is refactored away, rather than to pass quietly.
 */

const SRC = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const REACT_ROUTE = "src/app/api/portal/findings/react/route.ts";
const RESPOND_ROUTE = "src/app/api/portal/findings/respond/route.ts";
const FINDINGS_ROUTE = "src/app/api/portal/findings/route.ts";
const CARD = "src/components/portal/FindingsForDoctor.tsx";

const http = (status: number, body: unknown): CatOutcome => ({ kind: "http", status, body });
const transport: CatOutcome = { kind: "transport" };

function signal(over: Partial<DoctorAuditSignal> = {}): DoctorAuditSignal {
  return {
    reference: "EHRC-AUD-2026-0001",
    signal_id: "sig-1",
    doctor_uid: "cdmss-uid-must-never-ship",
    signal_type: "documentation",
    label: "Incomplete assessment",
    importance: "high",
    response_required: "explanation",
    status: "routed",
    overdue: true,
    instances: 3,
    window: { from: "2026-08-01", to: "2026-08-31" },
    representative: null,
    routed_at: "2026-09-01T00:00:00Z",
    sla_due_at: "2026-09-08T00:00:00Z",
    response: null,
    ruling: { by: "council" },
    ...over,
  };
}

function upstream(signals: DoctorAuditSignal[]): DoctorAuditsUpstream {
  return {
    ok: true,
    doctor: { uid: "cdmss-uid-must-never-ship", name: "Dr A", speciality: "Cardiology" },
    window: { days: 90 },
    metrics: { audit: { score: 71 }, operational: { late: 4 } },
    signals,
    advisory: "",
  };
}

describe("toPortalPayload: the strip still holds, and now carries my_reaction", () => {
  it("drops overdue, sla_due_at and doctor_uid from every signal", () => {
    const out = toPortalPayload(upstream([signal(), signal({ signal_id: "sig-2" })]));
    for (const s of out.signals) {
      expect(s).not.toHaveProperty("overdue");
      expect(s).not.toHaveProperty("sla_due_at");
      expect(s).not.toHaveProperty("doctor_uid");
    }
  });

  it("drops the envelope doctor.uid", () => {
    const out = toPortalPayload(upstream([signal()]));
    expect(out.doctor).not.toHaveProperty("uid");
    expect(out.doctor).toEqual({ name: "Dr A", speciality: "Cardiology" });
  });

  it("drops metrics, and the uid appears nowhere in the serialised payload", () => {
    const out = toPortalPayload(upstream([signal()]));
    expect(out).not.toHaveProperty("metrics");
    expect(JSON.stringify(out)).not.toContain("cdmss-uid-must-never-ship");
  });

  it("carries my_reaction from the reactions map, keyed by signal_id", () => {
    const out = toPortalPayload(upstream([signal(), signal({ signal_id: "sig-2" })]), {
      "sig-2": { reaction: "surprised", at: "2026-09-07T10:00:00Z" },
    });
    expect(out.signals[0].my_reaction).toBeNull();
    expect(out.signals[1].my_reaction).toEqual({ reaction: "surprised", at: "2026-09-07T10:00:00Z" });
  });

  it("sets my_reaction null on every signal when the reactions map is null — the failed-call case", () => {
    const out = toPortalPayload(upstream([signal(), signal({ signal_id: "sig-2" })]), null);
    expect(out.ok).toBe(true);
    expect(out.signals.map((s) => s.my_reaction)).toEqual([null, null]);
  });

  it("keeps the advisory fallback and survives a malformed payload", () => {
    const out = toPortalPayload({ signals: "not-an-array" } as unknown as DoctorAuditsUpstream);
    expect(out.signals).toEqual([]);
    expect(out.advisory).toContain("not a performance score");
  });

  it("toPortalSignal strips the same three fields for the respond route's returned signal", () => {
    const s = toPortalSignal(signal(), { reaction: "dismiss", at: "2026-09-07T10:00:00Z" });
    expect(s).not.toHaveProperty("overdue");
    expect(s).not.toHaveProperty("sla_due_at");
    expect(s).not.toHaveProperty("doctor_uid");
    expect(s.my_reaction).toEqual({ reaction: "dismiss", at: "2026-09-07T10:00:00Z" });
  });
});

describe("normalizeReactions: a malformed entry is dropped, not rendered", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(
      normalizeReactions({
        a: { reaction: "already_knew", at: "2026-09-07T10:00:00Z" },
        b: { reaction: "" },
        c: null,
        d: { at: "2026-09-07T10:00:00Z" },
        e: { reaction: "dismiss" },
      }),
    ).toEqual({
      a: { reaction: "already_knew", at: "2026-09-07T10:00:00Z" },
      e: { reaction: "dismiss", at: "" },
    });
  });

  it("returns an empty map for anything that is not an object", () => {
    expect(normalizeReactions(null)).toEqual({});
    expect(normalizeReactions([1, 2])).toEqual({});
    expect(normalizeReactions("x")).toEqual({});
  });
});

describe("react route error mapping", () => {
  const cases: Array<[string, CatOutcome, unknown]> = [
    ["CAT 200 first time", http(200, { ok: true, replay: false, reaction: { reaction: "dismiss" } }), { ok: true, replay: false, reaction: { reaction: "dismiss" } }],
    ["CAT 200 replay", http(200, { ok: true, replay: true, reaction: { reaction: "dismiss" } }), { ok: true, replay: true, reaction: { reaction: "dismiss" } }],
    ["CAT 409", http(409, { ok: false, error: "reaction already recorded" }), { ok: false, error: "already_recorded" }],
    ["CAT 400", http(400, { error: "missing field" }), { ok: false, error: "unavailable" }],
    ["CAT 403", http(403, { error: "doctor_uid does not match the signal" }), { ok: false, error: "unavailable" }],
    ["CAT 404", http(404, { error: "unknown signal" }), { ok: false, error: "unavailable" }],
    ["CAT 500", http(500, null), { ok: false, error: "unavailable" }],
    ["CAT 502", http(502, null), { ok: false, error: "unavailable" }],
    ["timeout or network", transport, { ok: false, error: "unavailable" }],
    ["200 that says ok:false", http(200, { ok: false }), { ok: false, error: "unavailable" }],
  ];
  for (const [name, outcome, expected] of cases) {
    it(name, () => expect(mapReactOutcome(outcome)).toEqual(expected));
  }

  it("defaults replay to false when CAT omits it, so a missing flag never suppresses the audit row", () => {
    expect(mapReactOutcome(http(200, { ok: true }))).toEqual({ ok: true, replay: false, reaction: null });
  });
});

describe("respond route error mapping", () => {
  const cases: Array<[string, CatOutcome, unknown]> = [
    ["CAT 200", http(200, { ok: true, status: "responded", signal: { signal_id: "sig-1" } }), { ok: true, signal: { signal_id: "sig-1" } }],
    ["CAT 409 already responded", http(409, { error: "already responded — revisions go through your care manager" }), { ok: false, error: "already_responded" }],
    ["CAT 409 signal already closed", http(409, { error: "signal already closed" }), { ok: false, error: "closed" }],
    ["CAT 409 with an unrecognised error", http(409, { error: "something else" }), { ok: false, error: "unavailable" }],
    ["CAT 400", http(400, { error: "comment is required for an explanation" }), { ok: false, error: "invalid", message: "comment is required for an explanation" }],
    ["CAT 400 with no error text", http(400, null), { ok: false, error: "invalid", message: "" }],
    ["CAT 403", http(403, { error: "doctor_uid does not match the signal" }), { ok: false, error: "unavailable" }],
    ["CAT 404", http(404, { error: "unknown reference" }), { ok: false, error: "unavailable" }],
    ["CAT 500", http(500, null), { ok: false, error: "unavailable" }],
    ["timeout or network", transport, { ok: false, error: "unavailable" }],
    ["200 that says ok:false", http(200, { ok: false }), { ok: false, error: "unavailable" }],
  ];
  for (const [name, outcome, expected] of cases) {
    it(name, () => expect(mapRespondOutcome(outcome)).toEqual(expected));
  }

  it("reads CAT's message key when it does not use error", () => {
    expect(catErrorText({ message: "bad verdict" })).toBe("bad verdict");
    expect(catErrorText(null)).toBe("");
    expect(catErrorText("plain text")).toBe("");
  });
});

describe("parseReactBody: the body is exactly two keys", () => {
  it("accepts the contract body", () => {
    expect(parseReactBody({ signal_id: " sig-1 ", reaction: "surprised" })).toEqual({
      ok: true,
      signalId: "sig-1",
      reaction: "surprised",
    });
  });

  it("rejects a body with an extra key", () => {
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", note: "x" })).toEqual({
      ok: false,
      message: "unexpected field in body",
    });
  });

  it("rejects a body that smuggles doctor_uid or physician_id", () => {
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", doctor_uid: "other" }).ok).toBe(false);
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", physician_id: "other" }).ok).toBe(false);
  });

  it("rejects a missing signal_id and an unknown verb", () => {
    expect(parseReactBody({ reaction: "dismiss" })).toEqual({ ok: false, message: "signal_id is required" });
    expect(parseReactBody({ signal_id: "sig-1", reaction: "agree" })).toEqual({
      ok: false,
      message: "reaction must be already_knew, surprised or dismiss",
    });
  });

  it("rejects a non-object body", () => {
    expect(parseReactBody(null).ok).toBe(false);
    expect(parseReactBody([{ signal_id: "sig-1", reaction: "dismiss" }]).ok).toBe(false);
  });

  it("accepts all three verbs and nothing else", () => {
    for (const v of ["already_knew", "surprised", "dismiss"]) {
      expect(parseReactBody({ signal_id: "sig-1", reaction: v }).ok).toBe(true);
    }
  });
});

describe("parseRespondBody: four fields, and an acknowledgment never carries a verdict", () => {
  it("accepts an explanation with a verdict and a comment", () => {
    expect(parseRespondBody({ signal_id: "sig-1", type: "explanation", verdict: "disagree", comment: "  because  " })).toEqual({
      ok: true,
      signalId: "sig-1",
      type: "explanation",
      verdict: "disagree",
      comment: "because",
    });
  });

  it("forces verdict null on an acknowledgment even when one is sent", () => {
    expect(parseRespondBody({ signal_id: "sig-1", type: "acknowledgment", verdict: "agree" })).toEqual({
      ok: true,
      signalId: "sig-1",
      type: "acknowledgment",
      verdict: null,
      comment: null,
    });
  });

  it("rejects a type that is not one of the two", () => {
    expect(parseRespondBody({ signal_id: "sig-1", type: "ruling" })).toEqual({
      ok: false,
      message: "type must be acknowledgment or explanation",
    });
    expect(parseRespondBody({ signal_id: "sig-1" })).toEqual({
      ok: false,
      message: "type must be acknowledgment or explanation",
    });
  });

  it("ignores any other key rather than forwarding it", () => {
    const out = parseRespondBody({ signal_id: "sig-1", type: "acknowledgment", doctor_uid: "other", physician_id: "other" });
    expect(out).toEqual({ ok: true, signalId: "sig-1", type: "acknowledgment", verdict: null, comment: null });
    expect(JSON.stringify(out)).not.toContain("other");
  });

  it("caps the comment at the contract length", () => {
    const long = "x".repeat(COMMENT_MAX + 500);
    const out = parseRespondBody({ signal_id: "sig-1", type: "explanation", verdict: "agree", comment: long });
    expect(out.ok && out.comment?.length).toBe(COMMENT_MAX);
  });

  it("normalizeComment turns whitespace-only into null", () => {
    expect(normalizeComment("   ")).toBeNull();
    expect(normalizeComment(undefined)).toBeNull();
    expect(normalizeComment(" hi ")).toBe("hi");
  });
});

describe("neither POST route reads an identity from the request body", () => {
  const BODY_VAR = /\b(?:raw|body|json|payload|parsed)\s*(?:\.\s*|\[\s*["'])(?:doctor_uid|physician_id)\b/;
  const DESTRUCTURE = /const\s*\{[^}]*\b(?:doctor_uid|physician_id)\b[^}]*\}\s*=/;

  for (const path of [REACT_ROUTE, RESPOND_ROUTE]) {
    it(`${path} never dereferences doctor_uid or physician_id off a parsed body`, () => {
      const src = SRC(path);
      expect(src).not.toMatch(BODY_VAR);
      expect(src).not.toMatch(DESTRUCTURE);
    });

    it(`${path} takes the physician from the session and the uid from the physicians table`, () => {
      const src = SRC(path);
      expect(src).toContain("getCurrentPhysician()");
      expect(src).toContain("SELECT cdmss_doctor_uid FROM physicians WHERE id=");
      expect(src).toContain("p.physicianId");
    });

    it(`${path} answers 401 only for a missing session`, () => {
      const src = SRC(path);
      expect(src.match(/status:\s*401/g) ?? []).toHaveLength(1);
      expect(src).not.toMatch(/status:\s*(?:400|403|404|409|500)/);
    });
  }

  it("the react route refuses an unexpected body key rather than ignoring it", () => {
    expect(SRC(REACT_ROUTE)).toContain("parseReactBody");
    expect(parseReactBody({ signal_id: "sig-1", reaction: "dismiss", extra: 1 }).ok).toBe(false);
  });

  it("neither route puts a comment in its audit row", () => {
    expect(SRC(REACT_ROUTE)).toContain("'portal_reaction', 'physician'");
    const respond = SRC(RESPOND_ROUTE);
    expect(respond).toContain("'portal_response', 'physician'");
    const insert = respond.slice(respond.indexOf("INSERT INTO audit_log_v2"));
    expect(insert.slice(0, insert.indexOf("::jsonb"))).not.toContain("comment");
  });
});

describe("the findings GET survives a failed reactions call", () => {
  it("catches the reactions call separately from the audits call", () => {
    const src = SRC(FINDINGS_ROUTE);
    const inner = src.slice(src.indexOf("fetchDoctorReactions"));
    // The reactions failure sets the map to null and falls through to the ok:true payload; only the
    // audits failure is allowed to reach upstream_unavailable.
    expect(inner).toMatch(/catch\s*\{\s*\n?\s*reactions = null/);
    expect(inner.slice(0, inner.indexOf("toPortalPayload"))).not.toContain("upstream_unavailable");
  });

  it("still answers ok:true with my_reaction null when the map is null", () => {
    const out = toPortalPayload(upstream([signal()]), null);
    expect(out.ok).toBe(true);
    expect(out.mapped).toBe(true);
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].my_reaction).toBeNull();
  });
});

describe("with the flag off the card shows none of this kickoff's controls", () => {
  const LABELS = [
    "I already knew this",
    "This surprised me",
    "Dismiss",
    "Acknowledge",
    "Agree",
    "Disagree",
    "Your reaction · private research record · not sent to governance",
    "Response · goes to your care manager",
    "Disagree sends this finding back to your care manager.",
  ];

  it("every new label lives inside the file's two flagged rows", () => {
    const src = SRC(CARD);
    // Both rows render only from the `reactions ?` branch of SignalCard. Everything the kickoff
    // adds is inside ReactionRow or ResponseRow, which nothing else mounts.
    const rowA = src.slice(src.indexOf("function ReactionRow"), src.indexOf("function ResponseRow"));
    const rowB = src.slice(src.indexOf("function ResponseRow"), src.indexOf("function SignalCard"));
    const consts = src.slice(0, src.indexOf("function Shell"));
    for (const label of LABELS) {
      expect(rowA + rowB + consts).toContain(label);
    }
    expect(src).toContain("{reactions ? (");
    expect(src).toContain("<ReactionRow s={s} onRefetch={onRefetch} />");
  });

  it("the v0 sentence is what renders on the flag-off branch, unchanged", () => {
    const src = SRC(CARD);
    const off = src.slice(src.indexOf("s.response_required !== \"none\" &&"));
    expect(off).toContain(
      "A response is requested — until in-portal responses ship, respond via your care manager.",
    );
    for (const label of LABELS) {
      expect(off.slice(0, off.indexOf("</p>"))).not.toContain(label);
    }
  });

  it("the flag reaches the card as a prop that defaults to false", () => {
    expect(SRC(CARD)).toContain("{ reactions = false }: { reactions?: boolean }");
    expect(SRC("src/app/portal/page.tsx")).toContain("<FindingsForDoctor reactions={features.reactions} />");
    expect(SRC("src/app/api/portal/announcements/route.ts")).toContain(
      'reactions: process.env.PORTAL_REACTIONS === "1"',
    );
  });
});
