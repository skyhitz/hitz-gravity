// One cron run of the arbitrage bot (arb.ts) and what surrounds the strategy:
// the mode and key checks, the D1 log, the last run in KV, the guards that
// pause it, the operator's alerts and the public status.
//
// Everything it touches comes in as an argument (the database, the KV
// namespace, a way to tell the operator, the network), so the whole run is
// tested in Node against a simulated network (tests/arb-ops.test.mjs).
// arb-worker.ts hands it the Worker's bindings.
//
// Every action lands in D1 (`arb_runs`), the last run in KV (`arb:last`). The
// guards stop bad luck from compounding: a 24-hour pause after three round
// trips in a day stopped halfway, a realized loss, or an hour of failing
// runs; and a message to the operator (once a day per kind) for those, for
// low funds and for a key that isn't the account's.

import * as StellarSdk from "@stellar/stellar-sdk";
import { DEFAULTS, runOnce, type ArbReport, type Io } from "./arb.ts";

export interface BotVars {
  /** "off" | "dry-run" | "live" (anything else runs dry). */
  mode?: string;
  /** The bot's account (public). */
  address?: string;
  /** Its key. Live mode needs it and refuses a key for another account. */
  secret?: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  vault: string;
  hitz: string;
  usdcIssuer: string;
  /** Optional overrides of the bot's defaults (numbers as strings). */
  minProfitXlm?: string;
  maxTradeXlm?: string;
  /** Where the public status lives, for the operator's alerts. */
  statusUrl: string;
}

export interface BotDeps {
  db: D1Database;
  kv: KVNamespace;
  /** Tell the operator. Throws when it couldn't, so the alert is tried again. */
  notify: (subject: string, text: string) => Promise<void>;
  /** The network and the clock; the Worker's own when absent. */
  io?: Partial<Io>;
}

const LAST_KEY = "arb:last";
const PAUSE_KEY = "arb:paused";
const ERRORS_KEY = "arb:errors";
const DAY_S = 86_400;

/** Pause when the last 24 hours of finished trades lost more than this, in XLM. */
const LOSS_LIMIT_XLM = -2;
/** ...or this many round trips stopped after their first leg in 24 hours. */
const INCOMPLETE_LIMIT = 3;
/** ...or this many runs in a row failed (an hour at one run per 5 minutes). */
const ERROR_STREAK_LIMIT = 12;
/** Low-funds alert thresholds (spendable). */
const LOW_XLM = 30;
const LOW_USDC = 5;

export function botAddress(value: string | undefined): string | null {
  const address = (value ?? "").trim();
  return StellarSdk.StrKey.isValidEd25519PublicKey(address) ? address : null;
}

function numberVar(value: string | undefined, fallback: number, atLeast: number): number {
  const n = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= atLeast ? n : fallback;
}

function settingsOf(vars: BotVars) {
  const maxTradeXlm = numberVar(vars.maxTradeXlm, DEFAULTS.maxTradeXlm, 0);
  return {
    minProfitXlm: numberVar(vars.minProfitXlm, DEFAULTS.minProfitXlm, 0),
    minProfitBps: DEFAULTS.minProfitBps,
    maxTradeXlm: maxTradeXlm > 0 ? maxTradeXlm : DEFAULTS.maxTradeXlm,
    feeBufferXlm: DEFAULTS.feeBufferXlm,
  };
}

const modeOf = (vars: BotVars) => (vars.mode ?? "off").trim().toLowerCase();

/** The key live mode signs with: the account's own, or none and the reason why. The key itself is never reported. */
function keyFor(vars: BotVars, address: string): { keypair?: StellarSdk.Keypair; note?: string; mismatch?: boolean } {
  if (!vars.secret) return { note: "live mode, but ARB_BOT_SECRET isn't set: dry run" };
  let keypair: StellarSdk.Keypair;
  try {
    keypair = StellarSdk.Keypair.fromSecret(vars.secret.trim());
  } catch {
    return { note: "ARB_BOT_SECRET isn't a valid secret key: dry run" };
  }
  if (keypair.publicKey() !== address) return { note: "ARB_BOT_SECRET belongs to another account than ARB_BOT_ADDRESS: dry run", mismatch: true };
  return { keypair };
}
const nowMs = (deps: BotDeps) => deps.io?.now?.() ?? Date.now();

