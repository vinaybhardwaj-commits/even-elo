// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { loadLiveStaff } from "../live-staff";

describe("loadLiveStaff", () => {
  afterEach(() => {
    delete process.env.GOV_RO_DATABASE_URL;
  });

  it("maps the row", async () => {
    expect(await loadLiveStaff("p", async () => [{ status: "active", is_super_admin: true }])).toEqual({ status: "active", is_super_admin: true });
    expect(await loadLiveStaff("p", async () => [{ status: "active", is_super_admin: null }])).toEqual({ status: "active", is_super_admin: false });
  });
  it("is null for no row, an error, an empty id, or no connection string (no network attempted)", async () => {
    expect(await loadLiveStaff("p", async () => [])).toBeNull();
    expect(await loadLiveStaff("p", async () => { throw new Error("db down"); })).toBeNull();
    expect(await loadLiveStaff("", async () => [{ status: "active", is_super_admin: true }])).toBeNull();
    expect(await loadLiveStaff("p")).toBeNull();
  });
});
