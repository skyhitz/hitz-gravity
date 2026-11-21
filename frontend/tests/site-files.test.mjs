// The static files a browser, a crawler or an agent reads before anything
// else: the response headers (public/_headers), robots.txt, security.txt,
// llms.txt and the API catalog. These are plain text that nothing compiles,
// so a typo or a value left behind when the code moves is caught here.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAQS } from "../app/lib/faq.ts";
import { HITZ_CONTRACT, HOME_DESCRIPTION, HOME_TITLE, INDEXED_PAGES, SITE_URL, VAULT_CONTRACT, pageUrl } from "../app/lib/site.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/**
 * public/_headers as { pattern: { header: value } }, comments dropped. A header
 * named twice in a rule is joined with ", ", as Cloudflare joins it.
 */
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
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      current[name] = current[name] ? `${current[name]}, ${value}` : value;
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

/** robots.txt as groups of { agents, rules, signals }, plus the sitemap lines. */
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
      if (!group || inRules) groups.push((group = { agents: [], rules: [], signals: {} }));
      inRules = false;
      group.agents.push(value);
    } else if (field === "content-signal") {
      // https://contentsignals.org: name=yes or name=no, comma-separated, for
      // the crawlers of the group the line is in.
      assert.ok(group, "Content-Signal before any User-agent");
      for (const pair of value.split(",")) {
        const [name, choice] = pair.split("=").map((part) => part.trim());
        assert.ok(["yes", "no"].includes(choice), `robots.txt: Content-Signal "${pair.trim()}" isn't name=yes or name=no`);
        group.signals[name] = choice;
      }
    } else {
      // Lighthouse's robots.txt audit fails on any field it doesn't know
      // (content-signal is one it knows, since Lighthouse 13.1).
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

test("robots.txt allows search, AI input and AI training, in every group", () => {
  // A crawler reads only the group that names it, so each group has to say it.
  for (const group of robots().groups) {
    assert.deepEqual(group.signals, { search: "yes", "ai-input": "yes", "ai-train": "yes" }, `content signals in the group for ${group.agents[0]}`);
  }
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

// ─── Discovery: the home page's Link headers and the API catalog ─────────────

/** A Link header (RFC 8288) as [{ rel, target }], one entry per relation type. */
function links(header) {
  if (!header) return [];
  return header.split(/,\s*(?=<)/).flatMap((value) => {
    const match = /^<([^>]*)>(.*)$/.exec(value.trim());
    assert.ok(match, `not a Link value: ${value}`);
    const params = {};
    for (const param of match[2].split(";").slice(1)) {
      const at = param.indexOf("=");
      assert.ok(at > 0, `Link parameter without a value: ${param}`);
      params[param.slice(0, at).trim().toLowerCase()] = param.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
    }
    assert.ok(params.rel, `Link without a rel: ${value}`);
    return params.rel.split(/\s+/).map((rel) => ({ rel, target: match[1] }));
  });
}

/**
 * Whether this site answers a GET for `url` (a path, or a URL on this site): a
 * file in public/, a page in app/ asked for with the trailing slash it is
 * served at, or a route of the Worker. A #fragment must be an id on the page.
 */
function served(url) {
  const { origin, pathname, hash } = new URL(url, SITE_URL);
  if (origin !== SITE_URL) return false;
  const file = join(root, "public", pathname);
  if (existsSync(file) && statSync(file).isFile()) return !hash;
  if (pathname.endsWith("/")) {
    const groups = ["", ...readdirSync(join(root, "app")).filter((name) => /^\(.+\)$/.test(name))];
    const page = groups.map((group) => join("app", group, pathname, "page.tsx")).find((path) => existsSync(join(root, path)));
    if (page) return !hash || read(page).includes(`id="${hash.slice(1)}"`);
  }
  return !hash && read("functions/worker.ts").includes(`"GET ${pathname}"`);
}

const homeLinks = () => links(headerRules()["/"]?.["Link"]);

/** The API catalog the home page links to: its path, and the linkset in it. */
function apiCatalog() {
  const link = homeLinks().find(({ rel }) => rel === "api-catalog");
  assert.ok(link, 'no Link with rel="api-catalog" on the home page');
  const path = new URL(link.target, SITE_URL).pathname;
  return { path, catalog: JSON.parse(read(join("public", path))) };
}

test("the home page's Link headers point agents to the API catalog, the API's description and docs, and llms.txt", () => {
  const rels = homeLinks().map(({ rel }) => rel);
  for (const rel of ["api-catalog", "service-desc", "service-doc", "describedby"]) {
    assert.ok(rels.includes(rel), `no Link with rel="${rel}" on the home page`);
  }
  // service-desc is for machines (RFC 8631): the OpenAPI document, not a page about the API.
  const desc = homeLinks().find(({ rel }) => rel === "service-desc");
  assert.equal(new URL(desc.target, SITE_URL).pathname, "/api/v1/openapi.json");
});

test("every Link on the home page leads to something the site serves", () => {
  const all = homeLinks();
  assert.ok(all.length > 0, "no Link header on the home page");
  for (const { rel, target } of all) assert.ok(served(target), `rel="${rel}" points at ${target}, which the site doesn't serve`);
});

test("the API catalog is a linkset (RFC 9264) of endpoints the site serves, with absolute links that resolve", () => {
  const { catalog } = apiCatalog();
  assert.ok(Array.isArray(catalog.linkset) && catalog.linkset.length > 0, 'the catalog has no "linkset" array');
  for (const entry of catalog.linkset) {
    assert.ok(entry.anchor?.startsWith(`${SITE_URL}/`), `an anchor must be an absolute URL on this site: ${entry.anchor}`);
    assert.ok(served(entry.anchor), `${entry.anchor} isn't an endpoint the site serves`);
    for (const [rel, targets] of Object.entries(entry)) {
      if (rel === "anchor") continue;
      assert.ok(Array.isArray(targets) && targets.length > 0, `${entry.anchor}: "${rel}" must be an array of link targets, even for one`);
      for (const { href } of targets) {
        assert.match(href, /^https:\/\//, `${entry.anchor}: "${rel}" must be an absolute URL`);
        if (href.startsWith(`${SITE_URL}/`)) assert.ok(served(href), `${entry.anchor}: "${rel}" points at ${href}, which the site doesn't serve`);
      }
    }
  }
});

test("the catalog lists the HTTP API, with the description the home page names and its docs, and the MCP server", () => {
  const { catalog } = apiCatalog();
  const entry = (path) => catalog.linkset.find(({ anchor }) => anchor === `${SITE_URL}${path}`);
  const api = entry("/api/v1");
  assert.ok(api, "the HTTP API (/api/v1) isn't in the catalog");
  const desc = homeLinks().find(({ rel }) => rel === "service-desc");
  assert.deepEqual(api["service-desc"]?.map(({ href }) => href), [new URL(desc.target, SITE_URL).href], "the catalog and the home page must name the same API description");
  assert.ok(api["service-doc"]?.length, "the HTTP API has no service-doc link");
  assert.ok(entry("/mcp"), "the MCP server (/mcp) isn't in the catalog");
});

test("the API catalog is served as an RFC 9727 linkset, to any origin, with the Link header RFC 9727 requires of it", () => {
  const { path } = apiCatalog();
  const rule = headerRules()[path];
  assert.ok(rule, `public/_headers has no rule for ${path}: a file with no extension is served with no Content-Type at all`);
  assert.match(rule["Content-Type"] ?? "", /^application\/linkset\+json; ?profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"$/);
  assert.equal(rule["Access-Control-Allow-Origin"], "*");
  // RFC 9727 section 2: a HEAD request for the catalog gets a Link header naming it with rel="api-catalog".
  const self = links(rule["Link"]).filter(({ rel }) => rel === "api-catalog");
  assert.deepEqual(self.map(({ target }) => new URL(target, SITE_URL).pathname), [path]);
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

// ─── Listings ────────────────────────────────────────────────────────────────

test("server.json describes the MCP server the Worker runs", () => {
  const server = JSON.parse(readFileSync(join(root, "..", "server.json"), "utf8"));
  const mcp = read("functions/api/mcp.ts");
  const version = /version: "([^"]+)"/.exec(mcp)?.[1];
  assert.equal(server.version, version, "bump server.json and SERVER_INFO.version in functions/api/mcp.ts together");
  assert.match(server.name, /^io\.github\.skyhitz\/[a-z0-9._-]+$/, "publish-mcp.yml signs in with GitHub OIDC, which grants io.github.skyhitz/*");
  assert.ok(server.description.length <= 100, `description is ${server.description.length} characters; the registry allows 100`);
  assert.deepEqual(server.remotes, [{ type: "streamable-http", url: "https://skyhitz.io/mcp" }]);
});

test("the listing files name the contracts the app trades with", () => {
  const adapter = readFileSync(join(root, "..", "listings", "defillama", "index.js"), "utf8");
  assert.ok(adapter.includes(`'${VAULT_CONTRACT}'`) && adapter.includes(`'${HITZ_CONTRACT}'`));
  const token = JSON.parse(readFileSync(join(root, "..", "listings", "soroswap", `${HITZ_CONTRACT}.json`), "utf8"));
  assert.equal(token.contract, HITZ_CONTRACT);
  assert.equal(token.domain, "skyhitz.io");
  assert.ok(read("public/.well-known/stellar.toml").includes(`contract = "${HITZ_CONTRACT}"`), "stellar.toml must list the token the Soroswap entry names");
});

test("stellar.toml marks the legacy classic HITZ dead and the Soroban token live", () => {
  const toml = read("public/.well-known/stellar.toml");
  const entries = toml.split("[[CURRENCIES]]").slice(1);
  const legacy = entries.find((e) => /issuer = "GCAETBNB/.test(e) && /code = "HITZ"/.test(e));
  const current = entries.find((e) => e.includes(`contract = "${HITZ_CONTRACT}"`));
  assert.ok(legacy && current, "both HITZ entries must stay in stellar.toml");
  assert.match(legacy, /^status = "dead"$/m);
  assert.doesNotMatch(legacy, /^image = /m, "the legacy asset must not carry the current HITZ logo");
  assert.match(current, /^status = "live"$/m);
});
