// Builds the docs site's content from the repository's own markdown, so
// docs.skyhitz.io always says what the repo says.
//
//   node scripts/sync.mjs        (runs before `npm start` and `npm run build`)
//
// Each canonical file is copied into content/ with front matter added, a
// maintainer-only note dropped, and every relative link rewritten: links to
// another published file point to its docs page, everything else to the file
// on GitHub. Hand-written pages in extra/ are copied as they are.
//
// The same pages are also written out as plain markdown for programs that
// read better without the site around the text (AI assistants, agents,
// crawlers), into generated/, which Docusaurus serves next to static/:
//
//   /<page>.md       each page on its own, e.g. /whitepaper.md
//   /llms-full.txt   every page in one file, in the sidebar's order
//
// static/llms.txt is the index that points to them; every docs link in it is
// checked here, so it can't name a page that doesn't exist.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DOCS, "..");
const OUT = join(DOCS, "content");
/** Plain-markdown copies and llms-full.txt: a second static directory (docusaurus.config.ts). */
const GENERATED = join(DOCS, "generated");
const SITE = "https://docs.skyhitz.io";
const GITHUB = "https://github.com/skyhitz/hitz-gravity";

/** Published files: repo path → docs page. Order is irrelevant; sidebars.ts sets it. */
const PAGES = [
  { src: "README.md", out: "index.md", slug: "/", title: "Overview", description: "HITZ Protocol: oracle-free, protocol-owned liquidity on Stellar." },
  // The same text is published, designed, at skyhitz.io/whitepaper: that page is the one search engines should rank.
  { src: "WHITEPAPER.md", out: "whitepaper.md", slug: "/whitepaper", title: "Whitepaper", description: "How HITZ Protocol provides liquidity without mercenary LPs or oracles.", canonical: "https://skyhitz.io/whitepaper/" },
  { src: "contracts/sovereign-vault/INTEGRATION.md", out: "vault/integration.md", slug: "/vault/integration", title: "Integrating the vault", description: "Calls, events and arbitrage for bots, wallets and apps." },
  { src: "contracts/sovereign-vault/MIGRATION.md", out: "vault/migration.md", slug: "/vault/migration", title: "Migration from Aquarius", description: "How HITZ moved from Aquarius pools to the Sovereign Vault." },
  { src: "frontend/ARB_BOT.md", out: "vault/arbitrage-bot.md", slug: "/vault/arbitrage-bot", title: "Arbitrage bot", description: "The bot Skyhitz runs between the vault and the Stellar DEX, and how to run your own." },
  { src: "research/arb-bot-replay/README.md", out: "vault/arbitrage-bot-replay.md", slug: "/vault/arbitrage-bot-replay", title: "Arbitrage bot replay", description: "The bot replayed on five months of SDEX prices: what it does for the vault, and how its settings were chosen." },
  { src: "AUDIT.md", out: "security/audit.md", slug: "/security/audit", title: "Security review", description: "Findings and status for the token and the vault." },
  { src: "research/vault-backtest/README.md", out: "security/fee-backtest.md", slug: "/security/fee-backtest", title: "Fee backtest", description: "The vault's fee replayed on the real arbitrage history." },
  { src: "frontend/README.md", out: "app/frontend.md", slug: "/app/frontend", title: "App and gateway", description: "The web app, the email gateway, the Worker and deployment." },
  { src: "reports/README.md", out: "app/data.md", slug: "/app/data", title: "Data pipeline and reports", description: "How on-chain data reaches the Monitor tab and the monthly reports." },
  { src: "TESTNET.md", out: "history/testnet.md", slug: "/history/testnet", title: "Testnet record", description: "The V5 testnet deployment." },
  { src: "LEGAL.md", out: "legal.md", slug: "/legal", title: "Legal disclosure", description: "Protocol disclosures and acknowledged behaviors." },
];

const bySource = new Map(PAGES.map((p) => [p.src, p]));

/**
 * The deploy workflow runs on pushes that change docs/ or a published file.
 * Refuse to build while a published file is missing from its `paths`, so a new
 * page can't silently stop deploying. Reads the `paths:` list under `push:`.
 */
function assertDeployWatches(pages) {
  const workflow = join(REPO_ROOT, ".github", "workflows", "deploy-docs.yml");
  if (!existsSync(workflow)) return;
  const paths = [];
  let inPaths = false;
  for (const line of readFileSync(workflow, "utf8").split("\n")) {
    if (/^\s*paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/);
    if (item) paths.push(item[1]);
    else if (line.trim() && !line.trim().startsWith("#")) inPaths = false;
  }
  const watched = (file) => paths.some((p) => p === file || (p.endsWith("/**") && file.startsWith(p.slice(0, -2))));
  const missing = pages.map((p) => p.src).filter((src) => !watched(src));
  if (missing.length) {
    throw new Error(
      `.github/workflows/deploy-docs.yml doesn't watch ${missing.join(", ")}: add ${missing.length === 1 ? "it" : "them"} to its paths, or changes won't redeploy docs.skyhitz.io`
    );
  }
}

/** Lines removed from a source: notes addressed to repo maintainers, not readers. */
function dropMaintainerNotes(src, text) {
  if (src !== "WHITEPAPER.md") return text;
  // The "> **Note.** This markdown is the canonical text…" blockquote.
  return text.replace(/\n> \*\*Note\.\*\* This markdown is the canonical text[\s\S]*?\n(?!>)/, "\n");
}

