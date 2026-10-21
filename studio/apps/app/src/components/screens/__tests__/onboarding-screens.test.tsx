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

import { OnboardingCredentialsScreen, OnboardingNewScreen, OnboardingPipelineScreen, OnboardingPrescreenScreen } from "../onboarding-screens";
import { ConfirmCard } from "../onboarding-parts";

const PS = "11111111-1111-4111-8111-111111111111";
const HOSP = "22222222-2222-4222-8222-222222222222";
const table = (tool: string, columns: string[], rows: Array<Record<string, string | number | boolean | null>>) => ({
  source: { tool, query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns,
  rows,
  row_count: rows.length,
});
const DATA: Record<string, unknown> = {
  onboarding_overview: table("onboarding_overview", ["metric", "value", "note"], [{ metric: "stage_observation", value: 7, note: null }]),
  onboarding_pipeline: table("onboarding_pipeline", ["prescreen_id", "full_name", "stage"], [{ prescreen_id: PS, full_name: "Dr Example", stage: "observation" }]),
  onboarding_hospitals: table("onboarding_hospitals", ["code", "name", "hospital_id"], [{ code: "H1", name: "Hospital One", hospital_id: HOSP }]),
  onboarding_pending_credentials: table("onboarding_pending_credentials", ["physician", "degree", "physician_id", "qualification_id"], [{ physician: "Dr Q", degree: "MS", physician_id: "p1", qualification_id: "q1" }]),
};
const prescreen = (section: string) =>
  section === "observations"
    ? table("onboarding_prescreen", ["case_number", "procedure"], [{ case_number: 1, procedure: "TKR" }])
    : table("onboarding_prescreen", ["metric", "value"], [{ metric: "stage", value: "observation" }]);

const fetchMock = vi.fn();
beforeEach(() => {
  contexts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const tool = String(url).split("/").pop() as string;
    if (tool === "onboarding_prescreen") return new Response(JSON.stringify(prescreen(JSON.parse(String(init?.body)).section)), { status: 200 });
    return new Response(JSON.stringify(DATA[tool]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrote = () => fetchMock.mock.calls.some((c) => String(c[0]).includes("/write/"));

describe("onboarding screens", () => {
  it("pipeline: tiles and table load through /studio/api/onboarding with source lines; the agent gets filters only", async () => {
    render(<OnboardingPipelineScreen />);
    await waitFor(() => expect(screen.getByText("Dr Example")).toBeInTheDocument());
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/0123456789ab/).length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["/studio/api/onboarding/onboarding_overview", "/studio/api/onboarding/onboarding_pipeline"]));
    const ctx = contexts.at(-1)!.value;
    expect(ctx.screen).toBe("onboarding_pipeline");
    expect(JSON.stringify(ctx)).not.toContain("Dr Example");
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "decision" } });
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ stage: "decision" }));
  });

  it("pre-screen: summary and observations, context carries the id only, a decision opens a disabled card", async () => {
    render(<OnboardingPrescreenScreen id={PS} />);
    await waitFor(() => expect(screen.getByText("TKR")).toBeInTheDocument());
    expect(contexts.at(-1)!.value).toMatchObject({ screen: "onboarding_prescreen", selected: { prescreen_id: PS } });
    expect(JSON.stringify(contexts.at(-1)!.value)).not.toContain("TKR");
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "FPPE satisfactory" } });
    fireEvent.click(screen.getByRole("button", { name: "Review decision" }));
    const card = await screen.findByTestId("confirm-card");
    expect(card).toHaveTextContent("Record a decision");
    expect(card).toHaveTextContent("FPPE satisfactory");
    expect(screen.getByTestId("second-factor-note")).toHaveTextContent(/second factor/i);
    const confirm = screen.getByRole("button", { name: /Confirm and apply/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(wrote()).toBe(false);
  });

  it("new pre-screen: invite needs every commitment; review builds a card and posts nothing", async () => {
    render(<OnboardingNewScreen />);
    await waitFor(() => expect(screen.getByText("H1")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dr@example.test" } });
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Dr New" } });
    fireEvent.click(screen.getByLabelText("H1"));
    fireEvent.click(screen.getByRole("button", { name: "Review pre-screen" }));
    expect(screen.queryByTestId("confirm-card")).toBeNull();
    for (const l of [/OT timings/, /formulary/, /Vendor MOUs/, /Rental-equipment/, /Weekend/]) fireEvent.click(screen.getByLabelText(l));
    fireEvent.click(screen.getByRole("button", { name: "Review pre-screen" }));
    expect(await screen.findByTestId("confirm-card")).toHaveTextContent("Dr New");
    expect(wrote()).toBe(false);
  });

  it("credentials: loads the pending table without ids", async () => {
    render(<OnboardingCredentialsScreen />);
    await waitFor(() => expect(screen.getByText("Dr Q")).toBeInTheDocument());
    expect(screen.queryByText("q1")).toBeNull();
  });

  it("the card posts the exact params once a second factor is available, and reports a refusal in fixed text", async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "conflict" }), { status: 409 }));
    render(<ConfirmCard action="prescreen_decision" params={{ prescreen_id: PS, decision: "terminate", rationale: "r" }} summary={[["Decision", "terminate"]]} onClose={() => {}} onDone={onDone} secondFactor />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm and apply/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/record state/i));
    expect(fetchMock).toHaveBeenCalledWith("/studio/api/onboarding/write/prescreen_decision", expect.objectContaining({ method: "POST", body: JSON.stringify({ prescreen_id: PS, decision: "terminate", rationale: "r" }) }));
    expect(onDone).not.toHaveBeenCalled();
  });
});
