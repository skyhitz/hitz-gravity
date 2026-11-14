// Workers entrypoint. Replaces the Pages Functions auto-routing with an
// explicit dispatch table so we can use bindings Pages doesn't support
// (notably `send_email`). Static assets in out/ are served by the
// [assets] binding; this Worker only runs for /api/* and /mcp (see
// `run_worker_first` in wrangler.toml).
//
// Keeping the router as a plain object lookup — one line per endpoint,
// O(1) dispatch, trivial to scan. No framework needed.
//
// Around the table, for every request alike (_lib/guard.ts): the edge rate
// limiters, a cap on the request body, security headers on the answer, and a
// plain 500 for anything a handler didn't catch.

import { POST as authLogin } from "./api/auth/login";
import { POST as authLogout } from "./api/auth/logout";
import { GET as authMe, GET_SESSION as authSession } from "./api/auth/me";
import { GET as authVerify } from "./api/auth/verify";
import { POST as adminLegacyReparation } from "./api/admin/legacy-reparation";
import { GET as gatewayBalances } from "./api/gateway/balances";
import { POST as gatewayExecute } from "./api/gateway/execute";
import { POST as gatewayNotify } from "./api/gateway/notify";
import { POST as gatewayResolve } from "./api/gateway/resolve";
import { GET as gatewaySponsor } from "./api/gateway/sponsor";
import { GET as holders } from "./api/holders";
import { GET_ARB_RUNS, GET_CONTRACT_INFO, GET_EVENTS, GET_POOL_RESERVES, GET_STATUS, GET_TX_INFO } from "./api/data";
import { GET_LIQUIDITY, GET_PRICE_HISTORY, GET_TRACTION } from "./api/snapshots";
import * as v1 from "./api/v1";
import * as mcp from "./api/mcp";
import * as terminal from "./api/terminal";
import { runIngest } from "./_lib/ingest";
import { runArbBot } from "./_lib/arb-worker";
import { runAdminJob, watchSponsor } from "./_lib/sponsor-ops";
import { declaresOversizeBody, secured, withinEdgeLimits } from "./_lib/guard";
import { clientIp } from "./_lib/http";

/** The arbitrage bot's cron (wrangler.toml), offset from ingestion's "*\/5 * * * *". */
const ARB_CRON = "2-59/5 * * * *";
import type { Env } from "./_lib/types";

type Handler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Promise<Response>;

// Key = "METHOD /path". Exact match only — no params in our API.
const ROUTES: Record<string, Handler> = {
  "POST /api/auth/login": authLogin,
  "POST /api/auth/logout": authLogout,
  "GET /api/auth/me": authMe,
  "GET /api/auth/session": authSession,
  "GET /api/auth/verify": authVerify,
  "POST /api/admin/legacy-reparation": adminLegacyReparation,
  "GET /api/gateway/balances": gatewayBalances,
  "POST /api/gateway/execute": gatewayExecute,
  "POST /api/gateway/notify": gatewayNotify,
  "POST /api/gateway/resolve": gatewayResolve,
  "GET /api/gateway/sponsor": gatewaySponsor,
  "GET /api/holders": holders,
  "GET /api/data/events": GET_EVENTS,
  "GET /api/data/tx-info": GET_TX_INFO,
  "GET /api/data/contract-info": GET_CONTRACT_INFO,
  "GET /api/data/status": GET_STATUS,
  "GET /api/data/pool-reserves": GET_POOL_RESERVES,
  "GET /api/data/arb-runs": GET_ARB_RUNS,
  "GET /api/price/history": GET_PRICE_HISTORY,
  "GET /api/liquidity": GET_LIQUIDITY,
  "GET /api/traction": GET_TRACTION,
  // Public vault API (api/v1.ts) and the MCP server for agents (api/mcp.ts).
  "GET /api/v1": v1.GET_INDEX,
  "GET /api/v1/": v1.GET_INDEX,
  "GET /api/v1/vault": v1.GET_VAULT,
  "GET /api/v1/quote": v1.GET_QUOTE,
  "POST /api/v1/swap": v1.POST_SWAP,
  "POST /api/v1/submit": v1.POST_SUBMIT,
  "GET /api/v1/tx": v1.GET_TX,
  "GET /api/v1/account": v1.GET_ACCOUNT,
  "GET /api/v1/openapi.json": v1.GET_OPENAPI,
  "GET /api/v1/bot": v1.GET_BOT,
  "POST /mcp": mcp.POST,
  "GET /mcp": mcp.GET,
  "DELETE /mcp": mcp.DELETE,
  "OPTIONS /mcp": mcp.OPTIONS,
};

