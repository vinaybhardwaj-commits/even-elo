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
vi.mock("@/components/generative-ui/charts/bar-chart", () => ({ BarChart: ({ title }: { title: string }) => <div>chart:{title}</div> }));
vi.mock("@/components/generative-ui/charts/pie-chart", () => ({ PieChart: ({ title }: { title: string }) => <div>chart:{title}</div> }));

import { OverviewScreen } from "../overview-screen";
import { PhysicianScreen } from "../physician-screen";
import { PhysiciansScreen } from "../physicians-screen";
import { isActive } from "../studio-nav";
import { clearScreenCache } from "@/lib/screens/use-screen-tool";

const PID = "22222222-2222-4222-8222-222222222222";
const table = (tool: string, columns: string[], rows: Array<Record<string, string | number | null>>) => ({
  source: { tool, query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns,
  rows,
  row_count: rows.length,
});

const DATA: Record<string, unknown> = {
  overview_counts: table("overview_counts", ["metric", "value"], [
    { metric: "physicians_active", value: 41 },
    { metric: "incidents_open", value: 9 },
  ]),
  incident_summary: table("incident_summary", ["status", "polarity", "severity", "incidents"], [
    { status: "open", polarity: "negative", severity: "high", incidents: 4 },
  ]),
  signal_snapshots: table("signal_snapshots", ["day", "signal", "severity"], [{ day: "2026-10-20", signal: "Antibiotic gap", severity: "high" }]),
  interventions: table("interventions", ["intervention_id", "done_on", "signal_label", "kind", "action", "cdmss_sync_state"], []),
  physician_profile: table(
    "physician_profile",
    ["physician_id", "full_name", "preferred_name", "primary_specialty", "current_status", "date_joined_network", "registration_council", "registration_expiry", "engagements"],
    [{ physician_id: PID, full_name: "Dr A", preferred_name: null, primary_specialty: "Neurology", current_status: "active", date_joined_network: "2024-01-01", registration_council: "KMC", registration_expiry: "2027-01-01", engagements: "RR consultant active | KH visiting active" }],
  ),
  list_physicians: table("list_physicians", ["physician_id", "full_name", "primary_specialty", "current_status", "date_joined_network", "hospitals"], [
    { physician_id: PID, full_name: "Dr A", primary_specialty: "Neurology", current_status: "active", date_joined_network: "2024-01-01", hospitals: "RR" },
  ]),
};

const fetchMock = vi.fn();
beforeEach(() => {
  clearScreenCache();
  contexts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const tool = String(url).split("/").pop() as string;
    return new Response(JSON.stringify(DATA[tool]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("screens", () => {
  it("overview: tiles and tables load through the screen route and each shows its source line", async () => {
    render(<OverviewScreen />);
    await waitFor(() => expect(screen.getByText("Active physicians")).toBeInTheDocument());
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/0123456789ab/).length).toBeGreaterThanOrEqual(4);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(
      expect.arrayContaining(["/studio/api/screen/overview_counts", "/studio/api/screen/incident_summary", "/studio/api/screen/signal_snapshots", "/studio/api/screen/interventions"]),
    );
    for (const [, init] of fetchMock.mock.calls) expect(init.method).toBe("POST");
  });

  it('labels the incidents table "patient feedback", never "incidents"', async () => {
    render(<OverviewScreen />);
    await waitFor(() => expect(screen.getByText("Open patient feedback")).toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Patient feedback" })).toBeInTheDocument();
    // Only the tool name and the explicit e-IRIS disclaimer may say "incident".
    expect((document.body.textContent ?? "").replaceAll("incident_summary", "").replaceAll("e-IRIS incident register", "")).not.toMatch(/incident/i);
  });

  it("overview: exposes screen, filters and the exact tool calls to the assistant", async () => {
    render(<OverviewScreen />);
    await waitFor(() => expect(screen.getByText("Active physicians")).toBeInTheDocument());
    const last = contexts.at(-1)!.value as { screen: string; filters: unknown; reads: Array<{ tool: string; row_count: number | null }> };
    expect(last.screen).toBe("overview");
    expect(last.filters).toEqual({ patient_feedback_window_days: 30 });
    expect(last.reads.map((r) => r.tool).sort()).toEqual(["incident_summary", "interventions", "overview_counts", "signal_snapshots"]);
    expect(last.reads.find((r) => r.tool === "overview_counts")?.row_count).toBe(2);
    expect(JSON.stringify(last)).not.toContain("Antibiotic gap"); // ids and shapes only, no row content
  });

  it("roster: links each physician to the 360 and exposes filters", async () => {
    render(<PhysiciansScreen />);
    const link = await screen.findByRole("link", { name: "Dr A" });
    expect(link).toHaveAttribute("href", `/studio/physicians/${PID}`);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ filter: {}, limit: 200, offset: 0 });
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "physicians" });
  });

  it("roster: clicking anywhere on a row opens that physician's 360", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<PhysiciansScreen />);
    const cell = await screen.findByText("Neurology");
    fireEvent.click(cell);
    expect(assign).toHaveBeenCalledWith(`/studio/physicians/${PID}`);
    // A click on the name's own link is left to the link.
    assign.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "Dr A" }));
    expect(assign).not.toHaveBeenCalled();
  });

  it("roster: pages through every match with offset and shows the total", async () => {
    const row = (i: number) => ({ physician_id: PID, full_name: `Dr ${i}`, primary_specialty: "Neurology", current_status: "active", date_joined_network: "2024-01-01", hospitals: "RR" });
    const cols = ["physician_id", "full_name", "primary_specialty", "current_status", "date_joined_network", "hospitals"];
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { offset } = JSON.parse(init.body);
      const n = offset === 0 ? 200 : 66;
      return new Response(JSON.stringify({ ...table("list_physicians", cols, Array.from({ length: n }, (_, i) => row(offset + i))), total: 266 }), { status: 200 });
    });
    render(<PhysiciansScreen />);
    await screen.findAllByText("Showing 1–200 of 266");
    expect(screen.getAllByRole("button", { name: "Previous" })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Next" })[0]);
    await screen.findAllByText("Showing 201–266 of 266");
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ limit: 200, offset: 200 });
    expect(screen.getAllByRole("button", { name: "Next" })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Previous" })[0]);
    await screen.findAllByText("Showing 1–200 of 266");
  });

  it("physician 360: reads three tools for the selected id and exposes it", async () => {
    render(<PhysicianScreen id={PID} />);
    await screen.findByText("Neurology");
    expect(screen.getByText("RR consultant active")).toBeInTheDocument();
    const calls = fetchMock.mock.calls.map((c) => [c[0], JSON.parse(c[1].body)]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["/studio/api/screen/physician_profile", { physician_id: PID }],
        ["/studio/api/screen/signal_snapshots", { physician_id: PID, window_days: 90, limit: 50 }],
        ["/studio/api/screen/interventions", { physician_id: PID, limit: 50 }],
      ]),
    );
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "physician_360", selected: { physician_id: PID } });
    expect(screen.getByText(/nothing here is attributed to this physician/)).toBeInTheDocument();
  });

  it("physician 360: an invalid id makes no request", async () => {
    render(<PhysicianScreen id="not-a-uuid" />);
    expect(screen.getByRole("alert")).toHaveTextContent("not valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed read shows a fixed message with retry and no upstream text", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "tool_failed", message: "password=hunter2" }), { status: 502 }));
    render(<PhysiciansScreen />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("nav marks the current section", () => {
    expect(isActive("/physicians/abc", "/physicians")).toBe(true);
    expect(isActive("/overview", "/physicians")).toBe(false);
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/overview", "/")).toBe(false);
  });
});
