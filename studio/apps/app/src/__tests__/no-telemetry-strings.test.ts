import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

// Third-party phone-home hosts and modules that must never ship. Assembled from
// parts so this file does not match its own scan.
const FORBIDDEN = [
  ["launch", "-telemetry"],
  ["post", "hog"],
  ["segment", ".io"],
  ["api", ".segment"],
  ["scarf", ".sh"],
  ["telemetry", ".copilotkit"],
  ["fonts", ".googleapis"],
  ["fonts", ".gstatic"],
  ["api.cloud", ".copilotkit"],
].map((parts) => parts.join(""));

const REPO_ROOT = resolve(__dirname, "../../../..");
const SELF = resolve(__dirname, "no-telemetry-strings.test.ts");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", ".venv"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|css|html|map)$/;

function walk(dir: string, out: string[] = [], skip: Set<string> = SKIP_DIRS): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(full, out, skip);
    } else if (TEXT_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    const base = join(REPO_ROOT, group);
    for (const name of readdirSync(base)) {
      const src = join(base, name, "src");
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots.flatMap((root) => walk(root)).filter((f) => resolve(f) !== SELF);
}

function offenders(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(`${file.replace(REPO_ROOT, "")}: ${needle}`);
    }
  }
  return hits;
}

describe("no third-party telemetry strings", () => {
  it("source trees under apps/*/src and packages/*/src are clean", () => {
    expect(offenders(sourceFiles())).toEqual([]);
  });

  it("built output (when present) has no phone-home strings: browser, server, standalone node_modules", () => {
    // Strict: no vendor allowlist. The CopilotKit telemetry code is removed by
    // patches/*.patch and Segment is replaced by stubs/segment-analytics-node.
    const next = join(REPO_ROOT, "apps/app/.next");
    const noSkip = new Set([".turbo"]);
    const files = [
      ...walk(join(next, "static"), [], noSkip),
      ...walk(join(next, "server"), [], noSkip),
      ...walk(join(next, "standalone"), [], noSkip),
    ].filter((f) => !f.endsWith(".map")); // maps embed vendor sources verbatim
    expect(offenders(files)).toEqual([]);
  });

  it("no browser chunk calls a Scarf client", () => {
    const files = walk(join(REPO_ROOT, "apps/app/.next/static"));
    expect(files.filter((f) => /\.logEvent\(/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("patched/stubbed telemetry packages are wired in", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(Object.keys(root.pnpm.patchedDependencies).sort()).toEqual([
      "@copilotkit/react-core@1.55.2-next.1",
      "@copilotkit/runtime@1.55.2-next.1",
      "@copilotkit/shared@1.55.2-next.1",
    ]);
    expect(root.pnpm.overrides["@segment/analytics-node"]).toMatch(/^link:.*segment-analytics-node$/);
  });

  it("next.config.ts still inlines the telemetry kill switches (defence in depth)", () => {
    const config = readFileSync(join(REPO_ROOT, "apps/app/next.config.ts"), "utf8");
    for (const key of ["COPILOTKIT_TELEMETRY_DISABLED", "DO_NOT_TRACK", "SCARF_ANALYTICS"]) {
      expect(config).toContain(key);
    }
  });
});
