// Architecture gates (M0-A). Plain Node, no deps. Run: npm run architecture:check
//
// Rules (each failure prints file:line):
//   portal-wall      portal code must not import staff-only modules
//   upstream-db      no upstream DB env names / non-DATABASE_URL Postgres URLs
//   one-db-client    neon( only in src/lib/db.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Rule a: portal wall -------------------------------------------------
export const PORTAL_GLOBS = ["src/app/portal/", "src/app/api/portal/"];
// Staff session / staff role modules. Matched by resolved path (exact file or directory prefix).
export const STAFF_ONLY = [
  "src/lib/auth.ts",
  "src/lib/staff-guard.ts",
  "src/lib/staff-live.ts",
  "src/lib/ops-auth.ts",
  "src/lib/roles.ts", // staff role labels
  "src/lib/cron-auth.ts", // staff/ops cron credentials
  "src/lib/mcp-oauth.ts", // staff MCP session tokens
  "src/lib/hospital-filter.ts", // staff hospital scoping from staff session
  "src/components/admin/",
  "src/app/admin/",
];
// Portal -> staff-only imports that exist today: { "portal/file.ts": ["src/lib/x.ts"] }. Behaviour is not changed; this is debt.
export const PORTAL_KNOWN_EXCEPTIONS = {
  // (none found at 685d5df: portal code imports physician-auth, portal-flags, db and shared libs only)
};

// ---- Rule b: no direct upstream DB --------------------------------------
export const UPSTREAM_ENV_RE = /NEWCAT.*(DATABASE|DB|PG)|CDMSS.*(DATABASE|DB|PG)|METABASE/;
// Any env var that smells like a Postgres URL other than DATABASE_URL.
export const OTHER_PG_ENV_RE = /process\.env\.(POSTGRES\w*|PG\w*|\w*_DATABASE_URL|\w*POSTGRES\w*)/;
export const PG_URL_LITERAL_RE = /postgres(?:ql)?:\/\//;
export const UPSTREAM_KNOWN_EXCEPTIONS = {
  "src/app/api/service/observations/route.ts": "falls back to process.env.POSTGRES_URL when DATABASE_URL is unset (debt)",
};

// ---- Rule c: one DB client ----------------------------------------------
export const DB_CLIENT_FILE = "src/lib/db.ts";
// Files that call neon( directly today (debt). Any file not listed here fails.
export const NEON_KNOWN_EXCEPTIONS = [
  "src/app/admin/page.tsx",
  "src/app/api/admin/bulk-import-physicians/route.ts",
  "src/app/api/admin/census/members/route.ts",
  "src/app/api/admin/census/route.ts",
  "src/app/api/admin/clinical-metrics/upload/route.ts",
  "src/app/api/admin/db-fresh/route.ts",
  "src/app/api/admin/db-snapshot/route.ts",
  "src/app/api/admin/dedupe-physicians/route.ts",
  "src/app/api/admin/email-test/route.ts",
  "src/app/api/admin/expiry-alerts/route.ts",
  "src/app/api/admin/migrate/route.ts",
  "src/app/api/admin/oppe-kickstart/route.ts",
  "src/app/api/admin/oppe-scheduler/route.ts",
  "src/app/api/admin/portal-welcome/route.ts",
  "src/app/api/admin/profiles/[id]/reset-pin/route.ts",
  "src/app/api/admin/profiles/[id]/roles/route.ts",
  "src/app/api/admin/profiles/[id]/route.ts",
  "src/app/api/admin/profiles/route.ts",
  "src/app/api/admin/qualifications/pending/route.ts",
  "src/app/api/admin/resignations/[id]/process/route.ts",
  "src/app/api/admin/resignations/route.ts",
  "src/app/api/admin/seed-epi-base/route.ts",
  "src/app/api/admin/seed-profile/route.ts",
  "src/app/api/admin/users/route.ts",
  "src/app/api/admin/vertex/health/route.ts",
  "src/app/api/admin/wipe-smoke-residue/route.ts",
  "src/app/api/auth/change-pin/route.ts",
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/signup/route.ts",
  "src/app/api/hospitals-public/route.ts",
  "src/app/api/hospitals/route.ts",
  "src/app/api/incidents/[id]/replies/route.ts",
  "src/app/api/incidents/[id]/route.ts",
  "src/app/api/incidents/[id]/view/route.ts",
  "src/app/api/incidents/home/route.ts",
  "src/app/api/incidents/physician/[id]/route.ts",
  "src/app/api/incidents/physician/[id]/summary/route.ts",
  "src/app/api/incidents/route.ts",
  "src/app/api/mcp/route.ts",
  "src/app/api/oppe/[id]/decision/route.ts",
  "src/app/api/oppe/[id]/route.ts",
  "src/app/api/physicians/[id]/audit/route.ts",
  "src/app/api/physicians/[id]/carry-candidates/route.ts",
  "src/app/api/physicians/[id]/clinical-metrics/route.ts",
  "src/app/api/physicians/[id]/engagements/[eid]/route.ts",
  "src/app/api/physicians/[id]/engagements/route.ts",
  "src/app/api/physicians/[id]/fppe/route.ts",
  "src/app/api/physicians/[id]/oppe/route.ts",
  "src/app/api/physicians/[id]/portal-access/route.ts",
  "src/app/api/physicians/[id]/privilege-requests/route.ts",
  "src/app/api/physicians/[id]/privileges/[prid]/route.ts",
  "src/app/api/physicians/[id]/privileges/route.ts",
  "src/app/api/physicians/[id]/qualifications/[qid]/file/route.ts",
  "src/app/api/physicians/[id]/qualifications/[qid]/route.ts",
  "src/app/api/physicians/[id]/qualifications/route.ts",
  "src/app/api/physicians/[id]/route.ts",
  "src/app/api/physicians/route.ts",
  "src/app/api/portal/about-me/route.ts",
  "src/app/api/portal/auth/login/route.ts",
  "src/app/api/portal/auth/request-pin/route.ts",
  "src/app/api/portal/auth/set-pin/route.ts",
  "src/app/api/portal/feedback/route.ts",
  "src/app/api/portal/incidents/[id]/reply/route.ts",
  "src/app/api/portal/me/route.ts",
  "src/app/api/portal/performance/route.ts",
  "src/app/api/portal/physicians/route.ts",
  "src/app/api/portal/privileges/route.ts",
  "src/app/api/portal/qualifications/[qid]/route.ts",
  "src/app/api/portal/qualifications/route.ts",
  "src/app/api/portal/resignation/route.ts",
  "src/app/api/privilege-requests/[id]/decision/route.ts",
  "src/app/api/public/incidents/route.ts",
  "src/app/api/public/physicians/route.ts",
  "src/app/api/service/observations/route.ts",
  "src/app/api/vc-onboarding/prescreens/[id]/decision/route.ts",
  "src/app/api/vc-onboarding/prescreens/[id]/observations/route.ts",
  "src/app/api/vc-onboarding/prescreens/[id]/route.ts",
  "src/app/api/vc-onboarding/prescreens/route.ts",
  "src/app/home/page.tsx",
  "src/lib/hospital-filter.ts",
];

