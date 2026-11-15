// Draws public/og.png, the 1200 × 630 image that link previews show when
// skyhitz.io is shared (Open Graph and Twitter card; lib/site.ts OG_IMAGE).
//
//   node scripts/og-image.mjs
//
// The image is committed; run this only to change it. It renders the HTML
// below in Chromium and saves a screenshot, so it needs Playwright, which is
// not one of the project's dependencies:
//
//   npm install --no-save playwright && npx playwright install chromium
//
// Type is Geist, the site's own, loaded from Google Fonts for the render.
//
// House style: no em-dashes. Use commas or periods.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "og.png");
const icon = readFileSync(join(root, "public", "icon.png")).toString("base64");

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("Playwright isn't installed. See the comment at the top of this script.");
  process.exit(1);
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: #0a0a0a; color: #f5f5f7;
    font-family: "Geist", ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    position: relative; overflow: hidden;
  }
  /* The vault: rings around a mass, off the right edge. */
  .rings { position: absolute; right: -210px; top: 50%; width: 760px; height: 760px; transform: translateY(-50%); }
  .rings i { position: absolute; inset: 0; margin: auto; border-radius: 50%; border: 1px solid #2a2a2c; }
  .rings i:nth-child(1) { width: 760px; height: 760px; border-style: dashed; border-color: #232325; }
  .rings i:nth-child(2) { width: 560px; height: 560px; border-color: rgba(10,132,255,0.35); }
  .rings i:nth-child(3) { width: 360px; height: 360px; border-style: dashed; }
  .rings i:nth-child(4) { width: 170px; height: 170px; border: 0; background: radial-gradient(circle at 32% 30%, #2a2a2c, #000 72%); box-shadow: 0 0 120px 30px rgba(10,132,255,0.16); }
  .rings b { position: absolute; width: 14px; height: 14px; border-radius: 50%; }
  .rings b:nth-of-type(1) { background: #0a84ff; left: 121px; top: 232px; box-shadow: 0 0 18px #0a84ff; }
  .rings b:nth-of-type(2) { background: #30d158; left: 236px; top: 520px; width: 10px; height: 10px; }
  .rings b:nth-of-type(3) { background: #bf5af2; left: 392px; top: 96px; width: 10px; height: 10px; }
  .glow { position: absolute; inset: 0; background: radial-gradient(900px 500px at 12% 0%, rgba(10,132,255,0.10), transparent 60%); }
  .wrap { position: absolute; inset: 0; padding: 64px 72px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand img { width: 60px; height: 60px; border-radius: 14px; }
  .brand span { font-size: 22px; font-weight: 600; letter-spacing: 0.22em; color: #f5f5f7; }
  h1 { margin-top: auto; font-size: 92px; font-weight: 700; letter-spacing: -0.035em; line-height: 1; }
  p.tag { margin-top: 22px; font-size: 38px; font-weight: 400; letter-spacing: -0.015em; line-height: 1.22; color: #c7c7cc; white-space: nowrap; }
  .chips { margin-top: 38px; display: flex; gap: 12px; }
  .chips span {
    font-family: "Geist Mono", ui-monospace, Menlo, monospace; font-size: 19px; color: #f5f5f7;
    border: 1px solid #2a2a2c; background: #141416; border-radius: 999px; padding: 10px 20px;
  }
  .chips span em { font-style: normal; color: #0a84ff; }
  .url { position: absolute; right: 72px; top: 80px; font-family: "Geist Mono", ui-monospace, Menlo, monospace; font-size: 22px; color: #8e8e93; }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="rings"><i></i><i></i><i></i><i></i><b></b><b></b><b></b></div>
  <div class="wrap">
    <div class="brand"><img src="data:image/png;base64,${icon}" alt=""><span>SKYHITZ</span></div>
    <h1>HITZ Protocol</h1>
    <p class="tag">Oracle-free, protocol-owned<br>liquidity on Stellar</p>
    <div class="chips">
      <span><em>No</em> oracle</span>
      <span><em>No</em> LP shares</span>
      <span><em>No</em> withdrawals</span>
    </div>
  </div>
  <div class="url">skyhitz.io</div>
</body>
</html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  if (!fonts.some((f) => /Geist/.test(f))) console.warn("Geist didn't load: the image uses a fallback font.");
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
