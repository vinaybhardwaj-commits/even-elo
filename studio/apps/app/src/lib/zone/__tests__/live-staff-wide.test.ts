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

  it("falls back to the narrow read (flags false = plain staff) while the columns are not granted", async () => {
    sqlMock.mockRejectedValueOnce(new Error("permission denied for view profiles_with_roles"));
    sqlMock.mockResolvedValueOnce([{ status: "active", is_super_admin: true, must_change_pin: false }]);
    const live = await loadLiveStaff("p");
    expect(live).toMatchObject({ status: "active", is_super_admin: true, is_sgc_member: false, is_hr: false, is_site_medical_head: false });
    expect(sqlMock.mock.calls[1][0]).toBe(LIVE_STAFF_SQL);
  });
});
