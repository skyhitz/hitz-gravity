// Small JSON response helpers. Every endpoint returns the same shape on
// error — {error: string} — so the client has one parsing path to worry
// about. Success shapes are endpoint-specific.

import { callerBucket } from "./rate-limit.ts";

export function json<T>(data: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export function badRequest(msg: string): Response {
  return json({ error: msg }, { status: 400 });
}

export function unauthorized(msg = "unauthorized"): Response {
  return json({ error: msg }, { status: 401 });
}

export function serverError(msg: string): Response {
  return json({ error: msg }, { status: 500 });
}

/** Safely parse a JSON body; returns null on bad JSON or wrong content-type. */
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  const ct = req.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Who the request counts as for per-address rate limits: the address
 * Cloudflare saw (an IPv6 /64 as one caller), or "unknown" outside
 * Cloudflare (local dev).
 */
export function clientIp(req: Request): string {
  return callerBucket(req.headers.get("CF-Connecting-IP") ?? "");
}

/** 429 for a rate limit that was hit, with when to come back. */
export function tooManyRequests(retryAfter: number | undefined): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter ?? 60));
  const wait = seconds >= 3600 ? `${Math.ceil(seconds / 3600)} hours` : `${Math.ceil(seconds / 60)} minutes`;
  return json(
    { error: `Too many requests. Try again in ${wait}.` },
    { status: 429, headers: { "Retry-After": String(seconds) } }
  );
}
