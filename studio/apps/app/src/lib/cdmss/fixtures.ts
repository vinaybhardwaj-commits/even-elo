import type { ViewId, ViewPayload } from "./contract";
import v1 from "../../../../agent/tests/fixtures/cdmss/cdmss_v1_this_week.json";
import v2 from "../../../../agent/tests/fixtures/cdmss/cdmss_v2_scorecard.json";
import v3 from "../../../../agent/tests/fixtures/cdmss/cdmss_v3_doctor_variation.json";
import v4 from "../../../../agent/tests/fixtures/cdmss/cdmss_v4_contributors.json";
import v5 from "../../../../agent/tests/fixtures/cdmss/cdmss_v5_redflags.json";
import v8 from "../../../../agent/tests/fixtures/cdmss/cdmss_v8_worklists.json";

// Builder A's real fixtures: payloads produced by the agent's SQL over a seeded scratch database (a test on A's side
// fails on shape drift). TEST-ONLY: nothing in the app bundle imports this file.
export const FIXTURES = { this_week: v1, scorecard: v2, doctor_variation: v3, contributors: v4, redflags: v5, worklists: v8 } as unknown as { [V in ViewId]: ViewPayload<V> };
export const RAW_V3 = v3;
export const RAW_V4 = v4;
