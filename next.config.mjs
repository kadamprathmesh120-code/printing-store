/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    proxyClientMaxBodySize: '200mb',
    serverActions: {
      bodySizeLimit: '200mb',
    },
  },
}

export default nextConfig
