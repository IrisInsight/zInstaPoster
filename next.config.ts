import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // playwright-core and @sparticuz/chromium must not be bundled — they load
  // native/binary assets at runtime.
  serverExternalPackages: [
    "playwright-core",
    "@sparticuz/chromium",
    "@electric-sql/pglite",
    "postgres",
  ],
  experimental: {
    // Rendering a carousel takes 20–60s end to end.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
