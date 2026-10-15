// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_STAFF_SQL, loadLiveStaff } from "../live-staff";

describe("LIVE_STAFF_SQL", () => {
  it("reads must_change_pin from the base table, never from the frozen view", () => {
    expect(LIVE_STAFF_SQL).toMatch(/SELECT base\.must_change_pin FROM profiles base WHERE base\.id = p\.id/);
    expect(LIVE_STAFF_SQL).not.toMatch(/p\.must_change_pin/);
    expect(LIVE_STAFF_SQL).toContain("$1::uuid");
  });
});

describe("loadLiveStaff", () => {
  afterEach(() => {
    delete process.env.GOV_RO_DATABASE_URL;
  });

  it("maps the row", async () => {
    expect(await loadLiveStaff("p", async () => [{ status: "active", is_super_admin: true, must_change_pin: false }])).toEqual({ status: "active", is_super_admin: true, must_change_pin: false });
    expect(await loadLiveStaff("p", async () => [{ status: "active", is_super_admin: null, must_change_pin: true }])).toEqual({ status: "active", is_super_admin: false, must_change_pin: true });
    // An unreadable PIN flag fails closed.
    expect((await loadLiveStaff("p", async () => [{ status: "active", is_super_admin: true, must_change_pin: null }]))?.must_change_pin).toBe(true);
  });
  it("is null for no row, an error, an empty id, or no connection string (no network attempted)", async () => {
    expect(await loadLiveStaff("p", async () => [])).toBeNull();
    expect(await loadLiveStaff("p", async () => { throw new Error("db down"); })).toBeNull();
    expect(await loadLiveStaff("", async () => [{ status: "active", is_super_admin: true, must_change_pin: false }])).toBeNull();
    expect(await loadLiveStaff("p")).toBeNull();
  });
});
