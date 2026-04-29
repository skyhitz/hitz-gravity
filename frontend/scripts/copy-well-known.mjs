// Copy public/.well-known/ into the static export.
//
// Why this script exists:
//   Next.js (App Router, output: "export") copies files from `public/`
//   to `out/` — EXCEPT directories whose name starts with a dot. That
//   excludes `.well-known/`, the IETF-mandated path (RFC 8615) for
//   files like `stellar.toml`. Without this copy, requests to
//   /.well-known/stellar.toml fall through Cloudflare's static-assets
//   binding into the SPA's 404 page (you'll see HTML, not TOML).
//
// What it does:
//   Recursively copies every file under `public/.well-known/` to
//   `out/.well-known/`, preserving structure. Idempotent — safe to
//   re-run; existing files are overwritten.
//
// Run automatically as part of `pnpm build` (chained after `next build`).

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "public", ".well-known");
const dst = join(root, "out", ".well-known");

if (!existsSync(src)) {
  console.warn(`[copy-well-known] no public/.well-known/ — skipping`);
  process.exit(0);
}

cpSync(src, dst, { recursive: true });
console.log(`[copy-well-known] copied ${src} → ${dst}`);
