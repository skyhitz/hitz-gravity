// Edge-cache wrapper for public, read-only JSON routes.

import { cacheKey } from "./guard";
import { json } from "./http";

/**
 * Serve `produce()` as JSON through the colo's HTTP cache. `ttl` may depend
 * on the body (e.g. full pages of an append-only table can be cached longer
 * than the tail page). `params` names the query parameters `produce` reads:
 * the cache key is the path and those alone, so a made-up parameter can't
 * force a fresh read on every request.
 * CORS is open: every route using this serves public on-chain data.
 */
export async function cachedJson<T>(
  request: Request,
  ctx: ExecutionContext,
  produce: () => Promise<T>,
  ttl: number | ((body: T) => number),
  params: readonly string[] = []
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(cacheKey(request.url, params));
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
