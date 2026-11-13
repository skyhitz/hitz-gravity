// The HITZ Terminal's HTTP API, /api/terminal/*. Everything it needs comes in as `deps`
// (functions/api/terminal.ts passes the real bindings), so tests run whole requests in Node.
//
//   GET  /api/terminal/plans               plans, prices, what each sees (public, CORS)
//   GET  /api/terminal/data/<dataset>      gated data (CORS; API key, cookie or nothing)
//   GET  /api/terminal/me                  the caller: plan, keys, webhooks, recent checkouts
//   POST /api/terminal/auth/challenge      {account} -> a transaction to sign
//   POST /api/terminal/auth/verify         {account, xdr} -> session cookie
//   POST /api/terminal/auth/logout
//   POST /api/terminal/checkout            {plan, periods, asset} -> a swap to sign
//   POST /api/terminal/checkout/confirm    {id, xdr? | tx_hash?}
//   POST /api/terminal/keys                {label?} -> a key, shown once
//   POST /api/terminal/keys/revoke         {prefix}
//   POST /api/terminal/webhooks            {url, format?, kinds?} -> id and signing secret
//   POST /api/terminal/webhooks/delete     {id}
//   POST /api/terminal/webhooks/test       {id}
//
// Keys, checkouts and webhooks are managed with a signed-in session only, never with an API key, so a
// leaked key cannot mint keys or move webhooks. Cookie POSTs must come from the site itself.

import { AuthError, buildChallenge, clearCookie, identify, newApiKey, requireAccount, sessionCookie, sha256Hex, signersFromHorizon, signSession, verifyChallenge, SESSION_TTL_S, type Caller } from "./auth.ts";
import { CheckoutError, confirmCheckout, startCheckout, type Chain } from "./checkout.ts";
import { gate } from "./gate.ts";
import { LICENSE, PLANS, publicPlans, type Plan } from "./plans.ts";
import { activeKeyCount, deleteWebhook, getWebhook, insertKey, insertWebhook, keyAccount, listCheckouts, listKeys, listWebhooks, planOf, revokeKey } from "./store.ts";
import { ALERT_KINDS, bodyFor, checkWebhookUrl, FORMATS, sampleAlert, signatureHeader, webhookSecret, type Send } from "./webhooks.ts";
import { callerBucket, hit, type Limit } from "../rate-limit.ts";

/** The data worker's MarketData entry point, as the MARKET service binding exposes it. */
export type Market = Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface TerminalDeps {
  db: D1Database;
  market: Market | null;
  chain: () => Chain;
  /** Derived from MASTER_SECRET (derive.ts terminalSecret). */
  secret: string;
  passphrase: string;
  appUrl: string;
  kv: KvLike;
  emailAccount(request: Request): Promise<string | null>;
  /** Horizon's account record, or null when the account does not exist. */
  horizonAccount(account: string): Promise<unknown | null>;
  send: Send;
  cache: CacheLike | null;
  nowMs: number;
  waitUntil(p: Promise<unknown>): void;
}

const PREFIX = "/api/terminal";
const MINUTE = 60;
const DAY = 86_400;
const FREE_CACHE_S = 60;
/** Everyone's requests together, a minute: protects the data worker. */
const ALL_PER_MINUTE = 6_000;

const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Max-Age": "86400",
};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", ...headers } });
}

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  reply({ error, code, ...extra }, status, headers);

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) throw new HttpError(415, "json_required", "Send a JSON body (Content-Type: application/json).");
  try {
    const b: unknown = await request.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_body", "Send a JSON object.");
}

class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function limit(db: D1Database, groups: Limit[][], nowMs: number): Promise<void> {
  const v = await hit(db, groups, nowMs);
  if (!v.ok) throw new HttpError(429, "rate_limited", "Too many requests. Slow down and try again shortly.", { retry_after: v.retryAfter ?? 60 });
}

const ip = (request: Request) => callerBucket(request.headers.get("CF-Connecting-IP") ?? "");

/** Cookie-authenticated changes must come from the site itself (SameSite already stops most). */
function sameSite(request: Request, appUrl: string): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(appUrl).origin) throw new HttpError(403, "cross_site", "Requests that change your account must come from the terminal itself.");
}

