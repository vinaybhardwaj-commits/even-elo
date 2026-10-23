import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const contexts: Array<{ value: Record<string, unknown> }> = [];
vi.mock("@copilotkit/react-core/v2", () => ({ useAgentContext: (c: { value: Record<string, unknown> }) => void contexts.push(c) }));
vi.mock("@/components/screens/screen-frame", () => ({
  ScreenFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (<main><h1>{title}</h1>{children}</main>),
}));

import { ContributorsScreen, DoctorsScreen, RedFlagsScreen, ScorecardScreen, ThisWeekScreen, WorklistsScreen } from "../screens";
import { clearCdmssCache } from "@/lib/cdmss/use-cdmss-view";
import { FIXTURES } from "@/lib/cdmss/fixtures";
import { NAV_ITEMS } from "@/components/screens/studio-nav";

const fetchMock = vi.fn();
beforeEach(() => {
  clearCdmssCache();
  contexts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const view = String(url).split("/").pop() as keyof typeof FIXTURES;
    return new Response(JSON.stringify(FIXTURES[view]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => cleanup());

const CASES: Array<[string, () => React.JSX.Element, string, RegExp]> = [
  ["this_week", ThisWeekScreen, "this_week", /Coming/],
  ["scorecard", ScorecardScreen, "scorecard", /Mean NQI/],
  ["doctors", DoctorsScreen, "doctors", /Dr Asha Rao/],
  ["contributors", ContributorsScreen, "contributors", /Dr Bimal Nair/],
  ["red_flags", RedFlagsScreen, "red_flags", /Antibiotic for acute URTI/],
  ["worklists", WorklistsScreen, "worklists", /open case/],
];

describe.each(CASES)("%s", (_n, Comp, view, text) => {
  it("renders the envelope, makes exactly one read, and tells the agent which view is open", async () => {
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId("provenance")).toBeInTheDocument());
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getByText(/Look first:/)).toBeInTheDocument();
    expect(screen.getByLabelText("Caveats")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/studio/api/cdmss/${view}`);
    const last = contexts[contexts.length - 1].value;
    expect(last).toMatchObject({ screen: `cdmss/${view}`, view, status: "ok" });
    expect(JSON.stringify(last)).not.toContain("Dr Asha"); // no row content in the agent context
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1); // no loop
  });
});

describe("behaviour", () => {
  it("doctors below 10 notes are listed greyed, unranked", async () => {
    render(<DoctorsScreen />);
    const un = await screen.findByTestId("unranked");
    expect(un).toHaveTextContent("Dr Dev Menon (n 6)");
    expect(screen.queryByRole("row", { name: /Dev Menon/ })).toBeNull();
  });
  it("a changed filter makes exactly one more read", async () => {
    render(<DoctorsScreen />);
    await screen.findByTestId("provenance");
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "M-OPD-06" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
  it("a route error is shown with Retry and is not retried automatically", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 }));
    render(<ScorecardScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role cannot open this module");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a payload without its envelope is refused", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ tiles: [] }), { status: 200 }));
    render(<ThisWeekScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("shape this view does not understand");
  });
  it("worklist exports CSV without a request", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    render(<WorklistsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("nav has the CDMSS entry", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/cdmss")).toBe(true);
  });
});