export async function runBot(deps: BotDeps, vars: BotVars): Promise<Record<string, unknown>> {
  const mode = modeOf(vars);
  const address = botAddress(vars.address);
  if (mode === "off" || !address) return { skipped: mode === "off" ? "ARB_BOT_MODE is off" : "no valid ARB_BOT_ADDRESS" };
  const paused = await deps.kv.get(PAUSE_KEY);
  if (paused) return { skipped: `paused: ${paused}` };

  // Live needs the bot's own key; without it the run stays a dry run.
  const { keypair, note, mismatch } = mode === "live" ? keyFor(vars, address) : ({} as ReturnType<typeof keyFor>);
  if (mismatch) await alertOnce(deps, vars, "key", "Arbitrage bot: key mismatch", `${note}. The bot isn't trading.`);

  const report = await runOnce({
    rpcUrl: vars.rpcUrl,
    horizonUrl: vars.horizonUrl.replace(/\/$/, ""),
    networkPassphrase: vars.networkPassphrase,
    vault: vars.vault,
    hitz: vars.hitz,
    usdcIssuer: vars.usdcIssuer,
    address,
    keypair,
    live: keypair !== undefined,
    ...settingsOf(vars),
    io: deps.io,
  });
  if (note) report.reason = report.reason ? `${note}; ${report.reason}` : note;

  await record(deps, report);
  await guard(deps, vars, report);
  return {
    action: report.action,
    mode: report.mode,
    gapPct: report.gapPct,
    reason: report.reason,
    error: report.error,
    profitXlm: report.profitXlm,
    hedgeTx: report.hedgeLeg?.hash,
    vaultTx: report.vaultLeg?.hash,
  };
}

/** KV keeps the last run; D1 keeps every action (a repeated error or skip only once). */
async function record(deps: BotDeps, report: ArbReport): Promise<void> {
  const previous = (await deps.kv.get(LAST_KEY, { type: "json" })) as ArbReport | null;
  await deps.kv.put(LAST_KEY, JSON.stringify(report));
  if (report.action === "none") return;
  const repeated =
    (report.action === "error" || report.action === "skip") &&
    previous?.action === report.action &&
    (previous.error ?? previous.reason) === (report.error ?? report.reason);
  if (repeated) return;
  // A profit is logged when it happened, or as the plan of a dry run: never for a leg that failed.
  const profit = report.profitXlm ?? (report.action === "would-trade" ? report.plan?.profitXlm : undefined);
  await deps.db
    .prepare(
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
      profit ?? null,
      report.gapPct ?? null,
      report.vaultLeg?.hash ?? null,
      report.hedgeLeg?.hash ?? report.setupLeg?.hash ?? null,
      JSON.stringify(report)
    )
    .run();
}

async function pause(deps: BotDeps, vars: BotVars, reason: string): Promise<void> {
  await deps.kv.put(PAUSE_KEY, `${reason} (since ${new Date(nowMs(deps)).toISOString()})`, { expirationTtl: DAY_S });
  await alertOnce(deps, vars, "pause", "Arbitrage bot paused for 24 hours", `${reason}. It resumes on its own after 24 hours.`);
}

