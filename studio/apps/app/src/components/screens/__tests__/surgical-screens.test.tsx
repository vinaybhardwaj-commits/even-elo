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
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { SurgicalCasesScreen, SurgicalOverviewScreen, SurgicalVcScreen, SurgicalVcsScreen } from "../surgical-screens";
import { ConfirmCard } from "../surgical-parts";

const VC = "11111111-1111-4111-8111-111111111111";
const CASE = "33333333-3333-4333-8333-333333333333";
const table = (tool: string, columns: string[], rows: Array<Record<string, string | number | boolean | null>>) => ({
  source: { tool, query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns,
  rows,
  row_count: rows.length,
});
const DATA: Record<string, unknown> = {
  surgical_overview: table("surgical_overview", ["metric", "value", "note"], [{ metric: "vcs_active", value: 7, note: null }]),
  surgical_leaderboard: table("surgical_leaderboard", ["vc_id", "full_name", "specialty", "composite", "tier"], [{ vc_id: VC, full_name: "Dr Example", specialty: "Ortho", composite: 71.2, tier: "Gold" }]),
  surgical_vcs: table("surgical_vcs", ["vc_id", "full_name", "specialty", "registration_no", "status", "updated"], [{ vc_id: VC, full_name: "Dr Example", specialty: "Ortho", registration_no: null, status: "active", updated: "2026-10-01" }]),
  surgical_vc_detail: table("surgical_vc_detail", ["metric", "value"], [{ metric: "tier", value: "Gold" }]),
  surgical_cases: table("surgical_cases", ["case_ref", "surgery_date", "surgeon", "specialty", "procedure", "status", "los_days", "case_id"], [
    { case_ref: "C-001", surgery_date: "2026-09-30", surgeon: "Dr Example", specialty: "Ortho", procedure: "TKR", status: "completed", los_days: 3, case_id: CASE },
  ]),
};

const fetchMock = vi.fn();
beforeEach(() => {
  contexts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(DATA[String(url).split("/").pop() as string]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("surgical screens", () => {
  it("overview: tiles and leaderboard load through /studio/api/surgical, each with its source line, and the agent gets ids only", async () => {
    render(<SurgicalOverviewScreen />);
    await waitFor(() => expect(screen.getByText("Dr Example")).toBeInTheDocument());
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/0123456789ab/).length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["/studio/api/surgical/surgical_overview", "/studio/api/surgical/surgical_leaderboard"]));
    const ctx = contexts.at(-1)!.value;
    expect(ctx.screen).toBe("surgical_overview");
    expect(JSON.stringify(ctx)).not.toContain("Dr Example");
  });

  it("vc detail: context carries the vc id and section, not rows", async () => {
    render(<SurgicalVcScreen id={VC} />);
    await waitFor(() => expect(screen.getByText("Gold")).toBeInTheDocument());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ vc_id: VC, section: "summary" });
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "surgical_vc", selected: { vc_id: VC } });
    fireEvent.click(screen.getByRole("tab", { name: "cases" }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body)).section).toBe("cases"));
  });

  it("a void opens a confirm card that is disabled with a second-factor note, and sends nothing", async () => {
    render(<SurgicalCasesScreen />);
    await waitFor(() => expect(screen.getByText("C-001")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    const card = await screen.findByTestId("confirm-card");
    expect(card).toHaveTextContent("Void case");
    expect(screen.getByTestId("second-factor-note")).toHaveTextContent(/second factor/i);
    const confirm = screen.getByRole("button", { name: /Confirm and apply/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/write/"))).toBe(false);
  });

  it("adding a VC goes through review then the card; nothing is posted by typing alone", async () => {
    render(<SurgicalVcsScreen />);
    await waitFor(() => expect(screen.getAllByText("Dr Example").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dr New" } });
    fireEvent.change(screen.getByLabelText("Specialty"), { target: { value: "ENT" } });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/write/"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByTestId("confirm-card")).toHaveTextContent("Dr New");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/write/"))).toBe(false);
  });

  it("the card posts the exact params once a second factor is available, and reports a refusal in fixed text", async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "rejected" }), { status: 422 }));
    render(<ConfirmCard action="case_void" params={{ case_id: CASE }} summary={[["Case", "C-001"]]} onClose={() => {}} onDone={onDone} secondFactor />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm and apply/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/rejected/i));
    expect(fetchMock).toHaveBeenCalledWith("/studio/api/surgical/write/case_void", expect.objectContaining({ method: "POST", body: JSON.stringify({ case_id: CASE }) }));
    expect(onDone).not.toHaveBeenCalled();
  });
});
