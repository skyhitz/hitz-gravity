import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deploying to Cloudflare Pages as a pure static site. Every route in this
  // app renders as `○ (Static)` during `next build`, so a static export is
  // the simplest and cheapest target — no edge runtime, no adapter, no
  // function invocations. If we ever add an SSR/ISR route we'll need to
  // swap this for `@opennextjs/cloudflare` or similar.
  output: "export",
  // Match the trailing-slash convention Cloudflare Pages uses by default so
  // direct links like `/whitepaper` resolve without a 308.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
