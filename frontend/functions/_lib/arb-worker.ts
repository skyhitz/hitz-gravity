// The arbitrage bot (_lib/arb.ts) in the Worker's own cron, "2-59/5 * * * *",
// offset from the ingestion cron so the two never share an invocation.
//
// Configuration (wrangler.toml [vars] and one secret):
//   ARB_BOT_MODE     "off" | "dry-run" | "live"
//   ARB_BOT_ADDRESS  the bot's account (public)
//   ARB_BOT_SECRET   its key, set with `wrangler secret put ARB_BOT_SECRET`;
//                    live mode needs it and refuses a key for another account
//
// Every action lands in D1 (`arb_runs`), the last run in KV (`arb:last`). Two
// guards stop a run of bad luck from compounding: a 24-hour pause after a
// realized loss, repeated unhedged trades, or an hour of failing runs; and an
// email to SUPPORT_EMAIL (once a day per kind) for those and for low funds.

import * as StellarSdk from "@stellar/stellar-sdk";
import { DEFAULTS, runOnce, type ArbReport } from "./arb.ts";
import { sendMail } from "./email";
import { VAULT_ID } from "./vault-api";
import type { Env } from "./types";

const LAST_KEY = "arb:last";
const PAUSE_KEY = "arb:paused";
const ERRORS_KEY = "arb:errors";
const DAY_S = 86_400;

/** Pause when the last 24 hours of hedged trades lost more than this, in XLM. */
const LOSS_LIMIT_XLM = -2;
/** ...or this many trades went unhedged in 24 hours. */
const UNHEDGED_LIMIT = 3;
/** ...or this many runs in a row failed (an hour at one run per 5 minutes). */
const ERROR_STREAK_LIMIT = 12;
/** Low-funds alert thresholds (spendable). */
const LOW_XLM = 30;
const LOW_USDC = 5;

export function botAddress(env: Env): string | null {
  const address = (env.ARB_BOT_ADDRESS ?? "").trim();
  return StellarSdk.StrKey.isValidEd25519PublicKey(address) ? address : null;
}

