import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const contexts: Array<{ description: string; value: Record<string, unknown> }> = [];
vi.mock("@copilotkit/react-core/v2", () => ({
  useAgentContext: (c: { description: string; value: Record<string, unknown> }) => {
    contexts.push(c);
  },
}));
vi.mock("../screen-frame", () => ({
  ScreenFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

import { DocumentAuditsScreen, toListParams, EMPTY } from "../document-audits-screen";
import { DocumentAuditScreen } from "../document-audit-screen";
import { NAV_ITEMS, isActive } from "../studio-nav";
import { clearScreenCache } from "@/lib/screens/use-screen-tool";
import { SCREEN_TOOL_PARAMS, isGovernanceTool } from "@/lib/screens/tool-schema";
import { DOCAUDIT_TOOL_NAMES } from "@/lib/screens/docaudit-schema";

const AID = "33333333-3333-4333-8333-333333333333";
const PID = "22222222-2222-4222-8222-222222222222";
const table = (tool: string, columns: string[], rows: Array<Record<string, string | number | boolean | null>>, total?: number) => ({
  source: { tool, query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns,
  rows,
  row_count: rows.length,
  ...(total === undefined ? {} : { total }),
});
const auditRow = { audit_id: AID, external_ref: "AUD-1", hospital_code: "H1", physician_id: PID, full_name: "Dr A", primary_specialty: "Cardiology", doc_type: "progress", doc_day: "2026-10-01", ingested_on: "2026-10-02", has_pdf: true, routed: false, findings: 2, open_findings: 1, top_severity: "high" };
const DATA: Record<string, unknown> = {
  document_audit_headline: table("document_audit_headline", ["metric", "value"], [
    { metric: "audits_total", value: 12 },
    { metric: "findings_open", value: 5 },
    { metric: "days_since_last_ingest", value: null },
  ]),
  document_audit_doctor_rollup: table("document_audit_doctor_rollup", ["physician_id", "full_name", "primary_specialty", "audits", "findings", "open_findings", "critical_high_open", "contested", "responded", "last_finding_on"], [
    { physician_id: PID, full_name: "Dr A", primary_specialty: "Cardiology", audits: 2, findings: 3, open_findings: 2, critical_high_open: 1, contested: 0, responded: 1, last_finding_on: "2026-10-03" },
  ]),
  list_document_audits: table("list_document_audits", Object.keys(auditRow), [auditRow], 1),
  document_audit_detail: table("document_audit_detail", ["audit_id", "external_ref", "hospital_code", "physician_id", "full_name", "primary_specialty", "doc_type", "doc_day", "ingested_on", "has_pdf", "routed_on", "finding_id", "finding_label", "severity", "status", "author_confirmed", "authored_on", "recurrence_count", "portal_visible", "response_owner", "signal_reference", "response_verb", "responded_on", "sync_state"], [
    { ...auditRow, routed_on: null, finding_id: "f1", finding_label: "Missing plan", severity: "high", status: "open", author_confirmed: false, authored_on: "2026-10-03", recurrence_count: 2, portal_visible: false, response_owner: null, signal_reference: null, response_verb: null, responded_on: null, sync_state: null },
  ]),
};

const fetchMock = vi.fn();
beforeEach(() => {
  clearScreenCache();
  contexts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(DATA[String(url).split("/").pop() as string]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodies = () => fetchMock.mock.calls.map((c) => [String(c[0]).split("/").pop(), JSON.parse(c[1].body)]);

describe("document audits screens", () => {
  it("list: three reads, each table shows its source line, headline null is a dash", async () => {
    render(<DocumentAuditsScreen />);
    await screen.findByText("AUD-1");
    expect(bodies()).toEqual(
      expect.arrayContaining([
        ["document_audit_headline", {}],
        ["document_audit_doctor_rollup", { window_days: 90, limit: 25 }],
        ["list_document_audits", { filter: {}, limit: 100, offset: 0 }],
      ]),
    );
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Document audits", { selector: ".scr-tile-label" })).toBeInTheDocument();
    expect(screen.getByText("Days since last ingest").parentElement).toHaveTextContent("–");
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "document_audits", selected: {}, filters: {} });
  });

  it("list: applying filters re-reads with typed params and exposes them (ids/filters only, no rows)", async () => {
    render(<DocumentAuditsScreen />);
    await screen.findByText("AUD-1");
    fireEvent.change(screen.getByLabelText("Hospital code"), { target: { value: "H1" } });
    fireEvent.change(screen.getByLabelText("Finding severity"), { target: { value: "critical" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bodies()).toContainEqual(["list_document_audits", { filter: { hospital_code: "H1", severity: "critical" }, limit: 100, offset: 0 }]));
    expect(bodies()).toContainEqual(["document_audit_headline", { hospital_code: "H1" }]);
    const ctx = JSON.stringify(contexts.at(-1)!.value);
    expect(ctx).toContain('"severity":"critical"');
    expect(ctx).not.toContain("Dr A");
    expect(ctx).not.toContain("AUD-1");
  });

  it("list: choosing a doctor in the roll-up filters the audits to that physician", async () => {
    render(<DocumentAuditsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Dr A" }));
    await waitFor(() => expect(bodies()).toContainEqual(["list_document_audits", { filter: { physician_id: PID }, limit: 100, offset: 0 }]));
    expect(contexts.at(-1)!.value).toMatchObject({ selected: { physician_id: PID } });
  });

  it("list: rows link to the audit detail and the whole row is clickable", async () => {
    render(<DocumentAuditsScreen />);
    const link = await screen.findByRole("link", { name: "2026-10-02" });
    expect(link).toHaveAttribute("href", `/studio/document-audits/${AID}`);
  });

  it("toListParams drops unknown enum values and trims", () => {
    expect(toListParams({ ...EMPTY, hospital: " H1 ", docType: "bogus", severity: "low", status: "x" }, 100)).toEqual({ filter: { hospital_code: "H1", severity: "low" }, limit: 100, offset: 100 });
  });

  it("detail: reads one tool for the selected id and shows findings with a source line, no finding text column", async () => {
    render(<DocumentAuditScreen id={AID} />);
    await screen.findByText("Missing plan");
    expect(bodies()).toEqual([["document_audit_detail", { audit_id: AID }]]);
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "document_audit", selected: { audit_id: AID } });
    expect(screen.getByText("RMO confirmed")).toBeInTheDocument();
    expect(screen.queryByText(/finding body|evidence excerpt/i)).toBeNull();
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /release|confirm|author/i })).toBeNull(); // no write controls on this page
  });

  it("detail: an invalid id makes no request; a failed read shows a fixed message", async () => {
    render(<DocumentAuditScreen id="nope" />);
    expect(screen.getByRole("alert")).toHaveTextContent("not valid");
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "tool_failed", message: "password=hunter2" }), { status: 502 }));
    render(<DocumentAuditScreen id={AID} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("nav lists the section and marks the detail page active", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/document-audits")).toBe(true);
    expect(isActive(`/document-audits/${AID}`, "/document-audits")).toBe(true);
  });
});

describe("document audit tool params", () => {
  it("are governance tools with strict params", () => {
    for (const t of DOCAUDIT_TOOL_NAMES) expect(isGovernanceTool(t)).toBe(true);
    const p = SCREEN_TOOL_PARAMS;
    expect(p.list_document_audits.safeParse({ filter: { severity: "high" }, limit: 200, offset: 0 }).success).toBe(true);
    expect(p.list_document_audits.safeParse({ sql: "select 1" }).success).toBe(false);
    expect(p.list_document_audits.safeParse({ filter: { severity: "extreme" } }).success).toBe(false);
    expect(p.list_document_audits.safeParse({ filter: { staff_id: "x" } }).success).toBe(false);
    expect(p.document_audit_detail.safeParse({ audit_id: "x" }).success).toBe(false);
    expect(p.document_audit_detail.safeParse({ audit_id: AID }).success).toBe(true);
    expect(p.document_audit_doctor_rollup.safeParse({ window_days: 366 }).success).toBe(false);
    expect(p.document_audit_headline.safeParse({ hospital_code: "H1", extra: 1 }).success).toBe(false);
  });
});
