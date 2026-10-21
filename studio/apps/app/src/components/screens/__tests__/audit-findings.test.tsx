// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RulingCard } from "../ruling-card";
import { groupSections } from "../audit-finding-screen";
import { NAV_ITEMS } from "../studio-nav";
import { toParams } from "../audit-findings-screen";

afterEach(cleanup);

describe("ruling card", () => {
  it("is disabled with a needs-second-factor note even when everything is filled in", () => {
    render(<RulingCard reference="EHRC-AUD-2026-0001" status="escalated" />);
    fireEvent.click(screen.getByLabelText(/Dismiss/));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "not applicable here" } });
    expect(screen.getByTestId("ruling-summary").textContent).toContain("EHRC-AUD-2026-0001");
    expect(screen.getByTestId("ruling-second-factor").textContent).toMatch(/second factor/i);
    expect((screen.getByRole("button", { name: "Confirm ruling" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("offers no action on a closed thread and only the legal ones on a ruled thread", () => {
    const { unmount } = render(<RulingCard reference="EHRC-AUD-2026-0001" status="closed" />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    unmount();
    render(<RulingCard reference="EHRC-AUD-2026-0001" status="ruled" />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});

describe("audit findings screen helpers", () => {
  it("is in the nav", () => expect(NAV_ITEMS.some((i) => i.href === "/audit-findings")).toBe(true));
  it("builds strict params from filters", () => {
    expect(toParams({ view: "all", status: "ruled", doctor: "D1", hospital: " ehrc " })).toEqual({ view: "all", limit: 200, status: "ruled", doctor_uid: "D1", hospital: "EHRC" });
    expect(toParams({ view: "attention", status: "", doctor: "", hospital: "no way" })).toEqual({ view: "attention", limit: 200 });
  });
  it("groups detail rows by section in order", () => {
    const g = groupSections([{ section: "a", field: "x", value: 1 }, { section: "b", field: "y", value: 2 }, { section: "a", field: "z", value: 3 }]);
    expect(g.map(([s, r]) => [s, r.length])).toEqual([["a", 2], ["b", 1]]);
  });
});
