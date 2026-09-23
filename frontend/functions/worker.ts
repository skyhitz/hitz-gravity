// Workers entrypoint. Replaces the Pages Functions auto-routing with an
// explicit dispatch table so we can use bindings Pages doesn't support
// (notably `send_email`). Static assets in out/ are served by the
// [assets] binding; this Worker only runs for /api/* paths (see
// `run_worker_first` in wrangler.toml).
//
// Keeping the router as a plain object lookup — one line per endpoint,
// O(1) dispatch, trivial to scan. No framework: 8 routes doesn't need
// Hono/itty-router.

import { POST as authLogin } from "./api/auth/login";
import { POST as authLogout } from "./api/auth/logout";
import { GET as authMe } from "./api/auth/me";
import { GET as authVerify } from "./api/auth/verify";
import { POST as adminLegacyReparation } from "./api/admin/legacy-reparation";
import { GET as gatewayBalances } from "./api/gateway/balances";
import { POST as gatewayBootstrap } from "./api/gateway/bootstrap";
import { POST as gatewayEnsureTrustline } from "./api/gateway/ensure-trustline";
import { POST as gatewayExecute } from "./api/gateway/execute";
import { POST as gatewayNotify } from "./api/gateway/notify";
import { POST as gatewayResolve } from "./api/gateway/resolve";
import { GET as gatewaySponsor } from "./api/gateway/sponsor";
import { GET as holders } from "./api/holders";
import { GET_CONTRACT_INFO, GET_EVENTS, GET_STATUS, GET_TX_INFO } from "./api/data";
import { GET_LIQUIDITY, GET_PRICE_HISTORY, GET_TRACTION } from "./api/snapshots";
import { runIngest } from "./_lib/ingest";
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
  "GET /api/auth/verify": authVerify,
  "POST /api/admin/legacy-reparation": adminLegacyReparation,
  "GET /api/gateway/balances": gatewayBalances,
  "POST /api/gateway/bootstrap": gatewayBootstrap,
  "POST /api/gateway/ensure-trustline": gatewayEnsureTrustline,
  "POST /api/gateway/execute": gatewayExecute,
  "POST /api/gateway/notify": gatewayNotify,
  "POST /api/gateway/resolve": gatewayResolve,
  "GET /api/gateway/sponsor": gatewaySponsor,
  "GET /api/holders": holders,
  "GET /api/data/events": GET_EVENTS,
  "GET /api/data/tx-info": GET_TX_INFO,
  "GET /api/data/contract-info": GET_CONTRACT_INFO,
  "GET /api/data/status": GET_STATUS,
  "GET /api/price/history": GET_PRICE_HISTORY,
  "GET /api/liquidity": GET_LIQUIDITY,
  "GET /api/traction": GET_TRACTION,
};

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
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handler(request, env, ctx);
  },

  // Cron Trigger (wrangler.toml [triggers]) — on-chain data ingestion.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      runIngest(env).then((report) => console.log("[ingest]", JSON.stringify(report)))
    );
  },
};
