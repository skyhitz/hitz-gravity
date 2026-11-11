// Upkeep of the gas sponsor, run by the cron (worker.ts):
//
//   watchSponsor   the low-funds alert (on spendable XLM), an alert when new
//                  email accounts or an overall rate limit pile up, and
//                  pruning of old rate counters;
//   runAdminJob    the next operator job from D1 `admin_jobs` (admin-jobs.ts).
//
// Job types:
//   {"type":"recovery-plan"}            what a recovery run would do; sends nothing
//   {"type":"recovery-run","limit":N}   revoke the sponsorship of up to N (≤ 99)
//                                       accounts that were never used and pay
//                                       the XLM that frees to the HITZ admin,
//                                       in one transaction (recovery.ts)
//
// The payment's destination is read from the HITZ contract (`admin()`), never
// from the job, so a job can't send the sponsor's XLM anywhere else.

import * as StellarSdk from "@stellar/stellar-sdk";
import { runNextJob, type JobHandler, type JobOutcome } from "./admin-jobs.ts";
import { getServerKeys } from "./derive";
import { sendMail } from "./email";
import { newAccountsSince } from "./gateway-accounts.ts";
import { EXECUTE_PER_DAY, LOGIN_EMAILS_PER_HOUR, NEW_ACCOUNTS_PER_DAY, NOTIFY_EMAILS_PER_HOUR } from "./limits.ts";
import { pruneRateCounters } from "./rate-limit.ts";
import { RECOVERY_RANGE, planRecovery, runRecovery, type RecoveryConfig } from "./recovery.ts";
import { maybeAlertLowBalance } from "./reparation";
import { simulateView } from "./stellar";
import type { Env } from "./types";

const DAY_S = 86_400;

/** New email accounts in 24 hours that deserve a look. Ordinary use opens a few a week. */
const NEW_ACCOUNTS_ALERT = 15;

/** The overall rate limits (limits.ts): [bucket as stored, window seconds, limit, what is refused when it is full]. */
function overallLimits(env: Env): [string, number, number, string][] {
  const accounts = Number(env.GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY ?? "");
  return [
    ["login:all|3600", 3600, LOGIN_EMAILS_PER_HOUR, "sign-in emails"],
    ["notify:all|3600", 3600, NOTIFY_EMAILS_PER_HOUR, "claim emails"],
    ["execute:all|86400", DAY_S, EXECUTE_PER_DAY, "sponsored transactions"],
    ["create:all|86400", DAY_S, Number.isFinite(accounts) && env.GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY ? accounts : NEW_ACCOUNTS_PER_DAY, "new email accounts"],
  ];
}

/** One email per kind per day to SUPPORT_EMAIL; failures are logged, never thrown. */
async function alertOnce(env: Env, kind: string, subject: string, text: string): Promise<void> {
  if (!env.SUPPORT_EMAIL) return;
  const key = `alert:${kind}`;
  if (await env.MAGIC_LINKS.get(key)) return;
  await env.MAGIC_LINKS.put(key, "1", { expirationTtl: DAY_S });
  try {
    await sendMail(env, {
      to: { email: env.SUPPORT_EMAIL },
      subject,
      text,
      html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`,
    });
  } catch (err) {
    console.error(`[sponsor] alert email failed: ${err instanceof Error ? err.message : String(err)}`);
    await env.MAGIC_LINKS.delete(key).catch(() => {});
  }
}

export async function watchSponsor(env: Env): Promise<Record<string, unknown>> {
  await maybeAlertLowBalance(env);
  await pruneRateCounters(env.DB);

  const now = Math.floor(Date.now() / 1000);
  const created = await newAccountsSince(env.DB, new Date((now - DAY_S) * 1000));
  if (created >= NEW_ACCOUNTS_ALERT) {
    await alertOnce(
      env,
      "accounts",
      `[HITZ] ${created} new email accounts in 24 hours`,
      `The gateway created ${created} email accounts in the last 24 hours. Each locks 1 XLM of the sponsor's balance ` +
        `(1.5 with a USDC trustline). If this isn't a campaign of yours, look at D1 gateway_accounts and consider ` +
        `lowering GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY.`
    );
  }

  const full: string[] = [];
  for (const [bucket, window, limit, what] of overallLimits(env)) {
    const row = await env.DB.prepare("SELECT n FROM rate_counters WHERE bucket = ?1 AND win = ?2")
      .bind(bucket, now - (now % window))
      .first<{ n: number }>();
    if (limit > 0 && Number(row?.n ?? 0) >= limit) full.push(what);
  }
  if (full.length) {
    await alertOnce(
      env,
      "limits",
      `[HITZ] Gateway limit reached: ${full.join(", ")}`,
      `The gateway reached its overall limit for ${full.join(" and ")}. Further requests are refused until the window ends. ` +
        `That is either abuse or real growth: the limits are in frontend/functions/_lib/limits.ts.`
    );
  }
  return { newAccounts24h: created, limitsReached: full };
}

function jobHandlers(env: Env): Record<string, JobHandler> {
  const config = async (): Promise<RecoveryConfig> => ({
    horizonUrl: env.HORIZON_URL.replace(/\/$/, ""),
    rpcUrl: env.RPC_URL,
    networkPassphrase: env.NETWORK_PASSPHRASE,
    sponsor: (await getServerKeys(env.MASTER_SECRET)).sponsorKeypair.publicKey(),
    ...RECOVERY_RANGE,
  });
  return {
    "recovery-plan": async () => {
      const plan = await planRecovery(await config(), env.DB);
      return {
        sponsored: plan.sponsored,
        eligible: plan.eligible.length,
        recoverableXlm: plan.recoverableXlm,
        skipped: plan.skipped,
        first: plan.eligible.slice(0, 3),
      };
    },
    "recovery-run": async (command) => {
      const limit = Number(command.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('recovery-run needs a "limit" of 1 or more');
      const admin = await simulateView(env, env.HITZ_CONTRACT_ID, "admin");
      if (typeof admin !== "string" || !StellarSdk.StrKey.isValidEd25519PublicKey(admin)) {
        throw new Error("the HITZ contract has no admin account to pay");
      }
      const { sponsorKeypair } = await getServerKeys(env.MASTER_SECRET);
      return runRecovery(await config(), env.DB, { signer: sponsorKeypair, admin, limit });
    },
  };
}

/** Run the next operator job, if one is queued. */
export function runAdminJob(env: Env): Promise<JobOutcome | null> {
  return runNextJob(env.DB, jobHandlers(env));
}
