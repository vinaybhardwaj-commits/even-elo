// @vitest-environment node
// Role x screen matrix (gov/role-parity): page access, screen API, HTTP tools, chat actions, agent table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { SCREEN_IDS, allowedScreens, canUseTool, encodeRoles, screenForPath, type ScreenId } from "../access";
import { authorizeStudioRequest, type LiveStaff } from "../authorize";
import { runHttpTool } from "@/lib/http-tools/run";
import { buildHttpToolActions } from "@/lib/http-tools/actions";
import { buildSurgicalActions } from "@/lib/surgical/actions";
import { buildOnboardingActions } from "@/lib/onboarding/actions";
import { runSurgicalRead } from "@/lib/surgical/run";
import { runAdmin } from "@/lib/http-tools/admin";
import { runRmo } from "@/lib/http-tools/rmo";
import { runFeedback } from "@/lib/http-tools/feedback";
import { POST as screenPost } from "@/app/api/screen/[tool]/route";

type Persona = "super_admin" | "sgc_member" | "site_medical_head" | "hr" | "sgo_and_hr" | "plain_staff";
const FLAGS: Record<Persona, Partial<LiveStaff>> = {
  super_admin: { is_super_admin: true },
  sgc_member: { is_sgc_member: true },
  site_medical_head: { is_site_medical_head: true },
  hr: { is_hr: true },
  sgo_and_hr: { is_sgc_member: true, is_hr: true },
  plain_staff: {},
};
const PERSONAS = Object.keys(FLAGS) as Persona[];
const base = (p: Persona): LiveStaff => ({ status: "active", is_super_admin: false, must_change_pin: false, ...FLAGS[p] });
const roleOf = (p: Persona) =>
  encodeRoles({ super_admin: FLAGS[p].is_super_admin, sgc_member: FLAGS[p].is_sgc_member, site_medical_head: FLAGS[p].is_site_medical_head, hr: FLAGS[p].is_hr });

// The matrix, written out independently of access.ts: the source even-elo page's access (see .bc/ACCESS-MATRIX.md).
const ANY = PERSONAS;
const EXPECTED: Record<ScreenId, Persona[]> = {
  overview: ANY,
  physicians: ANY,
  "audit-findings": ["super_admin", "sgc_member", "site_medical_head", "sgo_and_hr"],
  "document-audits": ANY,
  cdmss: ["super_admin", "sgc_member", "site_medical_head", "sgo_and_hr"],
  "rmo-inbox": ANY,
  incidents: ["super_admin", "sgc_member", "sgo_and_hr"],
  feedback: ANY,
  surgical: ["super_admin"],
  onboarding: ANY,
  admin: ["super_admin"],
};
const PAGE: Record<ScreenId, string> = {
  overview: "/overview",
  physicians: "/physicians/abc",
  "audit-findings": "/audit-findings/EHRC-AUD-2026-0001",
  "document-audits": "/document-audits",
  cdmss: "/cdmss/doctors",
  "rmo-inbox": "/rmo-inbox",
  incidents: "/incidents",
  feedback: "/feedback",
  surgical: "/surgical/vcs/abc",
  onboarding: "/onboarding/credentials",
  admin: "/admin/resignations",
};

const SECRET = "matrix-secret-not-real";
const ENV = { STAFF_JWT_SECRET: SECRET, NODE_ENV: "production" };
const STAFF = "33333333-3333-4333-8333-333333333333";
async function cookieFor() {
  const t = await new SignJWT({ profileId: STAFF }).setProtectedHeader({ alg: "HS256" }).setAudience("staff").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
  return { epi_session: t };
}
const zoneReq = async (pathname: string, method = "GET") => ({ method, host: "governance.evenos.app", forwardedHost: null, origin: method === "GET" ? null : "https://governance.evenos.app", pathname, cookies: await cookieFor() });
const decide = async (live: LiveStaff, pathname: string) => authorizeStudioRequest(await zoneReq(pathname), ENV, { loadLiveStaff: async () => live });

