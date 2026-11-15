// Guards that apply to every request, whatever the endpoint. worker.ts runs
// them around the dispatch table:
//
//   - a cap on how much request body is ever buffered,
//   - security headers on every answer the Worker writes,
//   - cache keys that ignore query parameters a route never reads,
//   - which of Cloudflare's rate limiters a request counts against,
//   - a comparison of secrets that takes the same time whatever they hold.
//
// Pure and erasable TypeScript, run in Node by tests/guard.test.mjs.

// ─── Request bodies ──────────────────────────────────────────────────────────

/**
 * The most request body any endpoint reads. The largest thing a caller has a
 * reason to send is a signed transaction: a vault swap is a few KB, and the
 * network refuses envelopes over about 130 KB. Anything past this is not a
 * request the Worker serves, and buffering it would only cost memory.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** A request body over the cap. Answered with 413. */
export class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}

/** True when the request says up front that its body is over the cap. */
export function declaresOversizeBody(request: Request, max: number = MAX_BODY_BYTES): boolean {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  return Number.isFinite(declared) && declared > max;
}

/**
 * The request body as text. Reads the stream itself and stops at `max` bytes,
 * so a body with no Content-Length (or a false one) can't be buffered whole.
 */
export async function readText(request: Request, max: number = MAX_BODY_BYTES): Promise<string> {
  if (declaresOversizeBody(request, max)) throw new BodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

// ─── Response headers ────────────────────────────────────────────────────────

/**
 * On every answer the Worker writes. They are JSON for programs, never pages:
 * nothing in them may be framed, sniffed into another type, or run.
 *
 * HSTS names this host only. `includeSubDomains` and `preload` are a decision
 * about every name under skyhitz.io, taken in the Cloudflare dashboard.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
};

/**
 * The response with the security headers added. A route's own value for one
 * of them is kept, and an answer that says nothing about caching is not
 * stored: only the public read routes set Cache-Control, on purpose.
 */
export function secured(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  return out;
}

// ─── Cache keys ──────────────────────────────────────────────────────────────

/**
 * The cache key of a public read route: its URL with only the query
 * parameters that select its answer, in a fixed order. Parameters the route
 * never reads are dropped, so appending one can't get past the cache and make
 * the Worker do the work again for every request.
 *
 * When a parameter is repeated the last value counts, as it does for the
 * routes themselves (Object.fromEntries over the query, or searchParams.get
 * on a single value).
 */
export function cacheKey(requestUrl: string, params: readonly string[] = []): string {
  const url = new URL(requestUrl);
  const kept: string[] = [];
  for (const name of [...params].sort()) {
    const values = url.searchParams.getAll(name);
    if (values.length) kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(values[values.length - 1])}`);
  }
  return `${url.origin}${url.pathname}${kept.length ? `?${kept.join("&")}` : ""}`;
}

// ─── Rate limiters ───────────────────────────────────────────────────────────

/** Cloudflare's rate limiting binding (wrangler.toml [[ratelimits]]). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * True for requests that make the Worker do something that costs: send an
 * email, write to a database, build or relay a transaction, look a caller up.
 * Those count against the stricter limiter; plain reads count against the
 * general one only.
 */
export function isCostly(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return true;
  return pathname.startsWith("/api/auth/") || pathname.startsWith("/api/gateway/") || pathname.startsWith("/api/admin/");
}

/**
 * Count the request against the edge limiters, per caller. False when the
 * caller is over a limit. The limiters are approximate and per location: the
 * exact limits on what costs money stay in D1 (limits.ts). A limiter that is
 * missing or fails lets the request through, so the API never goes down with it.
 */
export async function withinEdgeLimits(
  limiters: { any?: RateLimiter; costly?: RateLimiter },
  caller: string,
  method: string,
  pathname: string
): Promise<boolean> {
  try {
    if (limiters.any && !(await limiters.any.limit({ key: caller })).success) return false;
    if (limiters.costly && isCostly(method, pathname) && !(await limiters.costly.limit({ key: caller })).success) return false;
  } catch {
    // fall through: an unavailable limiter is not a reason to refuse
  }
  return true;
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

/**
 * Whether two secrets are equal, in time that doesn't depend on where they
 * differ: both are hashed first, and every byte of the digests is compared.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
