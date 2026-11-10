// Public, keyless API for trading HITZ through the Sovereign Vault.
//
//   GET  /api/v1                  what's here
//   GET  /api/v1/vault            pools, prices, fees, the Event Horizon
//   GET  /api/v1/quote            ?sell=XLM&buy=HITZ&amount=100 (or &buy_amount=…) [&account=G…]
//   POST /api/v1/swap             {account, sell, buy, amount, slippage_bps?, to?, valid_for?}
//                                 → an unsigned transaction, simulated and ready to sign
//   POST /api/v1/submit           {xdr} → relays a signed vault transaction, waits for the result
//   GET  /api/v1/tx               ?hash=…
//   GET  /api/v1/account          ?address=G…
//   GET  /api/v1/openapi.json
//
// The logic lives in _lib/vault-api.ts, shared with the MCP server (api/mcp.ts).
// Errors are {error, code, …details} with a matching HTTP status.

import { botStatus } from "../_lib/arb-worker";
import { openapi } from "../_lib/openapi";
import {
  ApiError,
  accountSummary,
  buildSwap,
  links,
  quote,
  submitTransaction,
  transactionStatus,
  vaultInfo,
} from "../_lib/vault-api";
import type { Env } from "../_lib/types";

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...headers },
  });
}

export function failure(err: unknown): Response {
  if (err instanceof ApiError) {
    return respond({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status);
  }
  console.error("[api/v1]", err);
  return respond({ error: err instanceof Error ? err.message : String(err), code: "internal_error" }, 500);
}

/** JSON (or form-encoded) request body as an object. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  if ((request.headers.get("Content-Type") ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_body", "Send a JSON object as the request body.");
}

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

type Route = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const route =
  (fn: Route): Route =>
  async (request, env, ctx) => {
    try {
      return await fn(request, env, ctx);
    } catch (err) {
      return failure(err);
    }
  };

/** Successful answers are shared through the colo's cache for `ttl` seconds. */
async function cached(request: Request, ctx: ExecutionContext, ttl: number, produce: () => Promise<unknown>): Promise<Response> {
  const cache = caches.default;
  const key = new Request(request.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = respond(await produce(), 200, { "Cache-Control": `public, max-age=${ttl}` });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export const GET_INDEX = route(async (_request, env) =>
  respond({
    name: "HITZ Sovereign Vault API",
    description:
      "Quotes and ready-to-sign swap transactions for HITZ on Stellar mainnet, through its own exchange, the Sovereign Vault. " +
      "No API key and no account here: you sign with your own wallet.",
    endpoints: {
      "GET /api/v1/vault": "Pools, prices, fees and the Event Horizon.",
      "GET /api/v1/quote?sell=XLM&buy=HITZ&amount=100": "Exact quote. buy_amount= instead of amount= finds the input; account= adds balance and Event Horizon checks.",
      "POST /api/v1/swap": "{account, sell, buy, amount, slippage_bps?} → unsigned, simulated transaction (base64 XDR) for that account to sign.",
      "POST /api/v1/submit": "{xdr} → submits a signed vault transaction and waits for the result.",
      "GET /api/v1/tx?hash=…": "Status of a transaction, with the swap decoded.",
      "GET /api/v1/account?address=G…": "Balances, trustlines and how much HITZ the account can buy before being vaulted.",
      "GET /api/v1/bot": "Our own arbitrage bot: its address, last run, totals and recent trades.",
    },
    links: links(env),
  })
);

export const GET_VAULT = route(async (request, env, ctx) => cached(request, ctx, 10, () => vaultInfo(env)));

export const GET_QUOTE = route(async (request, env, ctx) => cached(request, ctx, 5, () => quote(env, query(request))));

export const POST_SWAP = route(async (request, env) => respond(await buildSwap(env, await readBody(request))));

export const POST_SUBMIT = route(async (request, env) => {
  const body = await readBody(request);
  const result = await submitTransaction(env, body.xdr ?? body.tx);
  return respond(result, result.status === "PENDING" ? 202 : 200);
});

export const GET_TX = route(async (request, env) => respond(await transactionStatus(env, query(request).hash)));

export const GET_ACCOUNT = route(async (request, env) => {
  const q = query(request);
  return respond(await accountSummary(env, q.address ?? q.account));
});

export const GET_OPENAPI = route(async (_request, env) => respond(openapi(env), 200, { "Cache-Control": "public, max-age=3600" }));

/** Our own arbitrage bot: address, mode, last run, totals and recent actions. */
export const GET_BOT = route(async (request, env, ctx) => cached(request, ctx, 30, () => botStatus(env)));

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

export function notFound(): Response {
  return respond({ error: "not found", code: "not_found", see: "/api/v1" }, 404);
}
