// The HITZ Terminal's API (/api/terminal/*) and its cron work, wired to the real bindings. The logic is
// in _lib/terminal/ (routes.ts for requests, checkout.ts and webhooks.ts for the cron).

import { terminalSecret } from "../_lib/derive";
import { readSession } from "../_lib/session";
import { liveChain } from "../_lib/terminal/chain";
import { reconcileCheckouts } from "../_lib/terminal/checkout";
import { handleTerminal, type Market } from "../_lib/terminal/routes";
import { pruneDeliveries } from "../_lib/terminal/store";
import { deliverAlerts, sendHttp, type Alert } from "../_lib/terminal/webhooks";
import type { Env } from "../_lib/types";

const market = (env: Env) => (env.MARKET ?? null) as Market | null;

async function horizonAccount(env: Env, account: string): Promise<unknown | null> {
  const res = await fetch(`${env.HORIZON_URL}/accounts/${account}`);
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error("Horizon did not answer; try again."), { status: 502, code: "upstream_unavailable" });
  return res.json();
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const m = market(env);
  return handleTerminal(request, {
    db: env.DB,
    market: m,
    chain: () => liveChain(env, m),
    secret: await terminalSecret(env.MASTER_SECRET),
    passphrase: env.NETWORK_PASSPHRASE,
    appUrl: env.APP_URL,
    kv: env.MAGIC_LINKS,
    emailAccount: async (req) => (await readSession(req, env))?.publicKey ?? null,
    horizonAccount: (account) => horizonAccount(env, account),
    send: sendHttp,
    cache: {
      match: async (key) => (await caches.default.match(new Request(key))) ?? undefined,
      put: (key, res) => caches.default.put(new Request(key), res),
    },
    nowMs: Date.now(),
    waitUntil: (p) => ctx.waitUntil(p),
  });
}

/** The cron's terminal work: confirm payments whose page was closed, push alerts, prune. */
export async function runTerminalJobs(env: Env) {
  const m = market(env);
  const now = Date.now();
  const payments = await reconcileCheckouts(env.DB, liveChain(env, m), now);
  let alerts: unknown = "no data binding";
  if (m) {
    alerts = await deliverAlerts({
      db: env.DB,
      alerts: async (fromMs, toMs) => ((await m.terminalAlerts({ fromMs, toMs, limit: 500 })) as { alerts: Alert[] }).alerts,
      send: sendHttp,
      terminalSecret: await terminalSecret(env.MASTER_SECRET),
      nowMs: now,
    });
  }
  await pruneDeliveries(env.DB, now);
  return { payments, alerts };
}
