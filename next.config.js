/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      { source: '/surgical-elo', destination: '/surgical-governance', permanent: true },
      { source: '/surgical-elo/:path*', destination: '/surgical-governance/:path*', permanent: true },
    ]
  },
}
module.exports = nextConfig
