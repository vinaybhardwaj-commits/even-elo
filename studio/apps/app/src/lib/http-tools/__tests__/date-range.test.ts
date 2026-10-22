// @vitest-environment node
import { describe, expect, it } from "vitest";
import { boundMs, inRange } from "../transform";
import { findingsWindowDays } from "../run";

describe("date ranges", () => {
  it("bare dates are Asia/Kolkata calendar days and until includes the whole day", () => {
    // 2026-09-30T19:00Z is 00:30 on 1 Oct in Kolkata.
    expect(inRange("2026-09-30T19:00:00Z", { since: "2026-10-01" })).toBe(true);
    expect(inRange("2026-09-30T19:00:00Z", { until: "2026-09-30" })).toBe(false);
    expect(inRange("2026-09-30T18:29:59Z", { until: "2026-09-30" })).toBe(true);
    expect(boundMs("2026-10-01", false)).toBe(Date.parse("2026-09-30T18:30:00Z"));
    // Date-times keep their offset; without one they are Kolkata time.
    expect(boundMs("2026-10-01T10:00:00Z", false)).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(boundMs("2026-10-01T10:00", false)).toBe(Date.parse("2026-10-01T04:30:00Z"));
  });

  it("with a range, rows without a date are out; without one, everything is in", () => {
    expect(inRange(null, { since: "2026-10-01" })).toBe(false);
    expect(inRange("not a date", { until: "2026-10-01" })).toBe(false);
    expect(inRange(null, {})).toBe(true);
  });

  it("the CDMSS look-back window covers since, clamped to 1-365; an explicit window_days wins", () => {
    const now = Date.parse("2026-10-22T06:00:00Z");
    expect(findingsWindowDays({ since: "2026-09-23" }, now)).toBe(30);
    expect(findingsWindowDays({ since: "2020-01-01" }, now)).toBe(365);
    expect(findingsWindowDays({ since: "2026-10-22" }, now)).toBe(1);
    expect(findingsWindowDays({ since: "2026-09-01", window_days: 7 }, now)).toBe(7);
    expect(findingsWindowDays({}, now)).toBe(30);
  });
});
