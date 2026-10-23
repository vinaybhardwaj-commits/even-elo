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

const CASES: Array<[string, () => React.JSX.Element, string, RegExp, number]> = [
  ["this_week", ThisWeekScreen, "this_week", /Coming/, 1],
  ["scorecard", ScorecardScreen, "scorecard", /Mean OPD NQI/, 1],
  ["doctor_variation", DoctorsScreen, "doctor_variation", /Dr Five/, 1],
  ["contributors", ContributorsScreen, "contributors", /Dr Two/, 2], // V2 for the site list, then V4
  ["redflags", RedFlagsScreen, "redflags", /Dr Five/, 1],
  ["worklists", WorklistsScreen, "worklists", /CDMSS page \(link unverified\)/, 1],
];

describe.each(CASES)("%s", (_n, Comp, view, text, reads) => {
  it("renders the envelope, makes the expected reads once, and tells the agent which view is open", async () => {
    render(<Comp />);
    await waitFor(() => expect(screen.getByTestId("provenance")).toBeInTheDocument());
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getByText(/Look first:/)).toBeInTheDocument();
    expect(screen.getByText(/wrong or contested/)).toBeInTheDocument();
    expect(screen.getByLabelText("Caveats")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(reads);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/studio/api/cdmss/${view}`);
    const last = contexts[contexts.length - 1].value;
    expect(last).toMatchObject({ screen: `cdmss/${view}`, view, status: "ok" });
    expect(JSON.stringify(last)).not.toContain("Dr Five"); // no row content in the agent context
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(reads); // no loop
  });
});

describe("behaviour", () => {
  it("doctors below 10 notes are listed greyed, unranked", async () => {
    render(<DoctorsScreen />);
    const un = await screen.findByTestId("unranked");
    expect(un).toHaveTextContent("Dr Three (n 5)");
    expect(screen.queryByRole("row", { name: /Dr Three/ })).toBeNull();
  });
  it("a changed filter makes exactly one more read", async () => {
    render(<DoctorsScreen />);
    await screen.findByTestId("provenance");
    fireEvent.change(screen.getByLabelText("Measure"), { target: { value: "nqi" } });
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
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ view: { families: [] } }), { status: 200 }));
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
  it("sends the typed params for the open filters (body is the params, nothing else)", async () => {
    render(<DoctorsScreen />);
    await screen.findByTestId("provenance");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ family: "opd", metric: "lv_rate", window_days: 28 });
  });
  it("unavailable metrics say so with the reason", async () => {
    render(<ThisWeekScreen />);
    expect((await screen.findAllByText(/unavailable: No WHO AWaRe/)).length).toBeGreaterThan(0);
  });
  it("V2 shows one band-mix bar per site from the agent's per-band stats", async () => {
    render(<ScorecardScreen />);
    await screen.findByTestId("provenance");
    const section = screen.getByLabelText("Band mix");
    expect(section.querySelectorAll("svg[role=img]").length).toBe(3);
    expect(section).toHaveTextContent("SITEA");
  });
  it("a site whose bands are under min-n shows its counts only", async () => {
    const v2 = JSON.parse(JSON.stringify(FIXTURES.scorecard));
    v2.view.band_mix[2].bands.A.status = "count_only";
    v2.view.band_mix[2].bands.A.value = null;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(v2), { status: 200 }));
    render(<ScorecardScreen />);
    expect(await screen.findByTestId("mix-grey")).toHaveTextContent("count only");
  });
  it("site pickers come from the agent's sites: V2 keeps All, V4 asks for the busiest site", async () => {
    render(<ScorecardScreen />);
    await screen.findByTestId("provenance");
    const opts = Array.from(screen.getByLabelText("Site").querySelectorAll("option")).map((o) => o.textContent);
    expect(opts).toEqual(["All sites (175 notes)", "SITEA (140 notes)", "SITEB (35 notes)"]);
    cleanup();
    clearCdmssCache();
    fetchMock.mockClear();
    render(<ContributorsScreen />);
    await screen.findByTestId("provenance");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ site: "SITEA" });
    expect(Array.from(screen.getByLabelText("Site").querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["SITEA", "SITEB"]);
  });
  it("every case link is labelled unverified unless the agent says verified", async () => {
    render(<RedFlagsScreen />);
    await screen.findByTestId("provenance");
    const links = screen.getAllByRole("link", { name: /CDMSS page/ });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l).toHaveTextContent("CDMSS page (link unverified)");
    cleanup();
    clearCdmssCache();
    const v5 = JSON.parse(JSON.stringify(FIXTURES.redflags));
    v5.view.dossiers[0].evidence[0].case.url_verified = true;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(v5), { status: 200 }));
    render(<RedFlagsScreen />);
    await screen.findByTestId("provenance");
    expect(screen.getAllByRole("link", { name: "CDMSS page" })).toHaveLength(1);
  });
  it("nav has the CDMSS entry", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/cdmss")).toBe(true);
  });
});
