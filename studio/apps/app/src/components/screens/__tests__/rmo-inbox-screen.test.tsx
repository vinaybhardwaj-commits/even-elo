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

import { RmoInboxScreen } from "../rmo-inbox-screen";
import { isActive } from "../studio-nav";

const FID = "33333333-3333-4333-8333-333333333333";
const tbl = (columns: string[], rows: Array<Record<string, string | number | boolean | null>>) => ({
  source: { tool: "rmo_inbox", query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns,
  rows,
  row_count: rows.length,
});
const payload = (write_enabled: boolean) => ({
  write_enabled,
  items: tbl(["finding_id", "finding_label", "severity", "status", "physician_id", "physician_name", "portal_visible", "author_pending", "authored_by_name"], [
    { finding_id: FID, finding_label: "Missing plan", severity: "high", status: "open", physician_id: "p1", physician_name: "Dr A", portal_visible: false, author_pending: true, authored_by_name: "pending" },
  ]),
  counts: tbl(["metric", "value"], [{ metric: "pipe_open", value: 2 }, { metric: "sla_risk", value: 1 }]),
  exceptions: tbl(["finding_id", "finding_label"], []),
});

const fetchMock = vi.fn();
let enabled = false;
beforeEach(() => {
  contexts.length = 0;
  enabled = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/inbox")) return new Response(JSON.stringify(payload(enabled)), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RmoInboxScreen", () => {
  it("shows counts and findings with the source line, and the chat context carries ids and filters only", async () => {
    render(<RmoInboxScreen />);
    expect(await screen.findByText("Missing plan")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line")[0]).toHaveTextContent("Source: rmo_inbox · query 0123456789ab · 1 row");
    fireEvent.click(screen.getByRole("button", { name: "Missing plan" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Finding detail" })).toBeInTheDocument());
    const last = contexts.at(-1)!.value;
    expect(last).toMatchObject({ screen: "rmo-inbox", selected: { finding_id: FID }, filters: { pipe: "all" } });
    expect(JSON.stringify(last)).not.toContain("Dr A");
    expect(JSON.stringify(last)).not.toContain("Missing plan");
  });

  it("confirm cards are disabled with the second-factor note, and nothing is posted", async () => {
    render(<RmoInboxScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Missing plan" }));
    const reviews = screen.getAllByRole("button", { name: "Review" });
    expect(reviews).toHaveLength(2);
    reviews.forEach((b) => expect(b).toBeDisabled());
    expect(screen.getAllByTestId("second-factor-note")[0]).toHaveTextContent("Needs second factor");
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith("/inbox"))).toBe(true);
  });

  it("with writes enabled, nothing is sent until Review then Confirm", async () => {
    enabled = true;
    render(<RmoInboxScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Missing plan" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Review" })[1]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/release"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/release"))).toBe(true));
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/release"))!;
    expect(JSON.parse(post[1].body)).toEqual({ finding_id: FID });
  });

  it("nav marks the screen active", () => {
    expect(isActive("/rmo-inbox", "/rmo-inbox")).toBe(true);
  });
});
