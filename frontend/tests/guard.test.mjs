// The guards every request passes through (functions/_lib/guard.ts): the cap
// on request bodies, the security headers, cache keys that can't be dodged
// with a made-up query parameter, and which rate limiter a request counts
// against.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyTooLarge,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  cacheKey,
  declaresOversizeBody,
  isCostly,
  readText,
  secretsEqual,
  secured,
  withinEdgeLimits,
} from "../functions/_lib/guard.ts";

const post = (body, headers = {}) => new Request("https://skyhitz.io/api/v1/swap", { method: "POST", body, headers });

/** A body sent in chunks with no Content-Length, as a streaming client would. */
function streamed(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(enc.encode(c));
      ctl.close();
    },
  });
  return new Request("https://skyhitz.io/mcp", { method: "POST", body, duplex: "half" });
}

// ─── Request bodies ──────────────────────────────────────────────────────────

test("a body under the cap is read whole", async () => {
  assert.equal(await readText(post('{"a":1}')), '{"a":1}');
  assert.equal(await readText(streamed(['{"a":', "1}"])), '{"a":1}');
  assert.equal(await readText(post("héllo ✓")), "héllo ✓");
});

test("a request with no body reads as empty", async () => {
  assert.equal(await readText(new Request("https://skyhitz.io/api/v1/vault")), "");
});

test("a declared length over the cap is refused before anything is read", async () => {
  const request = post("{}", { "Content-Length": String(MAX_BODY_BYTES + 1) });
  assert.equal(declaresOversizeBody(request), true);
  await assert.rejects(readText(request), BodyTooLarge);
  assert.equal(declaresOversizeBody(post("{}")), false);
});

test("a streamed body is cut off at the cap", async () => {
  const chunk = "x".repeat(1024);
  await assert.rejects(readText(streamed(Array(8).fill(chunk)), 4096), BodyTooLarge);
  assert.equal((await readText(streamed(Array(4).fill(chunk)), 4096)).length, 4096);
});

// ─── Response headers ────────────────────────────────────────────────────────

test("every answer gets the security headers and is not cached by default", async () => {
  const out = secured(new Response('{"ok":true}', { status: 201, headers: { "Content-Type": "application/json", "Set-Cookie": "a=b" } }));
  assert.equal(out.status, 201);
  assert.equal(await out.text(), '{"ok":true}');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(out.headers.get(name), value);
  assert.equal(out.headers.get("Cache-Control"), "no-store");
  assert.equal(out.headers.get("Set-Cookie"), "a=b");
  assert.equal(out.headers.get("X-Frame-Options"), "DENY");
  assert.match(out.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});

test("a route's own cache policy and headers are kept", () => {
  const out = secured(new Response("{}", { headers: { "Cache-Control": "public, max-age=10", "Referrer-Policy": "origin" } }));
  assert.equal(out.headers.get("Cache-Control"), "public, max-age=10");
  assert.equal(out.headers.get("Referrer-Policy"), "origin");
});

test("an answer with no body keeps its status", () => {
  const out = secured(new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } }));
  assert.equal(out.status, 204);
  assert.equal(out.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff");
});

// ─── Cache keys ──────────────────────────────────────────────────────────────

test("parameters a route doesn't read are not part of its cache key", () => {
  const key = cacheKey("https://skyhitz.io/api/v1/vault");
  assert.equal(key, "https://skyhitz.io/api/v1/vault");
  assert.equal(cacheKey("https://skyhitz.io/api/v1/vault?bust=123&x=y"), key);
  assert.equal(cacheKey("https://skyhitz.io/api/data/status?_=1700000000"), "https://skyhitz.io/api/data/status");
});

test("the parameters a route reads select its answer, in any order", () => {
  const params = ["sell", "buy", "amount", "buy_amount", "account"];
  const a = cacheKey("https://skyhitz.io/api/v1/quote?sell=XLM&buy=HITZ&amount=100", params);
  assert.equal(a, "https://skyhitz.io/api/v1/quote?amount=100&buy=HITZ&sell=XLM");
  assert.equal(cacheKey("https://skyhitz.io/api/v1/quote?amount=100&buy=HITZ&sell=XLM&junk=1", params), a);
  assert.notEqual(cacheKey("https://skyhitz.io/api/v1/quote?sell=XLM&buy=HITZ&amount=101", params), a);
  assert.notEqual(cacheKey("https://skyhitz.io/api/v1/quote?sell=XLM&buy=HITZ&buy_amount=100", params), a);
  assert.notEqual(cacheKey("https://skyhitz.io/api/v1/quote?sell=xlm&buy=HITZ&amount=100", params), a);
});

