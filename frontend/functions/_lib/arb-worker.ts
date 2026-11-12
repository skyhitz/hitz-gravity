// The arbitrage bot (_lib/arb.ts) in the Worker's own cron, "2-59/5 * * * *",
// offset from the ingestion cron so the two never share an invocation.
//
// Configuration (wrangler.toml [vars] and one secret):
//   ARB_BOT_MODE     "off" | "dry-run" | "live"
//   ARB_BOT_ADDRESS  the bot's account (public)
//   ARB_BOT_SECRET   its key, set with `wrangler secret put ARB_BOT_SECRET`;
//                    live mode needs it and refuses a key for another account
//   ARB_BOT_MIN_PROFIT_XLM, ARB_BOT_MAX_TRADE_XLM   optional overrides
//
// This file only hands the Worker's bindings to arb-ops.ts, where the run,
// its log (D1 `arb_runs`, KV `arb:last`), the guards and the public status
// live and are tested. Alerts go by email to SUPPORT_EMAIL.

import { botStatus as status, runBot, type BotDeps, type BotVars } from "./arb-ops.ts";
import { sendMail } from "./email";
import { VAULT_ID } from "./vault-api";
import type { Env } from "./types";

function depsOf(env: Env): BotDeps {
  return {
    db: env.DB,
    kv: env.MAGIC_LINKS,
    notify: async (subject, text) => {
      if (!env.SUPPORT_EMAIL) return;
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
      await sendMail(env, { to: { email: env.SUPPORT_EMAIL }, subject, text, html: `<p>${escaped}</p>` });
    },
  };
}

function varsOf(env: Env): BotVars {
  return {
    mode: env.ARB_BOT_MODE,
    address: env.ARB_BOT_ADDRESS,
    secret: env.ARB_BOT_SECRET,
    rpcUrl: env.RPC_URL,
    horizonUrl: env.HORIZON_URL,
    networkPassphrase: env.NETWORK_PASSPHRASE,
    vault: VAULT_ID,
    hitz: env.HITZ_CONTRACT_ID,
    usdcIssuer: env.USDC_ISSUER,
    minProfitXlm: env.ARB_BOT_MIN_PROFIT_XLM,
    maxTradeXlm: env.ARB_BOT_MAX_TRADE_XLM,
    statusUrl: `${env.APP_URL}/api/v1/bot`,
  };
}

export const runArbBot = (env: Env) => runBot(depsOf(env), varsOf(env));
export const botStatus = (env: Env) => status(depsOf(env), varsOf(env));