async function signedIn(request: Request, d: TerminalDeps): Promise<Caller & { account: string }> {
  const caller = await identify(request, { secret: d.secret, nowMs: d.nowMs, keyAccount: (h) => keyAccount(d.db, h, d.nowMs), emailAccount: d.emailAccount });
  if (caller.via === "key") throw new HttpError(403, "session_required", "Manage keys, payments and webhooks from the terminal, signed in with your wallet or email, not with an API key.");
  if (!caller.account) throw new HttpError(401, "sign_in", "Sign in first: connect a wallet or use your email account.");
  sameSite(request, d.appUrl);
  return caller as Caller & { account: string };
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function data(request: Request, d: TerminalDeps, dataset: string): Promise<Response> {
  const caller = await identify(request, { secret: d.secret, nowMs: d.nowMs, keyAccount: (h) => keyAccount(d.db, h, d.nowMs), emailAccount: d.emailAccount });
  const state = await planOf(d.db, caller.account, d.nowMs);
  const plan: Plan = PLANS[state.plan];
  if (caller.via === "key" && plan.apiKeys === 0) {
    throw new HttpError(402, "plan_required", "This key's account has no plan with API access (Pro or Institutional). Renew it in the terminal.", { upgrade: "pro" });
  }
  const own: Limit[] =
    plan.id === "free"
      ? [
          { bucket: `term:ip:${ip(request)}`, limit: plan.perMinute, windowSeconds: MINUTE },
          { bucket: `term:ip:${ip(request)}`, limit: plan.perDay, windowSeconds: DAY },
        ]
      : [
          { bucket: `term:acct:${caller.account}`, limit: plan.perMinute, windowSeconds: MINUTE },
          { bucket: `term:acct:${caller.account}`, limit: plan.perDay, windowSeconds: DAY },
        ];
  await limit(d.db, [own, [{ bucket: "term:all", limit: ALL_PER_MINUTE, windowSeconds: MINUTE }]], d.nowMs);

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const g = gate(plan, dataset, params, d.nowMs);
  if (!g.ok) return fail(g.status, g.code, g.message, g.upgrade ? { upgrade: g.upgrade } : {}, PUBLIC_CORS);
  if (!d.market) return fail(503, "data_unavailable", "The data service is not connected.", {}, PUBLIC_CORS);

  // Free answers are the same for every free caller: cached a minute, by the exact call (never by who asked).
  // The window is rounded to the minute so the key repeats.
  const free = plan.id === "free";
  const args = free ? roundArgs(g.args) : g.args;
  const key = `${new URL(d.appUrl).origin}/__terminal_cache/free/${g.method}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()}`;
  if (free && d.cache) {
    const hitRes = await d.cache.match(key);
    if (hitRes) return hitRes;
  }
  let result: unknown;
  try {
    // Called as a method: on a service binding every property is a remote stub, so fn.call() would be a
    // remote method named "call".
    result = await d.market[g.method](args);
  } catch (err) {
    console.error("[terminal] data", g.method, err instanceof Error ? err.message : String(err));
    return fail(502, "data_unavailable", "The data service did not answer. Try again shortly.", {}, PUBLIC_CORS);
  }
  const res = reply(
    { data: result, meta: { ...g.meta, as_of: new Date(d.nowMs).toISOString(), license: LICENSE } },
    200,
    { ...PUBLIC_CORS, "Cache-Control": free ? `public, max-age=${FREE_CACHE_S}` : "private, no-store", "X-Terminal-Plan": plan.id },
  );
  if (free && d.cache) d.waitUntil(d.cache.put(key, res.clone()));
  return res;
}

/** Free windows rounded down to the minute, so the cache key repeats within a minute. */
function roundArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "number" && /Ms$/.test(k) ? Math.floor(v / 60_000) * 60_000 : v;
  return out;
}

// ─── Account ──────────────────────────────────────────────────────────────────

