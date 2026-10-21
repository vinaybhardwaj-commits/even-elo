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
  return [
    { source: "/overview", destination: "/studio/overview", permanent: false, missing: notDoctorsHost },
    { source: "/physicians", destination: "/studio/physicians", permanent: false, missing: notDoctorsHost },
    { source: "/physicians/:id", destination: "/studio/physicians/:id", permanent: false, missing: notDoctorsHost },
  ];
}

module.exports = { studioRewrites, studioRedirects };
