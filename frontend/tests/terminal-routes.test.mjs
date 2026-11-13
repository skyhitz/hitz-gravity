// The terminal's HTTP API end to end, with a fake data worker: what a free visitor, a paying account and
// an API key each get, and what each is refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { handleTerminal } from "../functions/_lib/terminal/routes.ts";
import { COOKIE } from "../functions/_lib/terminal/auth.ts";
import { testDb } from "./helpers/d1.mjs";
import { fakeKv } from "./helpers/kv.mjs";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const APP = "https://skyhitz.io";
const NET = Networks.PUBLIC;
const user = Keypair.random();

function setup() {
  const db = testDb();
  const calls = [];
  const market = new Proxy(
    {},
    { get: (_t, name) => async (args) => (calls.push({ method: String(name), args }), { rows: [{ t: 1 }], from: String(name) }) },
  );
  const cache = new Map();
  const sent = [];
  const deps = {
    db,
    market,
    chain: () => {
      throw new Error("no chain in these tests");
    },
    secret: "e".repeat(64),
    passphrase: NET,
    appUrl: APP,
    kv: fakeKv(),
    emailAccount: async () => null,
    horizonAccount: async () => null,
    send: async (url, body) => (sent.push({ url, body }), 200),
    cache: { match: async (k) => cache.get(k)?.clone(), put: async (k, r) => void cache.set(k, r) },
    nowMs: T0,
    waitUntil: (p) => p,
  };
  const call = (path, init = {}, over = {}) => handleTerminal(new Request(`${APP}/api/terminal${path}`, init), { ...deps, ...over });
  const post = (path, body, headers = {}) => call(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: APP, ...headers }, body: JSON.stringify(body) });
  const buy = (account, plan, at = T0 - 1000) =>
    db.raw.prepare("INSERT INTO terminal_purchases (account, plan, periods, usd, paid_at, checkout_id, tx_hash) VALUES (?, ?, 1, 1, ?, ?, ?)").run(account, plan, at, `c-${account}-${at}`, `t-${account}-${at}`);
  return { db, calls, deps, call, post, buy, cache, sent };
}

async function signIn(s, kp = user) {
  const ch = await (await s.post("/auth/challenge", { account: kp.publicKey() })).json();
  const tx = TransactionBuilder.fromXDR(ch.xdr, NET);
  tx.sign(kp);
  const res = await s.post("/auth/verify", { account: kp.publicKey(), xdr: tx.toXDR() });
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  return { cookie: cookie.split(";")[0], signed: tx.toXDR() };
}

test("plans are public, with prices and what each plan sees", async () => {
  const s = setup();
  const res = await s.call("/plans");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const b = await res.json();
  assert.deepEqual(b.plans.map((p) => [p.id, p.usd_per_30_days]), [["free", 0], ["trader", 29], ["pro", 99], ["institutional", 499]]);
  assert.deepEqual(b.pay_with, ["USDC", "XLM"]);
});

test("a free visitor gets delayed hourly data, cached for everyone, and is refused paid datasets", async () => {
  const s = setup();
  const res = await s.call("/data/spreads?resolution=1m&from=2021-01-01");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.meta.plan, "free");
  assert.equal(b.meta.delayed_by_minutes, 60);
  assert.match(b.meta.license, /no redistribution/);
  assert.deepEqual(s.calls[0], { method: "terminalSpreads", args: { fromMs: T0 - 7 * 86_400_000, toMs: T0 - 3_600_000, resolution: "1h" } });
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
  await s.call("/data/spreads?resolution=1m&from=2021-01-01");
  assert.equal(s.calls.length, 1, "the second free request is served from the cache");
  const lev = await s.call("/data/leverage");
  assert.equal(lev.status, 403);
  assert.deepEqual(await lev.json(), { error: "leverage needs the trader plan or higher.", code: "plan_required", upgrade: "trader" });
  assert.equal(lev.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await s.call("/data/labels")).status, 403);
});

test("wallet sign-in sets a session, and a signed challenge works once", async () => {
  const s = setup();
  const { cookie, signed } = await signIn(s);
  const me = await (await s.call("/me", { headers: { Cookie: cookie } })).json();
  assert.deepEqual([me.account, me.via, me.plan], [user.publicKey(), "wallet", "free"]);
  const again = await s.post("/auth/verify", { account: user.publicKey(), xdr: signed });
  assert.equal(again.status, 401);
  assert.equal((await again.json()).code, "challenge_used");
  const other = Keypair.random();
  const ch = await (await s.post("/auth/challenge", { account: other.publicKey() })).json();
  const tx = TransactionBuilder.fromXDR(ch.xdr, NET);
  tx.sign(user);
  assert.equal((await s.post("/auth/verify", { account: other.publicKey(), xdr: tx.toXDR() })).status, 401);
});

