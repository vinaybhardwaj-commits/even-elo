import { z } from "zod";

// Shared (server + client) contract for the six governance read tools (apps/agent/src/studio_tools.py).
// The screen route validates params against SCREEN_TOOL_PARAMS before anything reaches the agent, and
// validates what comes back against SourceTablePayload before anything reaches a screen.

export const GOVERNANCE_TOOL_NAMES = [
  "list_physicians",
  "physician_profile",
  "signal_snapshots",
  "interventions",
  "incident_summary",
  "overview_counts",
] as const;
export type GovernanceToolName = (typeof GOVERNANCE_TOOL_NAMES)[number];

export function isGovernanceTool(name: string): name is GovernanceToolName {
  return (GOVERNANCE_TOOL_NAMES as readonly string[]).includes(name);
}

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const SourceTablePayload = z.object({
  source: z.object({ tool: z.string().min(1), query_hash: z.string().regex(/^[0-9a-f]{12}$/) }),
  mode: z.enum(["live", "fixture"]),
  synthetic: z.boolean(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), Cell)),
  row_count: z.number().int().nonnegative(),
});
export type SourceTablePayload = z.infer<typeof SourceTablePayload>;

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(200);
const windowDays = z.number().int().min(1).max(365);

// Strict: unknown keys are refused, so a caller cannot smuggle SQL, a staff id or anything else.
export const SCREEN_TOOL_PARAMS = {
  list_physicians: z
    .object({
      filter: z
        .object({
          status: z.enum(["active", "inactive", "terminated"]).optional(),
          specialty_contains: z.string().max(80).optional(),
          name_contains: z.string().max(80).optional(),
          hospital_code: z.string().max(40).optional(),
        })
        .strict()
        .optional(),
      limit: limit.optional(),
    })
    .strict(),
  physician_profile: z.object({ physician_id: uuid }).strict(),
  signal_snapshots: z
    .object({ physician_id: uuid.optional(), window_days: windowDays.optional(), limit: limit.optional() })
    .strict(),
  interventions: z.object({ physician_id: uuid.optional(), limit: limit.optional() }).strict(),
  incident_summary: z.object({ window_days: windowDays.optional() }).strict(),
  overview_counts: z.object({}).strict(),
} as const satisfies Record<GovernanceToolName, z.ZodTypeAny>;

export type ScreenToolParams<T extends GovernanceToolName> = z.input<(typeof SCREEN_TOOL_PARAMS)[T]>;

export function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}
