const { studioRewrites } = require('./studio-rewrites')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // google-auth-library reads Node builtins. Leave the Vertex SDK external
    // so the server health route can load it on Vercel.
    serverComponentsExternalPackages: ["@google/genai", "google-auth-library"],
  },
  // Governance Studio lives in studio/ (its own app). Proxied only when STUDIO_ORIGIN is set.
  async rewrites() {
    return studioRewrites(process.env.STUDIO_ORIGIN)
  },
  async redirects() {
    return [
      { source: '/surgical-elo', destination: '/surgical-governance', permanent: true },
      { source: '/surgical-elo/:path*', destination: '/surgical-governance/:path*', permanent: true },
    ]
  },
}
module.exports = nextConfig
