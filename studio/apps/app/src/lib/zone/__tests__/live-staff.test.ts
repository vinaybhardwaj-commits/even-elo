// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { loadLiveStaff } from "../live-staff";

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
