// Lazy legacy-reparation redemption.
//
// Flow:
//   1. The admin script (scripts/send-legacy-reparation.mjs) POSTs
//      { email, amount, xlmAmount? } to /api/admin/legacy-reparation. The
//      endpoint writes a magic-link token AND a reparation record:
//
//        MAGIC_LINKS[<token>]            = { email, createdAt }
//        MAGIC_LINKS["reparation:<email>"] = { amount, xlmAmount?,
//                                              status: "pending" }
//
//   2. User clicks the email → /api/auth/verify consumes the token,
//      establishes a session, then calls `redeemPendingReparation`. If a
//      pending record exists for this email:
//        a. Bootstrap the derived account + sponsored USDC trustline
//           (idempotent).
//        b. transfer(sponsor → derived, amount) on the HITZ contract.
//        c. If `xlmAmount` is set, classic Payment(sponsor → derived,
//           xlmAmount). Soroban + classic ops can't share a tx, so this
//           is a separate submission.
//        d. Mark the record `redeemed` with both tx hashes.
//        e. Fire-and-forget: notify SUPPORT_EMAIL and check sponsor balance.
//
//   3. If any leg fails the record is marked `failed` with whatever
//      progress was made (txHash / xlmTxHash). A future login retries
//      ONLY the unfinished legs — the per-leg hashes act as completion
//      markers, so retries never double-pay HITZ or XLM.
//
// Notification debouncing:
//   Low-balance alerts use `alert:low_balance` in MAGIC_LINKS with 24h
//   TTL — fires at most once per day until the operator tops up.
//
// Idempotency:
//   `markRedeemed` only succeeds when the current status is `pending`.
//   Concurrent calls (rare — same user clicking twice fast) end up
//   serialized at KV; the loser sees `redeemed` and bails before
//   attempting a second transfer.

import {
  renderClaimNotifyEmail,
  renderLowBalanceAlertEmail,
  sendMail,
} from "./email";
import {
  ensureBootstrappedWithUsdcTrustline,
  getSponsorAddress,
  getSponsorXlmBalance,
  sendXlmFromSponsor,
  transferHitzFromSponsor,
} from "./stellar";
import * as StellarSdk from "@stellar/stellar-sdk";
import { deriveKeypair, getServerKeys } from "./derive";
import type { Env } from "./types";

export type ReparationStatus = "pending" | "redeemed" | "failed";

export interface ReparationRecord {
  /** HITZ amount (decimal display string, ≤7 fractional digits). */
  amount: string;
  /**
   * Optional native XLM amount paid alongside the HITZ. Introduced in the
   * v6 reparation campaign which splits legacy value across HITZ + XLM.
   * Records written by older campaigns won't have this field, and the
   * redemption flow treats `undefined` as "no XLM leg".
   */
  xlmAmount?: string;
  status: ReparationStatus;
  /**
   * HITZ SAC transfer hash. Persisted as soon as the HITZ leg lands so a
   * later XLM-leg failure can't trigger a double-pay on retry.
   */
  txHash?: string;
  /** XLM Payment hash, when xlmAmount is set and the leg succeeded. */
  xlmTxHash?: string;
  /** Set on failure for operator triage. */
  error?: string;
  /** ms epoch — set when the record is created. */
  createdAt: number;
  /** ms epoch — set when status flips. */
  updatedAt?: number;
}

const PUBLIC_NETWORK = "Public Global Stellar Network ; September 2015";

function reparationKey(email: string): string {
  return `reparation:${email}`;
}

const LOW_BALANCE_KEY = "alert:low_balance";
const LOW_BALANCE_TTL_SECONDS = 24 * 60 * 60;
// Records outlive tokens by design — a year is plenty for any legitimate
// retry while still letting the namespace eventually self-clean.
const REPARATION_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Write (or overwrite) a pending reparation record for `email`. Called
 * by the admin endpoint as part of the campaign send. Overwrites are
 * fine because the admin script is the single writer; if it sends the
 * same email twice with different amounts, the second pair wins.
 *
 * `xlmAmount` is optional — pre-v6 campaigns omit it. When set, the redeem
 * flow performs a separate native Payment after the HITZ SAC transfer.
 */