async function me(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await identify(request, { secret: d.secret, nowMs: d.nowMs, keyAccount: (h) => keyAccount(d.db, h, d.nowMs), emailAccount: d.emailAccount });
  const state = await planOf(d.db, caller.account, d.nowMs);
  const plan = PLANS[state.plan];
  const base = { account: caller.account, via: caller.via, plan: state.plan, plan_name: plan.name, until: state.until ? new Date(state.until).toISOString() : null };
  if (!caller.account || caller.via === "key") return reply(base);
  const [keys, hooks, checkouts] = await Promise.all([listKeys(d.db, caller.account), listWebhooks(d.db, caller.account), listCheckouts(d.db, caller.account, 10)]);
  return reply({
    ...base,
    limits: { api_keys: plan.apiKeys, webhooks: plan.webhooks, requests_per_minute: plan.perMinute, requests_per_day: plan.perDay },
    keys: keys.map((k) => ({ prefix: k.prefix, label: k.label, created_at: iso(k.created_at), last_used_at: iso(k.last_used_at), revoked: k.revoked_at !== null })),
    webhooks: await Promise.all(
      hooks.map(async (h) => ({
        id: h.id,
        url: h.url,
        format: h.format,
        kinds: h.kinds ? JSON.parse(h.kinds) : null,
        secret: await webhookSecret(d.secret, h.id),
        failures: h.failures,
        last_status: h.last_status,
        disabled: h.disabled_at !== null,
      })),
    ),
    checkouts: checkouts.map((c) => ({ id: c.id, plan: c.plan, periods: c.periods, usd: c.usd, asset: c.asset, amount: c.amount, status: c.status, created_at: iso(c.created_at), tx_hash: c.paid_tx ?? c.tx_hash })),
  });
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

async function challenge(request: Request, d: TerminalDeps): Promise<Response> {
  await limit(d.db, [[{ bucket: `term:auth:${ip(request)}`, limit: 20, windowSeconds: 600 }]], d.nowMs);
  const b = await body(request);
  const account = requireAccount(b.account);
  return reply({ ...(await buildChallenge(account, d.secret, d.nowMs, d.passphrase)), network_passphrase: d.passphrase });
}

async function verify(request: Request, d: TerminalDeps): Promise<Response> {
  await limit(d.db, [[{ bucket: `term:auth:${ip(request)}`, limit: 20, windowSeconds: 600 }]], d.nowMs);
  sameSite(request, d.appUrl);
  const b = await body(request);
  const account = requireAccount(b.account);
  const signers = signersFromHorizon(account, await d.horizonAccount(account));
  const nonce = await verifyChallenge(String(b.xdr ?? ""), account, d.secret, signers, d.nowMs, d.passphrase);
  const burnt = `term-nonce:${nonce}`;
  if (await d.kv.get(burnt)) throw new AuthError(401, "challenge_used", "This challenge was used already. Ask for a new one.");
  await d.kv.put(burnt, "1", { expirationTtl: 900 });
  const token = await signSession({ account, exp: Math.floor(d.nowMs / 1000) + SESSION_TTL_S }, d.secret);
  const state = await planOf(d.db, account, d.nowMs);
  return reply({ account, plan: state.plan }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function checkout(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  await limit(d.db, [[{ bucket: `term:checkout:${caller.account}`, limit: 20, windowSeconds: 3600 }]], d.nowMs);
  const b = await body(request);
  return reply(await startCheckout(d.db, d.chain(), { account: caller.account, plan: b.plan, periods: b.periods, asset: b.asset }, d.nowMs));
}

async function confirm(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  await limit(d.db, [[{ bucket: `term:confirm:${caller.account}`, limit: 60, windowSeconds: 600 }]], d.nowMs);
  const b = await body(request);
  return reply(await confirmCheckout(d.db, d.chain(), caller.account, { id: b.id, xdr: b.xdr, tx_hash: b.tx_hash }, d.nowMs));
}

async function createKey(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  await limit(d.db, [[{ bucket: `term:manage:${caller.account}`, limit: 30, windowSeconds: 3600 }]], d.nowMs);
  const b = await body(request);
  const plan = PLANS[(await planOf(d.db, caller.account, d.nowMs)).plan];
  if (plan.apiKeys === 0) throw new HttpError(402, "plan_required", "API keys come with the Pro and Institutional plans.", { upgrade: "pro" });
  if ((await activeKeyCount(d.db, caller.account)) >= plan.apiKeys) throw new HttpError(409, "too_many_keys", `The ${plan.name} plan has ${plan.apiKeys} keys. Revoke one first.`);
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 60) || null : null;
  const { key, prefix } = newApiKey();
  await insertKey(d.db, { hash: await sha256Hex(key), prefix, account: caller.account, label, created_at: d.nowMs });
  return reply({ key, prefix, label, note: "Copy this key now: it is shown once. Send it as Authorization: Bearer <key>." });
}

async function revoke(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  const b = await body(request);
  if (typeof b.prefix !== "string") throw new HttpError(400, "invalid_prefix", "prefix is the key's first characters, as /me lists them.");
  if (!(await revokeKey(d.db, caller.account, b.prefix, d.nowMs))) throw new HttpError(404, "unknown_key", "No active key with that prefix.");
  return reply({ revoked: b.prefix });
}

async function createHook(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  await limit(d.db, [[{ bucket: `term:manage:${caller.account}`, limit: 30, windowSeconds: 3600 }]], d.nowMs);
  const b = await body(request);
  const plan = PLANS[(await planOf(d.db, caller.account, d.nowMs)).plan];
  if (plan.webhooks === 0) throw new HttpError(402, "plan_required", "Alert webhooks come with every paid plan.", { upgrade: "trader" });
  const existing = (await listWebhooks(d.db, caller.account)).filter((h) => h.disabled_at === null);
  if (existing.length >= plan.webhooks) throw new HttpError(409, "too_many_webhooks", `The ${plan.name} plan has ${plan.webhooks} webhooks. Delete one first.`);
  const url = checkWebhookUrl(b.url);
  if (!url.ok) throw new HttpError(400, "invalid_url", url.reason);
  const format = b.format === undefined ? "json" : String(b.format);
  if (!(FORMATS as readonly string[]).includes(format)) throw new HttpError(400, "invalid_format", `format is one of ${FORMATS.join(", ")}.`);
  let kinds: string[] | null = null;
  if (b.kinds !== undefined && b.kinds !== null) {
    if (!Array.isArray(b.kinds) || !b.kinds.length || !b.kinds.every((k) => (ALERT_KINDS as readonly string[]).includes(String(k)))) {
      throw new HttpError(400, "invalid_kinds", `kinds lists some of: ${ALERT_KINDS.join(", ")}.`);
    }
    kinds = b.kinds.map(String);
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
  await insertWebhook(d.db, { id, account: caller.account, url: url.url, format, kinds, created_at: d.nowMs });
  return reply({ id, url: url.url, format, kinds, secret: await webhookSecret(d.secret, id), signature: "X-Skyhitz-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of t + '.' + body>" });
}

async function deleteHook(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  const b = await body(request);
  if (!(await deleteWebhook(d.db, caller.account, String(b.id ?? "")))) throw new HttpError(404, "unknown_webhook", "No such webhook.");
  return reply({ deleted: b.id });
}

async function testHook(request: Request, d: TerminalDeps): Promise<Response> {
  const caller = await signedIn(request, d);
  await limit(d.db, [[{ bucket: `term:hooktest:${caller.account}`, limit: 10, windowSeconds: 3600 }]], d.nowMs);
  const b = await body(request);
  const hook = await getWebhook(d.db, caller.account, String(b.id ?? ""));
  if (!hook) throw new HttpError(404, "unknown_webhook", "No such webhook.");
  const alert = sampleAlert(d.nowMs);
  const payload = bodyFor(hook.format, alert);
  const status = await d.send(hook.url, payload, { "X-Skyhitz-Signature": await signatureHeader(await webhookSecret(d.secret, hook.id), payload, d.nowMs), "X-Skyhitz-Alert-Id": alert.id });
  return reply({ status, ok: status >= 200 && status < 300 });
}

// ─── Router ───────────────────────────────────────────────────────────────────

type Route = (request: Request, d: TerminalDeps) => Promise<Response>;

const ROUTES: Record<string, Route> = {
  "GET /plans": async () => reply({ plans: publicPlans(), pay_with: ["USDC", "XLM"], settles_in: "HITZ, bought in the Sovereign Vault and sent to the treasury", license: LICENSE }, 200, { ...PUBLIC_CORS, "Cache-Control": "public, max-age=300" }),
  "GET /me": me,
  "POST /auth/challenge": challenge,
  "POST /auth/verify": verify,
  "POST /auth/logout": async () => reply({ ok: true }, 200, { "Set-Cookie": clearCookie() }),
  "POST /checkout": checkout,
  "POST /checkout/confirm": confirm,
  "POST /keys": createKey,
  "POST /keys/revoke": revoke,
  "POST /webhooks": createHook,
  "POST /webhooks/delete": deleteHook,
  "POST /webhooks/test": testHook,
};

export async function handleTerminal(request: Request, d: TerminalDeps): Promise<Response> {
  const path = new URL(request.url).pathname.slice(PREFIX.length) || "/";
  const isData = path.startsWith("/data/");
  if (request.method === "OPTIONS" && (isData || path === "/plans")) return new Response(null, { status: 204, headers: PUBLIC_CORS });
  try {
    if (isData && request.method === "GET") return await data(request, d, path.slice("/data/".length));
    const route = ROUTES[`${request.method} ${path}`];
    if (!route) return fail(404, "not_found", "No such terminal endpoint.");
    return await route(request, d);
  } catch (err) {
    const cors = isData ? PUBLIC_CORS : {};
    if (err instanceof HttpError) return fail(err.status, err.code, err.message, err.extra, err.status === 429 ? { ...cors, "Retry-After": String(err.extra.retry_after ?? 60) } : cors);
    if (err instanceof AuthError || err instanceof CheckoutError) return fail(err.status, err.code, err.message, {}, cors);
    const status = (err as { status?: unknown }).status;
    const code = (err as { code?: unknown }).code;
    if (typeof status === "number" && typeof code === "string") return fail(status, code, (err as Error).message, {}, cors);
    console.error("[terminal]", err instanceof Error ? err.stack ?? err.message : String(err));
    return fail(500, "internal_error", "Something went wrong on our side.", {}, cors);
  }
}
