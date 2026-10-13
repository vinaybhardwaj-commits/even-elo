// Root Studio rewrite (M0-S2). Only active when STUDIO_ORIGIN is set to a bare http(s) origin.
// No env (or an invalid value) = no rewrite, unchanged behaviour. Used by next.config.js.
function studioRewrites(origin) {
  if (!origin) return [];
  let u;
  try {
    u = new URL(origin);
  } catch {
    return [];
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash || u.pathname !== "/") return [];
  const base = u.origin;
  return [
    { source: "/studio", destination: `${base}/studio` },
    { source: "/studio/:path*", destination: `${base}/studio/:path*` },
  ];
}

module.exports = { studioRewrites };
