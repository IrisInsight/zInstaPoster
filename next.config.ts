import type { NextConfig } from "next";

/**
 * The renderer's two packages load their real payload at runtime, by path,
 * from inside their own directories: playwright-core reads browsers.json out
 * of its package root, and @sparticuz/chromium inflates bin/chromium.br.
 * Neither read is a static import, so output file tracing cannot see them and
 * the serverless bundle ships without them.
 *
 * It fails only in the Lambda. A build renders fine because the build machine
 * still has the whole node_modules tree, which is exactly why seeding worked
 * while live generation died on:
 *
 *   Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
 *
 * so the two packages are named explicitly below.
 */
const RENDERER_RUNTIME_FILES = [
  "node_modules/playwright-core/**",
  "node_modules/@sparticuz/chromium/**",
];

const nextConfig: NextConfig = {
  // playwright-core and @sparticuz/chromium must not be bundled — they load
  // native/binary assets at runtime.
  serverExternalPackages: [
    "playwright-core",
    "@sparticuz/chromium",
    "@electric-sql/pglite",
    "postgres",
  ],
  /**
   * Keys are route globs run through picomatch, so `[id]` would be read as a
   * character class — `/posts/**` covers the dynamic segments without any
   * escaping. Only the routes that can actually reach the renderer are listed:
   * these two packages are ~80MB, and attaching them to every function would
   * push the whole app toward Vercel's size limit for no benefit.
   *
   *   /api/generate   live generation renders each slide
   *   /posts/**       the review and detail screens' server actions re-render
   *                   a slide after an edit, a photo swap or Retry
   *   /api/jobs/*     publish and sweep reach the renderer through the post
   *                   service
   */
  outputFileTracingIncludes: {
    "/api/generate": RENDERER_RUNTIME_FILES,
    "/posts/**": RENDERER_RUNTIME_FILES,
    "/api/jobs/*": RENDERER_RUNTIME_FILES,
  },
  experimental: {
    // Rendering a carousel takes 20–60s end to end.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