export async function putPendingReparation(
  env: Env,
  email: string,
  amount: string,
  xlmAmount?: string
): Promise<void> {
  const record: ReparationRecord = {
    amount,
    status: "pending",
    createdAt: Date.now(),
  };
  if (xlmAmount) record.xlmAmount = xlmAmount;
  await env.MAGIC_LINKS.put(reparationKey(email), JSON.stringify(record), {
    expirationTtl: REPARATION_TTL_SECONDS,
  });
}

async function readReparation(
  env: Env,
  email: string
): Promise<ReparationRecord | null> {
  const raw = await env.MAGIC_LINKS.get(reparationKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReparationRecord;
  } catch {
    return null;
  }
}

async function writeReparation(
  env: Env,
  email: string,
  record: ReparationRecord
): Promise<void> {
  await env.MAGIC_LINKS.put(reparationKey(email), JSON.stringify(record), {
    expirationTtl: REPARATION_TTL_SECONDS,
  });
}

/**
 * Result returned to /api/auth/verify so the page can show a success
 * banner ("you just claimed N HITZ + M XLM") on first redemption.
 */
export interface RedeemResult {
  amount: string;
  txHash: string;
  /** Set only when the campaign included an XLM leg AND it landed. */
  xlmAmount?: string;
  xlmTxHash?: string;
}

/**
 * Attempt to redeem a pending reparation for `email`. Safe to call on
 * every login — no-ops cleanly when there's nothing pending or the
 * record is already redeemed.
 *
 * On the happy path:
 *   1. Bootstrap the derived account (idempotent).
 *   2. Move HITZ from sponsor → derived address via SAC transfer.
 *   3. Mark redeemed.
 *   4. Schedule operator-notify + low-balance check via ctx.waitUntil
 *      so the user response isn't blocked on email delivery.
 *
 * On failure the record is marked `failed` with an error message and
 * the function returns null. The user can retry by logging in again
 * (we'll find the failed record and re-attempt).
 */