describe("role x screen: pages (zone authorize)", () => {
  for (const screen of SCREEN_IDS) {
    it(`${screen}: only ${EXPECTED[screen].length} of ${PERSONAS.length} personas`, async () => {
      for (const p of PERSONAS) {
        const d = await decide(base(p), PAGE[screen]);
        expect(d.ok, `${p} ${PAGE[screen]}`).toBe(EXPECTED[screen].includes(p));
        if (!d.ok) expect(d).toMatchObject({ status: 403, reason: "role" });
        else expect(d.role).toBe(roleOf(p));
      }
    });
  }

  it("pending, suspended and PIN-pending staff are refused on every screen, and unknown personas get no screen", async () => {
    for (const status of ["pending_approval", "suspended", "inactive", ""]) {
      for (const screen of SCREEN_IDS) {
        const d = await decide({ ...base("super_admin"), status }, PAGE[screen]);
        expect(d, `${status} ${screen}`).toMatchObject({ ok: false, status: 403, reason: "inactive" });
      }
    }
    expect(await decide({ ...base("super_admin"), must_change_pin: true }, "/overview")).toMatchObject({ ok: false, reason: "must-change-pin" });
    expect(allowedScreens("doctor")).toEqual([]);
    expect(allowedScreens("")).toEqual([]);
  });

  it("chat, health and copilotkit are open to every active staff member (no screen)", async () => {
    for (const path of ["/", "/api/health", "/api/copilotkit", "/_next/static/x.js"]) {
      expect(screenForPath(path), path).toBeNull();
      expect((await decide(base("plain_staff"), path)).ok, path).toBe(true);
    }
  });
});

describe("role x screen: API families (zone authorize)", () => {
  const API: Array<[ScreenId, string]> = [
    ["surgical", "/api/surgical/surgical_vcs"],
    ["surgical", "/api/surgical/write/anything"],
    ["onboarding", "/api/onboarding/onboarding_pipeline"],
    ["onboarding", "/api/onboarding/write/prescreen_create"],
    ["admin", "/api/admin/users"],
    ["feedback", "/api/feedback/list"],
    ["rmo-inbox", "/api/rmo/inbox"],
    ["audit-findings", "/api/audit-findings/EHRC-AUD-2026-0001/ruling"],
    ["incidents", "/api/screen/eiris_incidents"],
    ["audit-findings", "/api/screen/audit_findings"],
    ["overview", "/api/screen/overview_counts"],
    ["cdmss", "/api/cdmss/doctors"],
    ["cdmss", "/api/screen/cdmss_view_doctors"],
  ];
  it("each API path follows its screen's predicate", async () => {
    for (const [screen, path] of API) {
      for (const p of PERSONAS) {
        const d = await authorizeStudioRequest(await zoneReq(path, "POST"), ENV, { loadLiveStaff: async () => base(p) });
        expect(d.ok, `${p} ${path}`).toBe(EXPECTED[screen].includes(p));
      }
    }
  });
});