function numberVar(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function runArbBot(env: Env): Promise<Record<string, unknown>> {
  const mode = (env.ARB_BOT_MODE ?? "off").trim().toLowerCase();
  const address = botAddress(env);
  if (mode === "off" || !address) return { skipped: mode === "off" ? "ARB_BOT_MODE is off" : "no valid ARB_BOT_ADDRESS" };
  const paused = await env.MAGIC_LINKS.get(PAUSE_KEY);
  if (paused) return { skipped: `paused: ${paused}` };

  // Live needs the bot's own key; without it the run stays a dry run.
  let keypair: StellarSdk.Keypair | undefined;
  let note: string | undefined;
  if (mode === "live") {
    if (!env.ARB_BOT_SECRET) {
      note = "live mode, but ARB_BOT_SECRET isn't set: dry run";
    } else {
      try {
        keypair = StellarSdk.Keypair.fromSecret(env.ARB_BOT_SECRET.trim());
      } catch {
        note = "ARB_BOT_SECRET isn't a valid secret key: dry run";
      }
      if (keypair && keypair.publicKey() !== address) {
        keypair = undefined;
        note = "ARB_BOT_SECRET belongs to another account than ARB_BOT_ADDRESS: dry run";
        await alert(env, "key", "Arbitrage bot: key mismatch", `${note}. The bot isn't trading.`);
      }
    }
  }

  const report = await runOnce({
    rpcUrl: env.RPC_URL,
    horizonUrl: env.HORIZON_URL.replace(/\/$/, ""),
    networkPassphrase: env.NETWORK_PASSPHRASE,
    vault: VAULT_ID,
    hitz: env.HITZ_CONTRACT_ID,
    usdcIssuer: env.USDC_ISSUER,
    address,
    keypair,
    live: keypair !== undefined,
    minProfitXlm: numberVar(env.ARB_BOT_MIN_PROFIT_XLM, DEFAULTS.minProfitXlm),
    minProfitBps: DEFAULTS.minProfitBps,
    maxTradeXlm: numberVar(env.ARB_BOT_MAX_TRADE_XLM, DEFAULTS.maxTradeXlm),
    feeBufferXlm: DEFAULTS.feeBufferXlm,
    slippageBps: DEFAULTS.slippageBps,
  });
  if (note) report.reason = report.reason ? `${note}; ${report.reason}` : note;

  await record(env, report);
  await guard(env, report);
  return {
    action: report.action,
    mode: report.mode,
    gapPct: report.gapPct,
    reason: report.reason,
    error: report.error,
    profitXlm: report.profitXlm,
    vaultTx: report.vaultLeg?.hash,
    hedgeTx: report.hedgeLeg?.hash,
  };
}

/** KV keeps the last run; D1 keeps every action (a repeated error or skip only once). */
async function record(env: Env, report: ArbReport): Promise<void> {
  const previous = await env.MAGIC_LINKS.get(LAST_KEY, { type: "json" }) as ArbReport | null;
  await env.MAGIC_LINKS.put(LAST_KEY, JSON.stringify(report));
  if (report.action === "none") return;
  const repeated =
    (report.action === "error" || report.action === "skip") &&
    previous?.action === report.action &&
    (previous.error ?? previous.reason) === (report.error ?? report.reason);
  if (repeated) return;
  await env.DB.prepare(
    `INSERT INTO arb_runs (at, mode, action, sell, amount_in, vault_out, hedge_out, profit_xlm, gap_pct, vault_tx, hedge_tx, report)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  )
    .bind(
      report.at,
      report.mode,
      report.action,
      report.plan?.sell ?? null,
      report.plan?.amountIn ?? null,
      report.vaultLeg?.received ?? report.plan?.vaultOut ?? null,
      report.hedgeLeg?.received ?? report.plan?.hedgeOut ?? null,
      report.profitXlm ?? report.plan?.profitXlm ?? null,
      report.gapPct ?? null,
      report.vaultLeg?.hash ?? null,
      report.hedgeLeg?.hash ?? null,
      JSON.stringify(report)
    )
    .run();
}

async function pause(env: Env, reason: string): Promise<void> {
  await env.MAGIC_LINKS.put(PAUSE_KEY, `${reason} (since ${new Date().toISOString()})`, { expirationTtl: DAY_S });
  await alert(env, "pause", "Arbitrage bot paused for 24 hours", `${reason}. It resumes on its own after 24 hours.`);
}

async function guard(env: Env, report: ArbReport): Promise<void> {
  // Failing runs in a row.
  const streak = report.action === "error" ? Number((await env.MAGIC_LINKS.get(ERRORS_KEY)) ?? "0") + 1 : 0;
  await env.MAGIC_LINKS.put(ERRORS_KEY, String(streak));
  if (report.mode === "live" && streak >= ERROR_STREAK_LIMIT) {
    await env.MAGIC_LINKS.put(ERRORS_KEY, "0");
    await pause(env, `${streak} runs in a row failed; last error: ${report.error}`);
    return;
  }
  if (report.mode !== "live") return;

  // Losses and unhedged trades over the last 24 hours.
  if (report.action === "trade" || report.action === "trade-unhedged") {
    const since = new Date(Date.now() - DAY_S * 1000).toISOString();
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN action = 'trade' THEN profit_xlm END), 0) AS pnl,
              SUM(CASE WHEN action = 'trade-unhedged' THEN 1 ELSE 0 END) AS unhedged
       FROM arb_runs WHERE mode = 'live' AND at >= ?1`
    )
      .bind(since)
      .first<{ pnl: number; unhedged: number }>();
    if (row && row.pnl < LOSS_LIMIT_XLM) await pause(env, `realized ${row.pnl.toFixed(4)} XLM over 24 hours`);
    else if (row && row.unhedged >= UNHEDGED_LIMIT) await pause(env, `${row.unhedged} trades went unhedged in 24 hours`);
  }

  // Low funds.
  const xlm = Number(report.balances?.xlm ?? NaN);
  const usdc = Number(report.balances?.usdc ?? NaN);
  if ((Number.isFinite(xlm) && xlm < LOW_XLM) || (Number.isFinite(usdc) && usdc < LOW_USDC)) {
    await alert(
      env,
      "funds",
      "Arbitrage bot: low funds",
      `The bot ${report.address} can spend ${report.balances?.xlm} XLM and ${report.balances?.usdc} USDC. Top it up to keep it trading.`
    );
  }
}

