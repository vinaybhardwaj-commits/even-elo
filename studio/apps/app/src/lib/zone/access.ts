// Per-screen access for the Studio zone (gov/role-parity). PURE: no I/O, safe on the edge and in the browser.
//
// Rule (V): page-level access in Studio = the access of the SOURCE even-elo page, exactly; inside a page there is no
// PHI or doctor gating. The matrix is derived from even-elo source (see .bc/ACCESS-MATRIX.md for path:line):
//
//   overview, physicians (+360), document-audits, rmo-inbox, feedback, onboarding   any active staff
//   audit-findings        super_admin | site_medical_head | sgc_member   (src/lib/staff-guard.ts staffAllows "view")
//   incidents (e-IRIS)    super_admin | sgc_member                       (src/app/safety/page.tsx, /api/safety proxy)
//   cdmss (module)        super_admin | site_medical_head | sgc_member   (governance leads; SGO = sgc_member. Named clinical
//                         reviewers: NO role flag exists yet, see report)
//   surgical, admin       super_admin                                    (src/middleware.ts /surgical-governance, /admin)
//
// MIRROR of /studio-access.js at the even-elo repo root (the even-elo middleware cannot import from this app).
// src/lib/__tests__/studio-access-parity.test.ts compares the two for every role combination; change both together.
//
// Roles travel as one string (the proxy's actor header and the actor JWT `role` claim): a sorted, comma-joined list that
// always starts with "staff" (= active, non-pending), e.g. "staff" or "staff,hr,sgc_member,super_admin".

export const ROLE_FLAGS = ["hr", "sgc_member", "site_medical_head", "super_admin"] as const;
export type RoleFlag = (typeof ROLE_FLAGS)[number];

export const SCREEN_IDS = [
  "overview",
  "physicians",
  "audit-findings",
  "document-audits",
  "cdmss",
  "rmo-inbox",
  "incidents",
  "feedback",
  "surgical",
  "onboarding",
  "admin",
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

const BASE_ROLE = "staff";
const KNOWN = new Set<string>([BASE_ROLE, ...ROLE_FLAGS]);

/** Role flags (from the live staff row) -> the role string. Only true flags are kept. */
export function encodeRoles(flags: Partial<Record<RoleFlag, boolean>>): string {
  return [BASE_ROLE, ...ROLE_FLAGS.filter((f) => flags[f] === true)].join(",");
}

/** The set of KNOWN roles in a role string; anything unknown is dropped (fail closed). */
export function parseRoles(role: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (role ?? "").split(",")) {
    const p = part.trim();
    if (KNOWN.has(p)) out.add(p);
  }
  // Any known role is held by an active staff member (a bare "super_admin" claim is a valid older shape).
  if (out.size > 0) out.add(BASE_ROLE);
  return out;
}

export function hasAnyRole(role: string | null | undefined, wanted: ReadonlySet<string> | readonly string[]): boolean {
  const have = parseRoles(role);
  return Array.from(wanted).some((w) => have.has(w));
}

type Pred = (r: Set<string>) => boolean;
const any: Pred = (r) => r.has(BASE_ROLE);
const oneOf =
  (...roles: RoleFlag[]): Pred =>
  (r) =>
    r.has(BASE_ROLE) && roles.some((x) => r.has(x));

/** Screen -> predicate. Every predicate also requires the base "staff" role (active, non-pending). */
export const SCREEN_ACCESS: Record<ScreenId, Pred> = {
  overview: any,
  physicians: any,
  "audit-findings": oneOf("super_admin", "site_medical_head", "sgc_member"),
  "document-audits": any,
  cdmss: oneOf("super_admin", "site_medical_head", "sgc_member"),
  "rmo-inbox": any,
  incidents: oneOf("super_admin", "sgc_member"),
  feedback: any,
  surgical: oneOf("super_admin"),
  onboarding: any,
  admin: oneOf("super_admin"),
};

export function canAccessScreen(role: string | null | undefined, screen: ScreenId): boolean {
  return SCREEN_ACCESS[screen](parseRoles(role));
}

