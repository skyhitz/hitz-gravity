// The static files a browser, a crawler or an agent reads before anything
// else: the response headers (public/_headers), robots.txt, security.txt and
// llms.txt. These are plain text that nothing compiles, so a typo or a value
// left behind when the code moves is caught here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAQS } from "../app/lib/faq.ts";
import { HITZ_CONTRACT, HOME_DESCRIPTION, HOME_TITLE, INDEXED_PAGES, VAULT_CONTRACT, pageUrl } from "../app/lib/site.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** public/_headers as { pattern: { header: value } }, comments dropped. */
function headerRules() {
  const rules = {};
  let current = null;
  for (const line of read("public/_headers").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      current = rules[line.trim()] = {};
    } else {
      const at = line.indexOf(":");
      assert.ok(current && at > 0, `header line outside a rule: ${line}`);
      current[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return rules;
}

/** A Content-Security-Policy value as { directive: [sources] }. */
function directives(policy) {
  return Object.fromEntries(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name, sources])
  );
}

// ─── Response headers ────────────────────────────────────────────────────────

test("_headers stays inside Cloudflare's limits", () => {
  const lines = read("public/_headers").split("\n");
  assert.ok(Object.keys(headerRules()).length <= 100, "at most 100 rules");
  for (const line of lines) assert.ok(line.length <= 2000, `line over 2,000 characters: ${line.slice(0, 60)}`);
});

test("every page forbids framing, sniffing and plain HTTP", () => {
  const all = headerRules()["/*"];
  assert.equal(all["X-Frame-Options"], "DENY");
  assert.equal(all["X-Content-Type-Options"], "nosniff");
  assert.match(all["Strict-Transport-Security"], /^max-age=\d{8,}/);
  assert.equal(all["Referrer-Policy"], "strict-origin-when-cross-origin");
  // Wallets that sign in a popup answer through window.opener: a stricter value would cut them off.
  assert.equal(all["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
});

test("the content security policy allows what the app uses and nothing looser", () => {
  const csp = directives(headerRules()["/*"]["Content-Security-Policy"]);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  for (const [name, sources] of Object.entries(csp)) {
    assert.ok(!sources.includes("'unsafe-eval'"), `${name} allows eval`);
    assert.ok(!sources.includes("*"), `${name} allows any origin`);
    assert.ok(!sources.some((s) => s === "http:" || s.startsWith("http://")), `${name} allows plain HTTP`);
  }
  // Scripts come from this site and from Cloudflare's analytics beacon, nowhere else.
  assert.deepEqual(csp["script-src"].filter((s) => s.startsWith("https:")), ["https://static.cloudflareinsights.com"]);
});

test("the policy lets the page reach the RPC endpoint the code reads from", () => {
  const csp = directives(headerRules()["/*"]["Content-Security-Policy"]);
  const rpc = /const RPC_URL = "(https:\/\/[^"]+)"/.exec(read("app/lib/stellar.ts"));
  assert.ok(rpc, "RPC_URL not found in app/lib/stellar.ts");
  assert.ok(
    csp["connect-src"].includes(new URL(rpc[1]).origin),
    `connect-src must name ${new URL(rpc[1]).origin}: the app would be cut off from the chain`
  );
  assert.ok(csp["connect-src"].includes("'self'"));
});