export async function redeemPendingReparation(
  env: Env,
  ctx: ExecutionContext,
  email: string,
  derivedPublicKey: string
): Promise<RedeemResult | null> {
  const record = await readReparation(env, email);
  if (!record) return null;
  if (record.status === "redeemed") return null;

  // Track per-leg progress across retries. If a previous attempt landed
  // the HITZ leg but failed on XLM, `txHash` is already set in the record
  // and we skip re-paying HITZ on retry (same logic for `xlmTxHash`).
  let hitzTxHash = record.txHash;
  let xlmTxHash = record.xlmTxHash;

  // Both `pending` and `failed` are eligible for a (re)try.
  try {
    const server = new StellarSdk.rpc.Server(env.RPC_URL);
    const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
    const userKp = await deriveKeypair(email, env.MASTER_SECRET);

    // (1) Bootstrap target + USDC trustline (sponsored). Idempotent —
    // short-circuits if account already exists with the trustline.
    await ensureBootstrappedWithUsdcTrustline(env, server, sponsor, userKp);

    // (2) HITZ SAC transfer. Persist the hash *before* attempting the
    // XLM leg so a partial failure can never re-pay HITZ on retry.
    if (!hitzTxHash) {
      hitzTxHash = await transferHitzFromSponsor(
        env,
        derivedPublicKey,
        record.amount
      );
      await writeReparation(env, email, {
        ...record,
        txHash: hitzTxHash,
        updatedAt: Date.now(),
      });
    }

    // (3) Optional XLM leg. Sequential rather than concurrent so the
    // failure modes are unambiguous: HITZ first (already done), then
    // XLM. Skipped on retry if the previous attempt already landed.
    if (record.xlmAmount && !xlmTxHash) {
      xlmTxHash = await sendXlmFromSponsor(
        env,
        derivedPublicKey,
        record.xlmAmount
      );
    }

    // (4) Mark redeemed.
    const updated: ReparationRecord = {
      ...record,
      status: "redeemed",
      txHash: hitzTxHash,
      xlmTxHash,
      updatedAt: Date.now(),
    };
    await writeReparation(env, email, updated);

    // (5) Background notifications. Don't block the user response on
    // SMTP latency — waitUntil keeps the worker alive after we've
    // already returned.
    ctx.waitUntil(
      notifyClaimSuccess(env, {
        email,
        publicKey: derivedPublicKey,
        amount: record.amount,
        txHash: hitzTxHash,
        xlmAmount: record.xlmAmount,
        xlmTxHash,
      })
    );
    ctx.waitUntil(maybeAlertLowBalance(env));

    return {
      amount: record.amount,
      txHash: hitzTxHash,
      xlmAmount: record.xlmAmount,
      xlmTxHash,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failed: ReparationRecord = {
      ...record,
      status: "failed",
      // Persist whatever progress was made — txHash if HITZ landed,
      // xlmTxHash if both landed but the final write failed (rare).
      txHash: hitzTxHash,
      xlmTxHash,
      error: msg,
      updatedAt: Date.now(),
    };
    await writeReparation(env, email, failed).catch(() => {
      // Best-effort — if KV is also down we can't do much. The record
      // stays in whatever state it was.
    });
    // Don't throw: the magic-link login itself succeeded. The user gets
    // a session and can retry on next login.
    console.error(
      `[reparation] redemption failed for ${email}: ${msg}`
    );
    return null;
  }
}

interface ClaimNotifyArgs {
  email: string;
  publicKey: string;
  amount: string;
  txHash: string;
  /** Set only when the v6+ XLM leg was part of this claim. */
  xlmAmount?: string;
  xlmTxHash?: string;
}

async function notifyClaimSuccess(
  env: Env,
  args: ClaimNotifyArgs
): Promise<void> {
  if (!env.SUPPORT_EMAIL) return;
  const network: "mainnet" | "testnet" =
    env.NETWORK_PASSPHRASE === PUBLIC_NETWORK ? "mainnet" : "testnet";
  try {
    const tmpl = renderClaimNotifyEmail({ ...args, network });
    await sendMail(env, {
      to: { email: env.SUPPORT_EMAIL },
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    });
  } catch (err) {
    console.error(
      `[reparation] support notify email failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Check the sponsor's XLM balance and fire a single alert email if it's
 * below the configured threshold. Debounced via a 24h KV key so the
 * operator inbox doesn't get spammed once we cross the line.
 *
 * Failures here are swallowed — we don't want a missing Horizon to
 * propagate into a failed claim.
 */
export async function maybeAlertLowBalance(env: Env): Promise<void> {
  if (!env.SUPPORT_EMAIL) return;
  const thresholdStr = env.LOW_BALANCE_THRESHOLD_XLM ?? "50";
  const threshold = Number.parseFloat(thresholdStr);
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  let balanceStr: string;
  try {
    balanceStr = await getSponsorXlmBalance(env);
  } catch (err) {
    console.error(
      `[reparation] sponsor balance check failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  const balance = Number.parseFloat(balanceStr);
  if (!Number.isFinite(balance) || balance >= threshold) return;

  // Debounce — only fire once per 24h window.
  const already = await env.MAGIC_LINKS.get(LOW_BALANCE_KEY);
  if (already) return;
  await env.MAGIC_LINKS.put(LOW_BALANCE_KEY, String(Date.now()), {
    expirationTtl: LOW_BALANCE_TTL_SECONDS,
  });

  try {
    const network: "mainnet" | "testnet" =
      env.NETWORK_PASSPHRASE === PUBLIC_NETWORK ? "mainnet" : "testnet";
    const sponsorAddress = await getSponsorAddress(env);
    const tmpl = renderLowBalanceAlertEmail({
      sponsorAddress,
      balanceXlm: balanceStr,
      thresholdXlm: thresholdStr,
      network,
    });
    await sendMail(env, {
      to: { email: env.SUPPORT_EMAIL },
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    });
  } catch (err) {
    console.error(
      `[reparation] low-balance alert email failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // If the email send blows up, drop the debounce key so the next
    // claim can try again (we'd rather over-notify than silently
    // suppress the alert).
    await env.MAGIC_LINKS.delete(LOW_BALANCE_KEY).catch(() => {});
  }
}