/** One email per kind per day to SUPPORT_EMAIL; failures are logged, never thrown. */
async function alert(env: Env, kind: string, subject: string, text: string): Promise<void> {
  if (!env.SUPPORT_EMAIL) return;
  const key = `arb:alert:${kind}`;
  if (await env.MAGIC_LINKS.get(key)) return;
  await env.MAGIC_LINKS.put(key, "1", { expirationTtl: DAY_S });
  const status = `${env.APP_URL}/api/v1/bot`;
  try {
    await sendMail(env, {
      to: { email: env.SUPPORT_EMAIL },
      subject,
      text: `${text}\n\nStatus: ${status}`,
      html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p>Status: <a href="${status}">${status}</a></p>`,
    });
  } catch (err) {
    console.error(`[arb] alert email failed: ${err instanceof Error ? err.message : String(err)}`);
    await env.MAGIC_LINKS.delete(key).catch(() => {});
  }
}

// ─── Public status (GET /api/v1/bot) ─────────────────────────────────────────

interface Row {
  at: string;
  mode: string;
  action: string;
  sell: string | null;
  amount_in: string | null;
  vault_out: string | null;
  hedge_out: string | null;
  profit_xlm: number | null;
  gap_pct: number | null;
  vault_tx: string | null;
  hedge_tx: string | null;
}

export async function botStatus(env: Env) {
  const address = botAddress(env);
  const configured = (env.ARB_BOT_MODE ?? "off").trim().toLowerCase();
  const mode = !address || configured === "off" ? "off" : configured === "live" && env.ARB_BOT_SECRET ? "live" : "dry-run";
  const windows: [string, number | null][] = [["24h", DAY_S], ["7d", 7 * DAY_S], ["all", null]];
  const [last, paused, recent, ...totals] = await Promise.all([
    env.MAGIC_LINKS.get(LAST_KEY, { type: "json" }) as Promise<ArbReport | null>,
    env.MAGIC_LINKS.get(PAUSE_KEY),
    env.DB.prepare(
      `SELECT at, mode, action, sell, amount_in, vault_out, hedge_out, profit_xlm, gap_pct, vault_tx, hedge_tx
       FROM arb_runs ORDER BY id DESC LIMIT 20`
    ).all<Row>(),
    ...windows.map(([, seconds]) =>
      env.DB.prepare(
        `SELECT COUNT(*) AS trades, COALESCE(SUM(profit_xlm), 0) AS profit_xlm
         FROM arb_runs WHERE mode = 'live' AND action = 'trade' AND at >= ?1`
      )
        .bind(seconds === null ? "" : new Date(Date.now() - seconds * 1000).toISOString())
        .first<{ trades: number; profit_xlm: number }>()
    ),
  ]);
  const tx = (hash: string | null) => (hash ? `https://stellar.expert/explorer/public/tx/${hash}` : null);
  return {
    name: "Skyhitz arbitrage bot",
    address,
    explorer: address ? `https://stellar.expert/explorer/public/account/${address}` : null,
    mode,
    paused: paused ?? null,
    strategy:
      "Trades the HITZ Sovereign Vault's XLM/USDC rate back to the Stellar DEX: when the vault pays more for XLM than the DEX, " +
      "it sells XLM for USDC in the vault and buys the XLM back on the DEX (and the mirror image), never for less than it sold. " +
      "Own funds, the same fees as everyone.",
    source: "https://github.com/skyhitz/hitz-gravity/blob/main/frontend/functions/_lib/arb.ts",
    docs: "https://docs.skyhitz.io/vault/arbitrage-bot",
    last_run: last
      ? {
          at: last.at,
          action: last.action,
          reason: last.reason ?? null,
          error: last.error ?? null,
          gap_pct: last.gapPct ?? null,
          vault_rate: last.vaultRate ?? null,
          sdex: last.market ?? null,
          balances: last.balances ?? null,
        }
      : null,
    totals: Object.fromEntries(
      windows.map(([name], i) => [name, { trades: totals[i]?.trades ?? 0, profit_xlm: Number((totals[i]?.profit_xlm ?? 0).toFixed(7)) }])
    ),
    recent: (recent.results ?? []).map((r) => ({
      ...r,
      vault_tx: tx(r.vault_tx),
      hedge_tx: tx(r.hedge_tx),
    })),
  };
}
