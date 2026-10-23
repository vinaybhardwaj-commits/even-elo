import { describe, expect, it } from "vitest";
import { Z95, changeVerdict, funnelLimits, meetsMinN, plainFraction, twoProportionP, wilson } from "../stats";
import { toCsv } from "../csv";
import { FIXTURES } from "../fixtures";
import { VIEW_SCHEMAS, VIEW_IDS } from "../contract";

describe("wilson", () => {
  it("matches known values (10/100 and 0/10)", () => {
    const a = wilson(10, 100)!;
    expect(a.lo).toBeCloseTo(0.0552, 3);
    expect(a.hi).toBeCloseTo(0.1744, 3);
    const b = wilson(0, 10)!;
    expect(b.lo).toBe(0);
    expect(b.hi).toBeCloseTo(0.2775, 3);
  });
  it("refuses n = 0 and k > n", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(5, 4)).toBeNull();
  });
});
describe("funnel and change", () => {
  it("funnel limits: p0 .2, n 100, z 1.96 -> .2 +- .0784", () => {
    const f = funnelLimits(0.2, 100, Z95);
    expect(f.lo).toBeCloseTo(0.1216, 3);
    expect(f.hi).toBeCloseTo(0.2784, 3);
  });
  it("overdispersion widens the limits", () => {
    expect(funnelLimits(0.2, 100, Z95, 2).hi).toBeGreaterThan(funnelLimits(0.2, 100, Z95).hi);
  });
  it("two-proportion p: 20/100 vs 40/100 is p ~ .0016", () => {
    expect(twoProportionP(20, 100, 40, 100)!).toBeCloseTo(0.0016, 3);
  });
  it("rising/falling only with p < .05 AND relative change >= 10%", () => {
    expect(changeVerdict({ k: 20, n: 100 }, { k: 40, n: 100 })).toBe("rising");
    expect(changeVerdict({ k: 40, n: 100 }, { k: 20, n: 100 })).toBe("falling");
    expect(changeVerdict({ k: 20, n: 100 }, { k: 24, n: 100 })).toBe("no clear change"); // p large
    expect(changeVerdict({ k: 2000, n: 10000 }, { k: 2100, n: 10000 })).toBe("no clear change"); // p<.05 but +5%
  });
});
describe("min-n and wording", () => {
  it("thresholds", () => {
    expect(meetsMinN("doctor", 9)).toBe(false);
    expect(meetsMinN("doctor", 10)).toBe(true);
    expect(meetsMinN("group", 14)).toBe(false);
    expect(meetsMinN("funnel", 50)).toBe(true);
  });
  it("plain fraction", () => {
    expect(plainFraction(0.31)).toBe("about 3 in 10");
  });
});
describe("csv", () => {
  it("quotes, and neutralises formula cells", () => {
    expect(toCsv(["a", "b"], [{ a: '=1+1', b: 'x,"y"' }])).toBe("a,b\r\n'=1+1,\"x,\"\"y\"\"\"\r\n");
  });
});
describe("csv negatives", () => {
  it("leaves negative numbers alone, still neutralises formulas", () => {
    expect(toCsv(["a"], [{ a: -5 }, { a: "-0.25" }, { a: "-cmd|calc" }, { a: "=1" }, { a: "+1" }, { a: "@x" }, { a: "\tx" }])).toBe("a\r\n-5\r\n-0.25\r\n'-cmd|calc\r\n'=1\r\n'+1\r\n'@x\r\n'\tx\r\n");
  });
});
describe("fixtures satisfy the provisional contract", () => {
  for (const v of VIEW_IDS) it(v, () => expect(VIEW_SCHEMAS[v].safeParse(FIXTURES[v]).success).toBe(true));
});
import { ViewParams, VIEW_TOOL } from "../contract";
describe("params and tools", () => {
  it("ViewParams is strict (no smuggled keys)", () => {
    expect(ViewParams.safeParse({ window_days: 28, site: "EHRC" }).success).toBe(true);
    expect(ViewParams.safeParse({ sql: "x" }).success).toBe(false);
    expect(ViewParams.safeParse({ window_days: 3 }).success).toBe(false);
    expect(ViewParams.safeParse({ limit: 501 }).success).toBe(false);
  });
  it("tool names are the contract's", () => {
    expect(Object.values(VIEW_TOOL).sort()).toEqual(["cdmss_v1_this_week", "cdmss_v2_scorecard", "cdmss_v3_doctor_variation", "cdmss_v4_contributors", "cdmss_v5_redflags", "cdmss_v8_worklists"]);
  });
});

describe("A3 shapes", () => {
  it("accepts a truncated-scan change and a count_only Stat with null numerator/denominator", () => {
    const v = JSON.parse(JSON.stringify(FIXTURES.this_week));
    const st = v.view.families[0].tiles[0].stat;
    st.change = { ...(st.change ?? { early: { from: "a", to: "b", value: null, n: 0 }, late: { from: "a", to: "b", value: null, n: 0 }, p_value: null, relative_change: null }), direction: "not computed (truncated)" };
    Object.assign(st, { status: "count_only", value: null, numerator: null, denominator: null, ci95: null, extra: null });
    expect(VIEW_SCHEMAS.this_week.safeParse(v).success).toBe(true);
  });
});