test("a paying account sees live, fine data and is never served from the shared cache", async () => {
  const s = setup();
  const { cookie } = await signIn(s);
  s.buy(user.publicKey(), "pro");
  const res = await s.call("/data/spreads?resolution=1m", { headers: { Cookie: cookie } });
  const b = await res.json();
  assert.equal(b.meta.plan, "pro");
  assert.deepEqual(s.calls.at(-1).args, { fromMs: T0 - 6 * 3_600_000, toMs: T0, resolution: "1m" });
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(s.cache.size, 0);
});

test("API keys: Pro and up, shown once, work for data only, and stop when revoked or the plan ends", async () => {
  const s = setup();
  const { cookie } = await signIn(s);
  assert.equal((await s.post("/keys", {}, { Cookie: cookie })).status, 402, "no keys on the free plan");
  s.buy(user.publicKey(), "pro");
  const made = await (await s.post("/keys", { label: "desk" }, { Cookie: cookie })).json();
  assert.match(made.key, /^htz_/);
  const auth = { Authorization: `Bearer ${made.key}` };
  const data = await s.call("/data/leverage?resolution=5m", { headers: auth });
  assert.equal(data.status, 200);
  assert.equal((await data.json()).meta.plan, "pro");
  // A key cannot manage the account.
  const mint = await s.post("/keys", {}, auth);
  assert.equal(mint.status, 403);
  assert.equal((await mint.json()).code, "session_required");
  // Three keys on Pro.
  await s.post("/keys", {}, { Cookie: cookie });
  await s.post("/keys", {}, { Cookie: cookie });
  assert.equal((await s.post("/keys", {}, { Cookie: cookie })).status, 409);
  const me = await (await s.call("/me", { headers: { Cookie: cookie } })).json();
  assert.equal(me.keys.length, 3);
  assert.ok(me.keys.every((k) => !("key" in k) && !("hash" in k)), "/me never shows a key again");
  // When the plan ends the key says so; once revoked it is refused.
  const later = await s.call("/data/spreads", { headers: auth }, { nowMs: T0 + 31 * 86_400_000 });
  assert.equal(later.status, 402);
  await s.post("/keys/revoke", { prefix: made.prefix }, { Cookie: cookie });
  const gone = await s.call("/data/spreads", { headers: auth });
  assert.equal(gone.status, 401);
  assert.equal((await gone.json()).code, "invalid_key");
});

test("account changes need a session from the site itself", async () => {
  const s = setup();
  assert.equal((await s.post("/checkout", { plan: "pro", periods: 1, asset: "USDC" })).status, 401);
  const { cookie } = await signIn(s);
  const cross = await s.post("/keys", {}, { Cookie: cookie, Origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).code, "cross_site");
  const form = await s.call("/keys", { method: "POST", headers: { Cookie: cookie, Origin: APP, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
});

test("webhooks: paid plans only, public https URLs, and a signed test delivery", async () => {
  const s = setup();
  const { cookie } = await signIn(s);
  assert.equal((await s.post("/webhooks", { url: "https://hooks.example.org/x" }, { Cookie: cookie })).status, 402);
  s.buy(user.publicKey(), "trader");
  assert.equal((await s.post("/webhooks", { url: "http://hooks.example.org/x" }, { Cookie: cookie })).status, 400);
  assert.equal((await s.post("/webhooks", { url: "https://hooks.example.org/x", kinds: ["nope"] }, { Cookie: cookie })).status, 400);
  const made = await (await s.post("/webhooks", { url: "https://discord.example.org/api/webhooks/1", format: "discord", kinds: ["sdf_deposit"] }, { Cookie: cookie })).json();
  assert.match(made.secret, /^whsec_/);
  const t = await (await s.post("/webhooks/test", { id: made.id }, { Cookie: cookie })).json();
  assert.deepEqual(t, { status: 200, ok: true });
  assert.match(JSON.parse(s.sent[0].body).content, /Test alert/);
  await s.post("/webhooks", { url: "https://two.example.org/x" }, { Cookie: cookie });
  assert.equal((await s.post("/webhooks", { url: "https://three.example.org/x" }, { Cookie: cookie })).status, 409, "two on Trader");
});

test("free visitors are rate limited by address; unknown routes are 404; data preflights pass", async () => {
  const s = setup();
  const req = () => s.call("/data/overview", { headers: { "CF-Connecting-IP": "203.0.113.9" } }, { cache: null });
  for (let i = 0; i < 30; i++) assert.equal((await req()).status, 200);
  const over = await req();
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("Retry-After")) > 0);
  assert.equal((await s.call("/data/overview", { headers: { "CF-Connecting-IP": "198.51.100.1" } }, { cache: null })).status, 200, "another address is unaffected");
  assert.equal((await s.call("/nope")).status, 404);
  const pre = await s.call("/data/spreads", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Headers"), "Authorization");
});

test("a dead data service is a 502, never a crash, and cookies are not read across sites", async () => {
  const s = setup();
  const broken = new Proxy({}, { get: () => async () => { throw new Error("down"); } });
  const res = await s.call("/data/overview", {}, { market: broken, cache: null });
  assert.equal(res.status, 502);
  assert.equal((await s.call("/data/overview", {}, { market: null, cache: null })).status, 503);
  assert.equal(COOKIE, "hitz_terminal");
});