test("fingerprinted build output is cached for a year, pages are not", () => {
  const rules = headerRules();
  assert.equal(rules["/_next/static/*"]["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(rules["/*"]["Cache-Control"], undefined, "a Cache-Control on /* would also apply to pages and merge into every other rule");
});

// ─── robots.txt ──────────────────────────────────────────────────────────────

/** robots.txt as groups of { agents, rules }, plus the sitemap lines. */
function robots() {
  const groups = [];
  const sitemaps = [];
  let group = null;
  let inRules = false;
  for (const raw of read("public/robots.txt").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const at = line.indexOf(":");
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "sitemap") sitemaps.push(value);
    else if (field === "user-agent") {
      if (!group || inRules) groups.push((group = { agents: [], rules: [] }));
      inRules = false;
      group.agents.push(value);
    } else {
      assert.ok(["allow", "disallow"].includes(field), `robots.txt: a validator would reject "${field}"`);
      assert.ok(group, "rule before any User-agent");
      inRules = true;
      group.rules.push([field, value]);
    }
  }
  return { groups, sitemaps };
}

test("robots.txt welcomes everyone, AI crawlers by name, and names the sitemap", () => {
  const { groups, sitemaps } = robots();
  assert.deepEqual(sitemaps, ["https://skyhitz.io/sitemap.xml"]);
  const everyone = groups.find((g) => g.agents.includes("*"));
  assert.ok(everyone.rules.some(([f, v]) => f === "allow" && v === "/"));
  const named = groups.find((g) => g.agents.includes("GPTBot"));
  for (const agent of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "CCBot"]) {
    assert.ok(named.agents.includes(agent), `${agent} isn't named`);
  }
  // A named group replaces the general one for that crawler, so it must carry the same rules.
  assert.deepEqual(named.rules, everyone.rules);
});

test("robots.txt closes only the account endpoints", () => {
  for (const group of robots().groups) {
    const closed = group.rules.filter(([f]) => f === "disallow").map(([, v]) => v);
    assert.deepEqual(closed, ["/api/auth/", "/api/gateway/", "/api/admin/"]);
  }
});

// ─── security.txt and llms.txt ───────────────────────────────────────────────

test("security.txt has what RFC 9116 requires", () => {
  const text = read("public/.well-known/security.txt");
  assert.match(text, /^Contact: mailto:\S+@skyhitz\.io$/m);
  assert.match(text, /^Expires: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
  assert.match(text, /^Canonical: https:\/\/skyhitz\.io\/\.well-known\/security\.txt$/m);
});

test("llms.txt names both contracts and the ways to trade", () => {
  const text = read("public/llms.txt");
  assert.ok(text.includes(HITZ_CONTRACT));
  assert.ok(text.includes(VAULT_CONTRACT));
  for (const url of ["https://skyhitz.io/mcp", "https://skyhitz.io/api/v1", "https://skyhitz.io/api/v1/openapi.json", "https://docs.skyhitz.io/llms-full.txt"]) {
    assert.ok(text.includes(url), `${url} isn't linked`);
  }
});

// ─── What the pages say about themselves ─────────────────────────────────────

test("the contract ids in the metadata are the ones the app trades with", () => {
  assert.ok(read("app/lib/stellar.ts").includes(`"${HITZ_CONTRACT}"`));
  assert.ok(read("app/lib/vault.ts").includes(`"${VAULT_CONTRACT}"`));
});

test("the home page's title and description fit a search result", () => {
  assert.ok(HOME_TITLE.length <= 65, `title is ${HOME_TITLE.length} characters`);
  assert.ok(HOME_DESCRIPTION.length >= 110 && HOME_DESCRIPTION.length <= 160, `description is ${HOME_DESCRIPTION.length} characters`);
});

test("page URLs end in a slash, as the site serves them", () => {
  assert.equal(pageUrl("/"), "https://skyhitz.io/");
  assert.equal(pageUrl("/whitepaper"), "https://skyhitz.io/whitepaper/");
  assert.equal(pageUrl("whitepaper/"), "https://skyhitz.io/whitepaper/");
  for (const path of INDEXED_PAGES) assert.ok(pageUrl(path).endsWith("/"));
});

test("every question has an answer, its own anchor, and no em-dash", () => {
  const ids = new Set(FAQS.map((f) => f.id));
  assert.equal(ids.size, FAQS.length, "anchors must be unique");
  for (const faq of FAQS) {
    assert.match(faq.id, /^[a-z0-9-]+$/);
    assert.ok(faq.question.endsWith("?"), faq.question);
    assert.ok(faq.answer.length >= 80, `${faq.id}: answer too short to be one`);
    assert.ok(!/[–—]/.test(faq.question + faq.answer), `${faq.id}: house style is no dashes`);
  }
});
