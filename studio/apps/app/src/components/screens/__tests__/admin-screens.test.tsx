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

import { AdminUsersScreen } from "../admin-users-screen";
import { AdminResignationsScreen } from "../admin-resignations-screen";
import { AdminAuditScreen } from "../admin-audit-screen";
import { NAV_ITEMS } from "../studio-nav";
import { ADMIN_LINKS } from "../admin-parts";

const PID = "22222222-2222-4222-8222-222222222222";
const RID = "55555555-5555-4555-8555-555555555555";
type Cells = Record<string, string | number | boolean | null>;
const tbl = (tool: string, columns: string[], rows: Cells[]) => ({ source: { tool, query_hash: "0123456789ab" }, mode: "live", synthetic: false, columns, rows, row_count: rows.length });

const fetchMock = vi.fn();
let writeEnabled = false;
beforeEach(() => {
  contexts.length = 0;
  writeEnabled = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/admin/users"))
      return ok({
        write_enabled: writeEnabled,
        table: tbl("admin_users", ["profile_id", "full_name", "email", "status", "position_label", "hospital_code", "roles", "last_login_at"], [{ profile_id: PID, full_name: "Staff A", email: "a@even.in", status: "active", position_label: "HR", hospital_code: "RR", roles: "hr", last_login_at: "2026-10-01T00:00:00Z" }]),
        counts: tbl("admin_user_counts", ["status", "users"], [{ status: "active", users: 7 }]),
      });
    if (u.endsWith("/admin/roles")) return ok({ write_enabled: writeEnabled, table: tbl("admin_roles", ["hospital_code", "role", "granted_at"], [{ hospital_code: "RR", role: "hr", granted_at: "2026-02-01" }]) });
    if (u.endsWith("/admin/resignations"))
      return ok({ write_enabled: writeEnabled, table: tbl("admin_resignations", ["request_id", "physician_name", "hospital_code", "status", "intended_last_date", "requested_at"], [{ request_id: RID, physician_name: "Dr A", hospital_code: "RR", status: "pending", intended_last_date: "2026-12-01", requested_at: "2026-10-01" }]) });
    if (u.endsWith("/admin/audit")) return ok({ write_enabled: false, table: tbl("admin_audit", ["at", "actor_position", "action", "entity_type", "entity_id"], [{ at: "2026-10-01", actor_position: "Super", action: "grant_role", entity_type: "profile", entity_id: PID }]) });
    if (u.includes("/admin/set_status") || u.includes("/admin/process_resignation") || u.includes("/admin/grant_role")) return ok({ ok: true });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin screens", () => {
  it("users: source lines on every table, counts tile, flags as roles; confirm cards disabled with the second-factor note", async () => {
    render(<AdminUsersScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Staff A" }));
    await screen.findByRole("heading", { name: /Hospital roles · Staff A/ });
    expect(screen.getAllByTestId("source-line").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getAllByTestId("second-factor-note")).toHaveLength(2);
    for (const b of screen.getAllByRole("button", { name: "Review" })) expect(b).toBeDisabled();
  });

  it("users: with the second factor, Review then Confirm posts the write; no delete or revoke control exists", async () => {
    writeEnabled = true;
    render(<AdminUsersScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Staff A" }));
    await screen.findByRole("group", { name: "Set account status" });
    fireEvent.change(screen.getByLabelText("New status"), { target: { value: "suspended" } });
    const group = screen.getByRole("group", { name: "Set account status" });
    fireEvent.click(group.querySelector("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/admin/set_status"))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/admin/set_status"))!;
    expect(JSON.parse(String(call[1].body))).toEqual({ profile_id: PID, status: "suspended" });
    expect(screen.queryByRole("button", { name: /delete|revoke|remove|reset/i })).toBeNull();
  });

  it("users: the chat context carries ids and filters only, never names or emails", async () => {
    render(<AdminUsersScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Staff A" }));
    await screen.findAllByText("Hospital roles", { exact: false });
    const text = JSON.stringify(contexts.map((c) => c.value));
    expect(text).toContain(PID);
    expect(text).toContain("admin_users");
    expect(text).not.toMatch(/Staff A|a@even\.in/);
  });

  it("resignations: shows the list with a source line and the process card; the reason is a column", async () => {
    render(<AdminResignationsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "2026-10-01" }));
    expect(await screen.findByRole("group", { name: "Process resignation" })).toBeInTheDocument();
    expect(screen.getByTestId("source-line")).toHaveTextContent("admin_resignations");
    expect(screen.getByText(/reason/i, { selector: "th" })).toBeInTheDocument();
    expect(screen.getByTestId("second-factor-note")).toBeInTheDocument();
    expect(JSON.stringify(contexts.map((c) => c.value))).not.toContain("Dr A");
  });

  it("audit: filters go to the tool; the table shows its source line", async () => {
    render(<AdminAuditScreen />);
    await screen.findByText("grant_role");
    expect(screen.getByTestId("source-line")).toHaveTextContent("admin_audit");
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "grant_role" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.body && JSON.parse(String(i.body)).action === "grant_role")).toBe(true));
  });

  it("nav has one Admin entry; the admin subnav links the three screens and none of the ops pages", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href) as string[];
    expect(hrefs).toContain("/admin/users");
    const sub = ADMIN_LINKS.map((l) => l.href) as string[];
    expect(sub).toEqual(["/admin/users", "/admin/resignations", "/admin/audit"]);
    expect([...hrefs, ...sub].join()).not.toMatch(/migrate|seed|wipe|dedupe|recompute/);
  });
});