export function allowedScreens(role: string | null | undefined): ScreenId[] {
  return SCREEN_IDS.filter((s) => canAccessScreen(role, s));
}

/** Page path (basePath stripped) -> screen. "/" (chat) and unknown paths are not a screen. */
export function screenForPage(pathname: string): ScreenId | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const first = path.split("/")[1] ?? "";
  return (SCREEN_IDS as readonly string[]).includes(first) ? (first as ScreenId) : null;
}

const API_FAMILY: Record<string, ScreenId> = {
  surgical: "surgical",
  onboarding: "onboarding",
  admin: "admin",
  feedback: "feedback",
  rmo: "rmo-inbox",
  "audit-findings": "audit-findings",
  cdmss: "cdmss",
};

/** API path (basePath stripped) -> screen. /api/screen/<tool> follows the tool; unknown tools are the route's 404. */
export function screenForApi(pathname: string): ScreenId | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] !== "api" || segs.length < 2) return null;
  if (segs[1] === "screen") return segs[2] ? screenForTool(segs[2]) : null;
  return API_FAMILY[segs[1]] ?? null;
}

/** Page or API path -> the screen whose predicate guards it, or null (chat, assets, health, copilotkit). */
export function screenForPath(pathname: string): ScreenId | null {
  return pathname.startsWith("/api/") ? screenForApi(pathname) : screenForPage(pathname);
}

// ---- tools --------------------------------------------------------------------------------------------------

// The screen whose access a tool follows. A tool serving several screens is listed under the widest one that uses it
// (all of these are "any staff" screens), so a user never loses a tool a screen they may open needs.
const GOVERNANCE_SCREEN: Record<string, ScreenId> = {
  list_physicians: "physicians",
  physician_profile: "physicians",
  physician_privileges: "physicians",
  physician_oppe: "physicians",
  physician_metrics: "physicians",
  physician_qualifications: "physicians",
  signal_snapshots: "overview",
  interventions: "overview",
  incident_summary: "overview",
  overview_counts: "overview",
  capture_gaps: "overview",
  feedback_by_physician: "feedback",
  list_document_audits: "document-audits",
  document_audit_detail: "document-audits",
  document_audit_doctor_rollup: "document-audits",
  document_audit_headline: "document-audits",
};

const HTTP_SCREEN: Record<string, ScreenId> = {
  eiris_incidents: "incidents",
  eiris_incident_detail: "incidents",
  opd_signals: "audit-findings",
  audit_findings: "audit-findings",
  audit_finding_detail: "audit-findings",
  rmo_inbox: "rmo-inbox",
  rmo_author: "rmo-inbox",
  rmo_release: "rmo-inbox",
  patient_feedback: "feedback",
  feedback_retract: "feedback",
  surgical_write: "surgical",
  onboarding_write: "onboarding",
  admin_set_status: "admin",
  admin_grant_role: "admin",
  admin_process_resignation: "admin",
};

/** tool name -> screen. Families are matched by prefix so a new surgical_/onboarding_/admin_ tool follows its family. */
export function screenForTool(tool: string): ScreenId | null {
  if (tool in GOVERNANCE_SCREEN) return GOVERNANCE_SCREEN[tool];
  if (tool in HTTP_SCREEN) return HTTP_SCREEN[tool];
  if (tool.startsWith("surgical_")) return "surgical";
  if (tool.startsWith("onboarding_")) return "onboarding";
  if (tool.startsWith("admin_")) return "admin";
  if (tool.startsWith("cdmss_")) return "cdmss";
  return null;
}

/** May this role run this tool? Unknown tools are refused. plan_visualization (no data) is open to any staff. */
export function canUseTool(role: string | null | undefined, tool: string): boolean {
  if (tool === "plan_visualization") return parseRoles(role).has(BASE_ROLE);
  const screen = screenForTool(tool);
  return screen !== null && canAccessScreen(role, screen);
}

export function allowedTools(role: string | null | undefined, tools: readonly string[]): string[] {
  return tools.filter((t) => canUseTool(role, t));
}

/** Where a refused page navigation lands: Overview is open to every active staff member. */
export const FALLBACK_SCREEN_PATH = "/overview";