async function guard(deps: BotDeps, vars: BotVars, report: ArbReport): Promise<void> {
  // Failing runs in a row.
  const before = Number((await deps.kv.get(ERRORS_KEY)) ?? "0");
  const streak = report.action === "error" ? before + 1 : 0;
  const tripped = report.mode === "live" && streak >= ERROR_STREAK_LIMIT;
  if (streak !== before || tripped) await deps.kv.put(ERRORS_KEY, String(tripped ? 0 : streak));
  if (tripped) {
    await pause(deps, vars, `${streak} runs in a row failed; last error: ${report.error}`);
    return;
  }
  if (report.mode !== "live") return;

  // Losses and round trips stopped halfway over the last 24 hours.
  if (report.action === "trade" || report.action === "trade-incomplete") {
    const since = new Date(nowMs(deps) - DAY_S * 1000).toISOString();
    const row = await deps.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN action = 'trade' THEN profit_xlm END), 0) AS pnl,
                COALESCE(SUM(CASE WHEN action = 'trade-incomplete' THEN 1 ELSE 0 END), 0) AS incomplete
         FROM arb_runs WHERE mode = 'live' AND at >= ?1`
      )
      .bind(since)
      .first<{ pnl: number; incomplete: number }>();
    if (row && row.pnl < LOSS_LIMIT_XLM) await pause(deps, vars, `realized ${row.pnl.toFixed(4)} XLM over 24 hours`);
    else if (row && row.incomplete >= INCOMPLETE_LIMIT) await pause(deps, vars, `${row.incomplete} round trips stopped halfway in 24 hours`);
  }

  // Low funds.
  const xlm = Number(report.balances?.xlm ?? NaN);
  const usdc = Number(report.balances?.usdc ?? NaN);
  if ((Number.isFinite(xlm) && xlm < LOW_XLM) || (Number.isFinite(usdc) && usdc < LOW_USDC)) {
    await alertOnce(
      deps,
      vars,
      "funds",
      "Arbitrage bot: low funds",
      `The bot ${report.address} can spend ${report.balances?.xlm} XLM and ${report.balances?.usdc} USDC. Top it up to keep it trading.`
    );
  }
}

/** One message per kind per day; failures are logged, never thrown, and tried again on the next run. */
async function alertOnce(deps: BotDeps, vars: BotVars, kind: string, subject: string, text: string): Promise<void> {
  const key = `arb:alert:${kind}`;
  if (await deps.kv.get(key)) return;
  await deps.kv.put(key, "1", { expirationTtl: DAY_S });
  try {
    await deps.notify(subject, `${text}\n\nStatus: ${vars.statusUrl}`);
  } catch (err) {
    console.error(`[arb] alert failed: ${err instanceof Error ? err.message : String(err)}`);
    await deps.kv.delete(key).catch(() => {});
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

export async function botStatus(deps: BotDeps, vars: BotVars) {
  const address = botAddress(vars.address);
  const configured = modeOf(vars);
  const mode = !address || configured === "off" ? "off" : configured === "live" && keyFor(vars, address).keypair ? "live" : "dry-run";
  const settings = settingsOf(vars);
  const now = nowMs(deps);
  const windows: [string, number | null][] = [["24h", DAY_S], ["7d", 7 * DAY_S], ["all", null]];
  const [last, paused, recent, ...totals] = await Promise.all([
    deps.kv.get(LAST_KEY, { type: "json" }) as Promise<ArbReport | null>,
    deps.kv.get(PAUSE_KEY),
    deps.db
      .prepare(
        `SELECT at, mode, action, sell, amount_in, vault_out, hedge_out, profit_xlm, gap_pct, vault_tx, hedge_tx
         FROM arb_runs ORDER BY id DESC LIMIT 20`
      )
      .all<Row>(),
    ...windows.map(([, seconds]) =>
      deps.db
        .prepare(
          `SELECT COUNT(*) AS trades, COALESCE(SUM(profit_xlm), 0) AS profit_xlm
           FROM arb_runs WHERE mode = 'live' AND action = 'trade' AND at >= ?1`
        )
        .bind(seconds === null ? "" : new Date(now - seconds * 1000).toISOString())
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
      "it buys XLM on the DEX and sells it into the vault for the USDC it spent (and the mirror image). The DEX leg goes first and " +
      "must return more than the vault leg sells; the vault leg must pay back what the DEX leg spent. Own funds, the same fees as everyone.",
    source: "https://github.com/skyhitz/hitz-gravity/blob/main/frontend/functions/_lib/arb.ts",
    docs: "https://docs.skyhitz.io/vault/arbitrage-bot",
    settings: { min_profit_xlm: settings.minProfitXlm, min_profit_bps: settings.minProfitBps, max_trade_xlm: settings.maxTradeXlm },
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