test("a repeated parameter counts once, with the value the route would use", () => {
  const params = ["after", "limit"];
  assert.equal(
    cacheKey("https://skyhitz.io/api/data/events?limit=5&limit=10", params),
    cacheKey("https://skyhitz.io/api/data/events?limit=10", params)
  );
});

test("values can't be made to look like another parameter", () => {
  const params = ["pool", "after", "limit"];
  const plain = cacheKey("https://skyhitz.io/api/data/pool-reserves?pool=A&after=B", params);
  const smuggled = cacheKey("https://skyhitz.io/api/data/pool-reserves?pool=A%26after%3DB", params);
  assert.notEqual(plain, smuggled);
});

// ─── Rate limiters ───────────────────────────────────────────────────────────

test("writes and the gateway's own routes are the costly ones", () => {
  for (const [method, path] of [
    ["POST", "/api/v1/swap"],
    ["POST", "/api/v1/submit"],
    ["POST", "/mcp"],
    ["POST", "/api/terminal/checkout"],
    ["POST", "/api/auth/login"],
    ["GET", "/api/auth/verify"],
    ["GET", "/api/auth/session"],
    ["GET", "/api/gateway/balances"],
    ["POST", "/api/admin/legacy-reparation"],
    ["DELETE", "/mcp"],
  ]) {
    assert.equal(isCostly(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/api/v1/vault"],
    ["GET", "/api/v1/quote"],
    ["GET", "/api/v1/openapi.json"],
    ["GET", "/api/terminal/data/spreads"],
    ["GET", "/api/holders"],
    ["GET", "/mcp"],
    ["OPTIONS", "/api/v1/swap"],
    ["HEAD", "/api/v1/vault"],
  ]) {
    assert.equal(isCostly(method, path), false, `${method} ${path}`);
  }
});

/** A limiter that allows `allowed` hits per key and records what it was asked. */
function limiter(allowed) {
  const seen = new Map();
  return {
    seen,
    async limit({ key }) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= allowed };
    },
  };
}

test("each caller is counted on its own, against both limiters when the request is costly", async () => {
  const any = limiter(3);
  const costly = limiter(1);
  const limiters = { any, costly };
  assert.equal(await withinEdgeLimits(limiters, "203.0.113.7", "GET", "/api/v1/vault"), true);
  assert.equal(costly.seen.size, 0);
  assert.equal(await withinEdgeLimits(limiters, "203.0.113.7", "POST", "/api/v1/swap"), true);
  assert.equal(await withinEdgeLimits(limiters, "203.0.113.7", "POST", "/api/v1/swap"), false);
  assert.equal(await withinEdgeLimits(limiters, "203.0.113.7", "GET", "/api/v1/vault"), false);
  assert.equal(await withinEdgeLimits(limiters, "198.51.100.9", "POST", "/api/v1/swap"), true);
});

test("a request over the general limit doesn't use up the costly one", async () => {
  const any = limiter(0);
  const costly = limiter(5);
  assert.equal(await withinEdgeLimits({ any, costly }, "203.0.113.7", "POST", "/mcp"), false);
  assert.equal(costly.seen.size, 0);
});

test("a missing or failing limiter lets requests through", async () => {
  assert.equal(await withinEdgeLimits({}, "203.0.113.7", "POST", "/mcp"), true);
  const broken = {
    async limit() {
      throw new Error("limiter unavailable");
    },
  };
  assert.equal(await withinEdgeLimits({ any: broken, costly: broken }, "203.0.113.7", "POST", "/mcp"), true);
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

test("secrets compare equal only when they are", async () => {
  assert.equal(await secretsEqual("correct horse battery staple", "correct horse battery staple"), true);
  assert.equal(await secretsEqual("correct horse battery staple", "correct horse battery stapl"), false);
  assert.equal(await secretsEqual("a", "b"), false);
  assert.equal(await secretsEqual("", "x"), false);
});