describe("role x screen: HTTP tools and routes", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.AGENT_URL;
  });
  const HTTP: Array<[string, ScreenId]> = [
    ["eiris_incidents", "incidents"],
    ["eiris_incident_detail", "incidents"],
    ["opd_signals", "audit-findings"],
    ["audit_findings", "audit-findings"],
    ["audit_finding_detail", "audit-findings"],
  ];
  it("runHttpTool refuses a role the tool's screen does not admit, before any upstream call", async () => {
    for (const [tool, screen] of HTTP) {
      for (const p of PERSONAS) {
        if (EXPECTED[screen].includes(p)) continue;
        const r = await runHttpTool(tool as never, { incident_id: "EHRC-INC-2026-0001", reference: "EHRC-AUD-2026-0001" }, { staffId: STAFF, role: roleOf(p) });
        expect(r, `${p} ${tool}`).toMatchObject({ status: 403, body: { error: "forbidden" } });
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an admitted role gets past the gate (the next failure is configuration, never 403)", async () => {
    const r = await runHttpTool("audit_findings", {}, { staffId: STAFF, role: roleOf("site_medical_head") });
    expect(r.status).not.toBe(403);
  });

  it("the screen route refuses per tool (403) with the proxy's headers", async () => {
    const call = (tool: string, role: string) =>
      screenPost(
        new NextRequest(`https://governance.evenos.app/api/screen/${tool}`, { method: "POST", headers: { "studio-internal-staff-id": STAFF, "studio-internal-staff-role": role }, body: "{}" }),
        { params: Promise.resolve({ tool }) },
      );
    for (const [tool, screen] of HTTP) {
      for (const p of PERSONAS) {
        const res = await call(tool, roleOf(p));
        expect(res.status === 403, `${p} ${tool}`).toBe(!EXPECTED[screen].includes(p));
      }
    }
    expect((await call("overview_counts", roleOf("plain_staff"))).status).not.toBe(403);
  });

  it("surgical, admin, rmo and feedback families follow the same table", async () => {
    for (const p of PERSONAS) {
      const role = roleOf(p);
      expect((await runSurgicalRead("surgical_vcs" as never, {}, { staffId: STAFF, role, session: null, position: null })).status === 403, `surgical ${p}`).toBe(!EXPECTED.surgical.includes(p));
      expect((await runAdmin("users", {}, { staffId: STAFF, role })).status === 403, `admin ${p}`).toBe(!EXPECTED.admin.includes(p));
      expect((await runRmo("inbox", {}, { staffId: STAFF, role })).status === 403, `rmo ${p}`).toBe(false);
      expect((await runFeedback("list", {}, { staffId: STAFF, role })).status === 403, `feedback ${p}`).toBe(false);
      // retract stays super_admin only (a write; G3 is not built so it is refused for everyone anyway)
      const retract = (await runFeedback("retract", { feedback_id: "11111111-1111-4111-8111-111111111111", retraction_reason: "test" }, { staffId: STAFF, role })).body as { error?: string };
      expect(retract.error === "forbidden", `retract ${p}`).toBe(p !== "super_admin");
    }
  });
});

describe("role x screen: chat tools registered per role", () => {
  const names = (a: unknown) => (a as Array<{ name: string }>).map((x) => x.name);
  it("only the allowed tools are registered as server actions", () => {
    for (const p of PERSONAS) {
      const role = roleOf(p);
      const all = [
        ...names(buildHttpToolActions({ staffId: STAFF, role })),
        ...names(buildSurgicalActions({ staffId: STAFF, role, session: null, position: null })),
        ...names(buildOnboardingActions({ staffId: STAFF, role, session: null })),
      ];
      for (const n of all) expect(canUseTool(role, n), `${p} ${n}`).toBe(true);
      expect(all.includes("eiris_incidents"), p).toBe(EXPECTED.incidents.includes(p));
      expect(all.includes("audit_findings"), p).toBe(EXPECTED["audit-findings"].includes(p));
      expect(all.includes("surgical_vcs"), p).toBe(EXPECTED.surgical.includes(p));
      expect(all.includes("onboarding_pipeline"), p).toBe(true);
    }
  });
});

describe("role x tool: the table the agent pins", () => {
  const matrix = JSON.parse(readFileSync(join(__dirname, "../../../../../agent/tests/access_matrix.json"), "utf8")) as {
    personas: Record<string, string>;
    screens: Record<string, string[]>;
    tools: Record<string, string[]>;
  };
  it("access.ts and the agent's studio_access.py agree on every screen, tool and persona", () => {
    for (const [persona, role] of Object.entries(matrix.personas)) {
      expect(role).toBe(roleOf(persona as Persona));
      for (const [screen, allowed] of Object.entries(matrix.screens)) {
        expect(EXPECTED[screen as ScreenId].includes(persona as Persona), `${persona} ${screen}`).toBe(allowed.includes(persona));
      }
      for (const [tool, allowed] of Object.entries(matrix.tools)) expect(canUseTool(role, tool), `${persona} ${tool}`).toBe(allowed.includes(persona));
    }
  });
});
