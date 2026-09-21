// Edge-cache wrapper for public, read-only JSON routes.

import { json } from "./http";

/**
 * Serve `produce()` as JSON through the colo's HTTP cache, keyed by the
 * full request URL. `ttl` may depend on the body (e.g. full pages of an
 * append-only table can be cached longer than the tail page).
 * CORS is open: every route using this serves public on-chain data.
 */
export async function cachedJson<T>(
  request: Request,
  ctx: ExecutionContext,
  produce: () => Promise<T>,
  ttl: number | ((body: T) => number)
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(request.url);
  const hit = await cache.match(key);
  if (hit) return hit;

  const body = await produce();
  const seconds = typeof ttl === "function" ? ttl(body) : ttl;
  const response = json(body, {
    headers: {
      "Cache-Control": `public, max-age=${seconds}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
  if (seconds > 0) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
