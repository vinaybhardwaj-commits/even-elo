import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const contexts: Array<{ value: Record<string, unknown> }> = [];
vi.mock("@copilotkit/react-core/v2", () => ({ useAgentContext: (c: { value: Record<string, unknown> }) => void contexts.push(c) }));
vi.mock("../screen-frame", () => ({
  ScreenFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

import { IncidentsScreen } from "../incidents-screen";
import { FeedbackScreen } from "../feedback-screen";
import { NAV_ITEMS } from "../studio-nav";

const IID = "EHRC-INC-2026-0001";
const FID = "33333333-3333-4333-8333-333333333333";
type Cells = Record<string, string | number | boolean | null>;
const tbl = (tool: string, columns: string[], rows: Cells[]) => ({ source: { tool, query_hash: "0123456789ab" }, mode: "live", synthetic: false, columns, rows, row_count: rows.length });

const fetchMock = vi.fn();
let feedbackEnabled = false;
let textStatus = 200;
beforeEach(() => {
  contexts.length = 0;
  feedbackEnabled = false;
  textStatus = 200;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith("/screen/eiris_incidents")) {
      return new Response(
        JSON.stringify(
          body.view === "list"
            ? tbl("eiris_incidents", ["id", "reported_at", "severity", "state", "type", "department", "has_rca", "sla_state", "due_at"], [{ id: IID, reported_at: "2026-10-01", severity: "major", state: "open", type: "Fall", department: "Ward", has_rca: true, sla_state: "overdue", due_at: null }])
            : tbl("eiris_incidents", ["scope", "key", "open", "closed", "total"], [{ scope: "severity", key: "major", open: 1, closed: 0, total: 1 }, { scope: "totals", key: "overdue", open: null, closed: null, total: 2 }]),
        ),
        { status: 200 },
      );
    }
    if (u.endsWith("/screen/eiris_incident_detail")) {
      if (body.include_text && textStatus !== 200) return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: textStatus });
      return new Response(JSON.stringify(tbl("eiris_incident_detail", ["section", "field", "value"], [{ section: "incident", field: "type", value: "Fall" }, ...(body.include_text ? [{ section: "text", field: "narrative", value: "SHOWN-TEXT" }] : [])])), { status: 200 });
    }
    if (u.endsWith("/feedback/list")) {
      return new Response(
        JSON.stringify({
          write_enabled: feedbackEnabled,
          items: tbl("patient_feedback", ["feedback_id", "physician_id", "physician_name", "submitted_at", "hospital_code", "source", "category", "severity", "polarity", "status", "reply_state", "last_reply_at", "reply_count"], [
            { feedback_id: FID, physician_id: "p1", physician_name: "Dr A", submitted_at: "2026-10-01T10:00:00Z", hospital_code: "RR", source: "patient", category: "clinical", severity: "high", polarity: "negative", status: "open", reply_state: "no reply", last_reply_at: null, reply_count: 0 },
          ]),
          counts: tbl("patient_feedback_counts", ["status", "severity", "feedback"], [{ status: "open", severity: "high", feedback: 4 }]),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IncidentsScreen (e-IRIS)", () => {
  it("is labelled e-IRIS, shows counts and the register with source lines, and the context carries ids and filters only", async () => {
    render(<IncidentsScreen />);
    expect(screen.getByRole("heading", { name: "e-IRIS incidents" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: IID })).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line")[0]).toHaveTextContent("Source: eiris_incidents · query 0123456789ab");
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: IID }));
    expect(await screen.findByText("Incident EHRC-INC-2026-0001")).toBeInTheDocument();
    await waitFor(() => expect(contexts.at(-1)!.value).toMatchObject({ screen: "incidents", selected: { incident_id: IID } }));
    const ctx = JSON.stringify(contexts.at(-1)!.value);
    expect(ctx).not.toContain("Fall");
    expect(ctx).not.toContain("include_text");
  });

  it("free text is off until asked for; a refusal (non super_admin) is explained and can be turned off", async () => {
    render(<IncidentsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: IID }));
    await screen.findByText("Incident EHRC-INC-2026-0001");
    expect(screen.queryByText("SHOWN-TEXT")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.body && JSON.parse(String(i.body)).include_text)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show free text" }));
    expect(await screen.findByText("SHOWN-TEXT")).toBeInTheDocument();
    expect(JSON.stringify(contexts.at(-1)!.value)).not.toContain("SHOWN-TEXT");
    textStatus = 403;
    fireEvent.click(screen.getByRole("button", { name: "Hide free text" }));
    await screen.findByText("Incident EHRC-INC-2026-0001");
    fireEvent.click(screen.getByRole("button", { name: "Show free text" }));
    expect(await screen.findByText("Narrative and RCA text is for super_admin only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide free text" })).toBeInTheDocument();
  });
});

describe("FeedbackScreen (patient feedback)", () => {
  it("is labelled patient feedback, not e-IRIS; context carries ids and filters only", async () => {
    render(<FeedbackScreen />);
    expect(screen.getByRole("heading", { name: "Patient feedback" })).toBeInTheDocument();
    expect(await screen.findByText("no reply")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line")[0]).toHaveTextContent("Source: patient_feedback_counts · query 0123456789ab");
    fireEvent.click(screen.getByRole("button", { name: "2026-10-01" }));
    await waitFor(() => expect(contexts.at(-1)!.value).toMatchObject({ screen: "feedback", selected: { feedback_id: FID } }));
    expect(JSON.stringify(contexts.at(-1)!.value)).not.toContain("Dr A");
  });

  it("the retract card is disabled with the second-factor note and nothing is posted", async () => {
    render(<FeedbackScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "2026-10-01" }));
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    expect(screen.getByTestId("second-factor-note")).toHaveTextContent("Needs second factor");
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith("/list"))).toBe(true);
  });

  it("with writes enabled, nothing is sent until Review, a reason, then Confirm", async () => {
    feedbackEnabled = true;
    render(<FeedbackScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "2026-10-01" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "entered in error" } });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/retract"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/retract"))).toBe(true));
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/retract"))!;
    expect(JSON.parse(post[1].body)).toEqual({ feedback_id: FID, retraction_reason: "entered in error" });
  });
});

describe("nav", () => {
  it("lists both screens under distinct labels", () => {
    const labels = NAV_ITEMS.map((i) => i.label);
    expect(labels).toContain("e-IRIS incidents");
    expect(labels).toContain("Patient feedback");
  });
});
