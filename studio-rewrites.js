// Root Studio rewrite (M0-S2). Only active when STUDIO_ORIGIN is set to a bare http(s) origin.
// No env (or an invalid value) = no rewrite, unchanged behaviour. Used by next.config.js.
function studioBase(origin) {
  if (!origin) return null;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;
  return u.origin;
}

function studioRewrites(origin) {
  const base = studioBase(origin);
  if (!base) return [];
  return [
    { source: "/studio", destination: `${base}/studio` },
    { source: "/studio/:path*", destination: `${base}/studio/:path*` },
  ];
}

// Root pages that moved into the Studio (M1 ruling E). These are NOT next.config redirects: src/middleware.ts calls
// studioRedirectPath() after the staff JWT is verified and redirects (307) only a user who satisfies the TARGET screen's
// predicate (studio-access.js), and only when STUDIO_ORIGIN is valid and the host is not doctors.*. Everyone else keeps
// the old page. Unsetting the env rolls everything back.
const STUDIO_REDIRECTS = [
  ["/overview", "/studio/overview"],
  ["/physicians", "/studio/physicians"],
  ["/physicians/:id", "/studio/physicians/:id"],
  ["/audit-findings", "/studio/audit-findings"],
  ["/audit-findings/:reference", "/studio/audit-findings/:reference"],
  ["/document-audits", "/studio/document-audits"],
  ["/document-audits/:id", "/studio/document-audits/:id"],
  ["/rmo-inbox", "/studio/rmo-inbox"],
  ["/incidents", "/studio/incidents"],
  ["/safety", "/studio/incidents"],
  ["/mm", "/studio/surgical"],
  ["/surgical-governance", "/studio/surgical"],
  ["/surgical-governance/vc/:id", "/studio/surgical/vcs/:id"],
  ["/onboarding", "/studio/onboarding"],
  ["/onboarding/:id", "/studio/onboarding/:id"],
  ["/admin/users", "/studio/admin/users"],
  ["/admin/resignations", "/studio/admin/resignations"],
];
// A single :param segment matches any value except these literal sibling pages that have no Studio equivalent.
const STUDIO_REDIRECT_EXCLUDED = ["/audit-findings/mapping"];

// Returns the Studio path for an old pathname, or null (no env, doctors host, excluded or unmapped page).
// Only whole-path matches count; /incidents/new, /mm/cases/x, /api/* etc. never match. Query is the caller's to keep.
function studioRedirectPath(origin, pathname, host) {
  if (!studioBase(origin)) return null;
  if (/^doctors\./i.test(host || "")) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (STUDIO_REDIRECT_EXCLUDED.includes(path)) return null;
  const segs = path.split("/");
  for (const [source, destination] of STUDIO_REDIRECTS) {
    const pat = source.split("/");
    if (pat.length !== segs.length) continue;
    const params = {};
    const ok = pat.every((p, i) => {
      if (!p.startsWith(":")) return p === segs[i];
      if (!segs[i]) return false;
      params[p.slice(1)] = segs[i];
      return true;
    });
    if (ok) return destination.replace(/:(\w+)/g, (_, k) => params[k]);
  }
  return null;
}

module.exports = { studioRewrites, studioRedirectPath, STUDIO_REDIRECTS, STUDIO_REDIRECT_EXCLUDED };
