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

// Root pages that moved into the Studio (M1 ruling E). 307 (not permanent) and only when STUDIO_ORIGIN is valid,
// so unsetting the env, or removing this list from next.config.js, rolls the redirects back. Redirects run before
// middleware, so the doctors host (doctors.*) is excluded here and keeps its own lock.
function studioRedirects(origin) {
  if (!studioBase(origin)) return [];
  const notDoctorsHost = [{ type: "host", value: "doctors\\..*" }];
  const map = [
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
  // Only exact pages listed above move. Sub-pages without a Studio equivalent (e.g. /incidents/new, /mm/cases/:id,
  // /surgical-governance/input|admin|capture-queue|ot-sheets, /admin, /admin/pending, /admin/metrics, /admin/users/:id,
  // /audit-findings/mapping), /api/* and /portal stay on the old app. Query strings are preserved by Next.
  return map.map(([source, destination]) => ({ source, destination, permanent: false, missing: notDoctorsHost }));
}

module.exports = { studioRewrites, studioRedirects };
