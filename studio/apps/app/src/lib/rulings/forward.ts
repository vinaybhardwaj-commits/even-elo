import { AUDIT_REF_RE } from "@/lib/screens/tool-schema";
import { parseRulingBody } from "./model";

// Forwards ONE typed ruling to the EXISTING even-elo route POST /api/audit-findings/<ref>/ruling, which records the
// gov_interventions row and relays the ruling to CDMSS. The staff session cookie is forwarded as is, so even-elo
// re-checks the role (manage level, Site Medical Head scope) itself. This app writes no SQL and calls no CDMSS write.
// Order: second factor, body, then the forward. Fixed error codes only; upstream text is never passed on.

const TIMEOUT_MS = 25_000;

export type RulingOutcome = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): RulingOutcome => ({ status, body: { ok: false, error } });

export interface ForwardInput {
  reference: string;
  rawBody: unknown;
  sessionCookie: string | null;
  /** Verifies the G3 second factor for this staff member and ruling. No verifier exists yet: the default refuses. */
  secondFactor?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  base?: string;
}

export async function forwardRuling(input: ForwardInput): Promise<RulingOutcome> {
  if (!AUDIT_REF_RE.test(input.reference)) return fail(400, "bad_reference");
  if (!input.sessionCookie) return fail(401, "unauthorized");
  if (!(await (input.secondFactor ?? (async () => false))())) return fail(403, "second_factor_required");
  const body = parseRulingBody(input.rawBody);
  if (!body.ok) return fail(422, "bad_params");
  const base = (input.base ?? process.env.EVEN_ELO_BASE ?? "https://governance.evenos.app").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(`${base}/api/audit-findings/${encodeURIComponent(input.reference)}/ruling`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `epi_session=${input.sessionCookie}`, Origin: base },
      body: JSON.stringify({ action: body.action, note: body.note }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail(502, "upstream_unreachable");
  }
  const j: unknown = await res.json().catch(() => null);
  const o = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  if (res.ok) return { status: 200, body: { ok: true, replayed: o.replayed === true, status: typeof o.status === "string" ? o.status : null } };
  // even-elo's own codes (conflict, forbidden, not_found) are mapped to fixed ones; 502 = saved there, CDMSS unconfirmed.
  if (res.status === 409) return { status: 409, body: { ok: false, error: "conflict", current_status: typeof o.current_status === "string" ? o.current_status : null } };
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400) return fail(res.status, res.status === 404 ? "not_found" : res.status === 400 ? "bad_params" : res.status === 401 ? "unauthorized" : "forbidden");
  return fail(502, "cdmss_unconfirmed");
}