/** Rewrite one relative link target found in `src`. */
function rewriteTarget(src, target) {
  if (/^(?:[a-z]+:|#|\/)/i.test(target)) return target; // absolute URL, in-page anchor or site path
  const [path, anchor] = target.split("#");
  const resolved = posix.normalize(posix.join(posix.dirname(src), path));
  const page = bySource.get(resolved);
  if (page) return page.slug + (anchor ? `#${anchor}` : "");
  const onDisk = join(REPO_ROOT, resolved);
  if (!existsSync(onDisk)) throw new Error(`${src}: link to missing file ${target}`);
  const kind = statSync(onDisk).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${resolved.replace(/\/$/, "")}${anchor ? `#${anchor}` : ""}`;
}

/** Rewrite inline links `](x)` and reference definitions `[x]: y`, outside code fences. */
function rewriteLinks(src, text) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      line = line.replace(/\]\(([^)\s]+)\)/g, (_m, t) => `](${rewriteTarget(src, t)})`);
      return line.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_m, head, t) => head + rewriteTarget(src, t));
    })
    .join("\n");
}

function frontMatter(p) {
  const q = (s) => JSON.stringify(s);
  return [
    "---",
    `title: ${q(p.title)}`,
    `sidebar_label: ${q(p.title)}`,
    `slug: ${q(p.slug)}`,
    `description: ${q(p.description)}`,
    `custom_edit_url: ${q(`${GITHUB}/blob/main/${p.src}`)}`,
    // Read by src/theme/DocItem/Metadata: the page's canonical URL, when it isn't this site's own.
    ...(p.canonical ? [`canonical_url: ${q(p.canonical)}`] : []),
    "---",
    "",
  ].join("\n");
}

assertDeployWatches(PAGES);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const p of PAGES) {
  const raw = readFileSync(join(REPO_ROOT, p.src), "utf8");
  const body = rewriteLinks(p.src, dropMaintainerNotes(p.src, raw));
  const dest = join(OUT, p.out);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, frontMatter(p) + body);
}

cpSync(join(DOCS, "extra"), OUT, { recursive: true });
console.log(`[sync] ${PAGES.length} pages from the repo, plus extra/ → content/`);

// ─── Plain markdown for machines ─────────────────────────────────────────────

/** The sidebar's order, read from sidebars.ts: the order of llms-full.txt. Pages it doesn't list go last. */
function sidebarOrder() {
  const text = readFileSync(join(DOCS, "sidebars.ts"), "utf8");
  return [...text.matchAll(/'([a-z0-9-]+(?:\/[a-z0-9-]+)*)'/g)].map((m) => m[1]).filter((id) => id !== "category" && id !== "docs");
}

/** Split a content file into its front matter fields and its body. */
function parseContent(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fields = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
    }
  }
  return { fields, body: m ? text.slice(m[0].length) : text };
}

/** A page path as the site serves it, with the trailing slash (docusaurus.config.ts trailingSlash): "/a#b" → "/a/#b". */
function withSlash(path) {
  const [page, anchor] = path.split("#");
  const slashed = page.endsWith("/") || /\.[a-z0-9]+$/i.test(page) ? page : `${page}/`;
  return slashed + (anchor ? `#${anchor}` : "");
}

/** Site paths become full URLs: a markdown file read on its own has no site to be relative to. */
function absoluteLinks(text) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\]\((\/[^)\s]*)\)/g, (_m, path) => `](${SITE}${withSlash(path)})`);
    })
    .join("\n");
}

function contentFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? contentFiles(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []
  );
}

rmSync(GENERATED, { recursive: true, force: true });
mkdirSync(GENERATED, { recursive: true });

const machinePages = contentFiles(OUT).map((file) => {
  const id = relative(OUT, file).replace(/\\/g, "/").replace(/\.md$/, "");
  const { fields, body } = parseContent(readFileSync(file, "utf8"));
  const slug = fields.slug ?? `/${id}`;
  const url = `${SITE}${withSlash(slug)}`;
  const markdown = [
    `<!-- ${fields.title ?? id}. Page: ${url}${fields.custom_edit_url ? ` · Source: ${fields.custom_edit_url}` : ""} -->`,
    "",
    absoluteLinks(body).trim(),
    "",
  ].join("\n");
  const dest = join(GENERATED, `${id}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, markdown);
  return { id, title: fields.title ?? id, description: fields.description ?? "", url, markdown };
});

const order = sidebarOrder();
const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
machinePages.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));

writeFileSync(
  join(GENERATED, "llms-full.txt"),
  [
    "# HITZ Protocol: the complete documentation",
    "",
    "> Every page of docs.skyhitz.io in one file, for language models and agents. HITZ Protocol is an oracle-free financial primitive on Stellar mainnet (Soroban), built by Skyhitz: the Sovereign Vault, HITZ's own exchange, owns its liquidity and prices it by arbitrage with no oracle, and the HITZ token bounds how much one account can hold and still move freely. Index: https://docs.skyhitz.io/llms.txt. To trade from code or an agent: https://skyhitz.io/integrate/.",
    "",
    "## Pages",
    "",
    ...machinePages.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`),
    "",
    ...machinePages.flatMap((p) => ["---", "", p.markdown]),
  ].join("\n")
);

// static/llms.txt is written by hand. Every docs link in it must be a page, a page's markdown or a generated file.
const known = new Set([
  `${SITE}/`,
  `${SITE}/llms-full.txt`,
  ...machinePages.flatMap((p) => [p.url, `${SITE}/${p.id}.md`]),
]);
const llmsTxt = readFileSync(join(DOCS, "static", "llms.txt"), "utf8");
const unknown = [...llmsTxt.matchAll(/https:\/\/docs\.skyhitz\.io[^\s)]*/g)].map((m) => m[0].replace(/[.,;:]+$/, "")).filter((u) => !known.has(u));
if (unknown.length) {
  throw new Error(`static/llms.txt links to ${[...new Set(unknown)].join(", ")}, which this site doesn't publish`);
}

console.log(`[sync] ${machinePages.length} pages as markdown and llms-full.txt → generated/`);
