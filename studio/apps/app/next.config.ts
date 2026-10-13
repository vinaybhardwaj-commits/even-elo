import type { NextConfig } from "next";
import { buildHostCsp } from "./src/lib/csp";

// Inlined into browser and server bundles at build time (defence in depth: the
// CopilotKit telemetry clients are also patched to no-ops, see patches/).
const NO_TELEMETRY_ENV = {
  COPILOTKIT_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  SCARF_ANALYTICS: "false",
};

const nextConfig: NextConfig = {
  // The Studio lives at /studio behind even-elo's rewrite. Every route and asset is under it.
  basePath: "/studio",
  output: "standalone",
  serverExternalPackages: ["@copilotkit/runtime"],
  env: NO_TELEMETRY_ENV,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: buildHostCsp() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
