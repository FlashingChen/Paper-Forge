import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";


const devProxy = process.env.PAPERFORGE_DEV_PROXY?.trim();

const nextConfig: NextConfig = {
  output: "standalone",

  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    ignoreDuringBuilds: false,
  },

  async rewrites() {
    if (!devProxy) return [];
    return [
      { source: "/api/jobs/:id", destination: `${devProxy}/api/jobs/:id` },
      { source: "/api/jobs/:id/events", destination: `${devProxy}/api/jobs/:id/events` },
      { source: "/api/jobs/:id/download", destination: `${devProxy}/api/jobs/:id/download` },
      { source: "/api/jobs/:id/preview", destination: `${devProxy}/api/jobs/:id/preview` },
    ];
  },


  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
        ],
      },
      {
        source: "/login",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
        ],
      },
      {
        source: "/app",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
        ],
      },
    ];
  },
};

export default function config(phase: string): NextConfig {
  return {
    ...nextConfig,
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  };
}
