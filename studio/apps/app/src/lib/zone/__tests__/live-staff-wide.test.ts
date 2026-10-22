// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: () => sqlMock }));

import { LIVE_STAFF_SQL, LIVE_STAFF_WIDE_SQL, loadLiveStaff } from "../live-staff";

describe("loadLiveStaff role flags", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    process.env.GOV_RO_DATABASE_URL = "postgres://ro.invalid/db";
  });

  it("reads the hospital-role flags when the read role may see them", async () => {
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: false, is_sgc_member: true, is_site_medical_head: false, is_hr: true, must_change_pin: false }]);
    expect(await loadLiveStaff("p")).toMatchObject({ is_sgc_member: true, is_hr: true, is_site_medical_head: false });
    expect(sqlMock.mock.calls[0][0]).toBe(LIVE_STAFF_WIDE_SQL);
  });

  it("falls back to the narrow read (flags false = plain staff) while the columns are not granted, without retrying", async () => {
    sqlMock.mockRejectedValueOnce(Object.assign(new Error("permission denied for view profiles_with_roles"), { code: "42501" }));
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: true, must_change_pin: false }]);
    const live = await loadLiveStaff("p");
    expect(live).toMatchObject({ status: "active", is_super_admin: true, is_sgc_member: false, is_hr: false, is_site_medical_head: false });
    expect(sqlMock.mock.calls[1][0]).toBe(LIVE_STAFF_SQL);
  });

  it("retries a transient wide-read error once and keeps the flags", async () => {
    sqlMock.mockRejectedValueOnce(new Error("fetch failed"));
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: false, is_sgc_member: true, is_site_medical_head: false, is_hr: false, must_change_pin: false }]);
    expect(await loadLiveStaff("p")).toMatchObject({ is_sgc_member: true });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlMock.mock.calls.every((c) => c[0] === LIVE_STAFF_WIDE_SQL)).toBe(true);
  });

  it("does not cache a narrow result: the next request tries the wide read again", async () => {
    sqlMock.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "42501" }));
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: false, must_change_pin: false }]);
    await loadLiveStaff("p");
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: false, is_sgc_member: true, is_site_medical_head: false, is_hr: false, must_change_pin: false }]);
    expect(await loadLiveStaff("p")).toMatchObject({ is_sgc_member: true });
  });
});