/**
 * Everything but the gateway's own routes is public data or a public API that
 * any origin may call from a browser: its refusals carry CORS too, so the
 * caller can read them. They hold a message and a code, nothing else.
 */
const isPublicApi = (pathname: string) =>
  !(pathname.startsWith("/api/auth/") || pathname.startsWith("/api/gateway/") || pathname.startsWith("/api/admin/"));

function refuse(status: number, error: string, code: string, pathname: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(isPublicApi(pathname) ? { "Access-Control-Allow-Origin": "*" } : {}),
      ...headers,
    },
  });
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // The HITZ Terminal has its own router (api/terminal.ts, _lib/terminal/routes.ts).
  if (url.pathname.startsWith("/api/terminal/")) return terminal.handle(request, env, ctx);

  const handler = ROUTES[`${request.method} ${url.pathname}`];
  // The public API answers browsers from any origin: preflights and 404s carry CORS.
  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    if (request.method === "OPTIONS") return v1.OPTIONS();
    if (!handler) return v1.notFound();
  }
  if (!handler) return refuse(404, "not found", "not_found", url.pathname);
  return handler(request, env, ctx);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Only /api/* is ours. Anything else is a static asset — defer to the
    // assets binding. In practice this branch rarely runs because
    // `run_worker_first = ["/api/*"]` keeps non-API traffic on the assets
    // side, but it's the correct fallback if that config ever drifts.
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
      return env.ASSETS.fetch(request);
    }

    // Preflights are answered without counting: a browser sends them on its own.
    if (request.method !== "OPTIONS") {
      const within = await withinEdgeLimits({ any: env.RL_ANY, costly: env.RL_COSTLY }, clientIp(request), request.method, url.pathname);
      if (!within) {
        return secured(refuse(429, "Too many requests. Slow down and try again in a minute.", "rate_limited", url.pathname, { "Retry-After": "60" }));
      }
    }
    if (declaresOversizeBody(request)) {
      return secured(refuse(413, "The request body is too large.", "body_too_large", url.pathname));
    }

    try {
      return secured(await dispatch(request, env, ctx, url));
    } catch (err) {
      // The cause goes to the Worker's log; the caller gets nothing of its internals.
      console.error("[worker]", request.method, url.pathname, err instanceof Error ? (err.stack ?? err.message) : String(err));
      return secured(refuse(500, "Something went wrong on our side. Try again shortly.", "internal_error", url.pathname));
    }
  },

  // Cron Triggers (wrangler.toml [triggers]): on-chain data ingestion with
  // the sponsor's upkeep, and on its own schedule the next operator job (if
  // one is queued in D1) and the arbitrage bot.
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const logged = (tag: string, work: Promise<unknown>) =>
      work
        .then((report) => report && console.log(tag, JSON.stringify(report)))
        .catch((err) => console.error(tag, "failed:", err instanceof Error ? err.message : String(err)));
    if (controller.cron === ARB_CRON) {
      ctx.waitUntil(logged("[job]", runAdminJob(env)).then(() => logged("[arb]", runArbBot(env))));
      return;
    }
    ctx.waitUntil(
      logged("[ingest]", runIngest(env))
        .then(() => logged("[sponsor]", watchSponsor(env)))
        .then(() => logged("[terminal]", terminal.runTerminalJobs(env)))
    );
  },
};