const norm = (p) => p.split(path.sep).join("/");
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function resolveImport(fromFile, spec) {
  if (spec.startsWith("@/")) return "src/" + spec.slice(2);
  if (spec.startsWith(".")) return norm(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
  return null;
}
function isStaffOnly(resolved) {
  return STAFF_ONLY.some((s) => (s.endsWith("/") ? resolved.startsWith(s) || resolved + "/" === s : resolved === s || resolved === s.replace(/\.ts$/, "")));
}

/** files: [{ path: "src/...", text }]. Returns [{ rule, file, line, message }]. */
export function checkFiles(files, opts = {}) {
  const portalEx = opts.portalExceptions ?? PORTAL_KNOWN_EXCEPTIONS;
  const upEx = opts.upstreamExceptions ?? UPSTREAM_KNOWN_EXCEPTIONS;
  const neonEx = opts.neonExceptions ?? NEON_KNOWN_EXCEPTIONS;
  const out = [];
  for (const { path: file, text } of files) {
    const lines = text.split("\n");
    const inPortal = PORTAL_GLOBS.some((g) => file.startsWith(g));
    lines.forEach((line, i) => {
      const n = i + 1;
      if (inPortal) {
        const m = line.match(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']([^"']+)["']/);
        if (m) {
          const r = resolveImport(file, m[1]);
          if (r && isStaffOnly(r) && !(portalEx[file] ?? []).some((e) => e.replace(/\.tsx?$/, "") === r.replace(/\.tsx?$/, ""))) {
            out.push({ rule: "portal-wall", file, line: n, message: `portal code imports staff-only module "${m[1]}"` });
          }
        }
      }
      if (isComment(line)) return;
      if (file.startsWith("src/") && !upEx[file]) {
        if (UPSTREAM_ENV_RE.test(line)) out.push({ rule: "upstream-db", file, line: n, message: "references an upstream DB env name (NEWCAT/CDMSS/METABASE)" });
        else if (OTHER_PG_ENV_RE.test(line)) out.push({ rule: "upstream-db", file, line: n, message: "uses a Postgres URL env other than process.env.DATABASE_URL" });
        if (PG_URL_LITERAL_RE.test(line)) out.push({ rule: "upstream-db", file, line: n, message: "hard-coded Postgres URL literal" });
      }
      if (file !== DB_CLIENT_FILE && /\bneon\s*\(/.test(line) && !neonEx.includes(file)) {
        out.push({ rule: "one-db-client", file, line: n, message: "neon( called outside src/lib/db.ts (use `sql` from @/lib/db); new call sites are not allowed" });
      }
    });
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "__tests__") walk(p, acc); }
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

export function main(root = process.cwd()) {
  const files = walk(path.join(root, "src")).map((p) => ({ path: norm(path.relative(root, p)), text: fs.readFileSync(p, "utf8") }));
  const problems = checkFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(`architecture:check FAIL [${p.rule}] ${p.file}:${p.line} ${p.message}`);
    console.error(`architecture:check: ${problems.length} violation(s)`);
    return 1;
  }
  console.log(`architecture:check OK (${files.length} files; neon exceptions ${NEON_KNOWN_EXCEPTIONS.length}; portal exceptions ${Object.keys(PORTAL_KNOWN_EXCEPTIONS).length})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main());
