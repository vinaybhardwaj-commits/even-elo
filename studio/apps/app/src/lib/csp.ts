// Host-page Content-Security-Policy. No third-party hosts anywhere.
//
// script-src keeps 'unsafe-inline' (Next bootstrap) and 'unsafe-eval' because the
// widget iframes are srcdoc documents, which INHERIT this policy and then add
// their own stricter meta CSP (default-src 'none', connect-src 'none', ...);
// the websandbox bridge needs eval inside them. The intersection of both applies.
export function agentOrigin(raw?: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw.startsWith("http") ? raw : `http://${raw}`).origin;
  } catch {
    return null;
  }
}

export function buildHostCsp(agentUrl?: string): string {
  const agent = agentOrigin(agentUrl);
  const connect = ["'self'", ...(agent ? [agent] : [])].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "frame-src 'self' about: blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
