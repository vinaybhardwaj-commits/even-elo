// Third-party reporting is off by default and cannot be re-enabled by the host
// environment: CopilotKit, Scarf and generic DO_NOT_TRACK are forced here.
export const NO_TELEMETRY_ENV = {
  COPILOTKIT_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  SCARF_ANALYTICS: "false",
} as const;

export function disableTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  Object.assign(env, NO_TELEMETRY_ENV);
}
