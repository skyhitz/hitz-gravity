// POST /api/gateway/notify
//
//   body: { toEmail, hash }
//
// Called by the frontend AFTER a "send to email" transfer lands. Emails the
// recipient a one-click claim link that auto-signs them in:
//   - We mint a single-use token and stash it in KV (same shape as
//     /api/auth/login).
//   - The email points at /auth/verify?token=… so the recipient lands
//     signed-in and immediately sees the transferred balance.
//   - Claim tokens get a longer TTL than ordinary login tokens (7 days
//     vs. 10 min); a recipient might not check email until later but the
//     convenience link should still work.
//
// No session is required, because wallet users (the most common senders)
// don't have one. What is required is the transfer itself: `hash` must be a
// recent, successful transfer of HITZ, XLM or USDC to the address derived
// from `toEmail`, and each transfer is announced once. The amount, the asset
// and the sender in the email come from that transaction, not from the
// caller. Otherwise anyone could have this endpoint mail any text they liked
// to any address, from our domain, as often as they wanted.

import * as StellarSdk from "@stellar/stellar-sdk";
import { isValidEmail, renderClaimEmail, sendMail } from "../../_lib/email";
import { gatewayPolicy } from "../../_lib/gateway-policy";
import { badRequest, clientIp, json, readJson, serverError, tooManyRequests } from "../../_lib/http";
import { deriveAddress, emailDigest, normalizeEmail } from "../../_lib/derive";
import { notifyCallerLimits, notifyTransferLimits } from "../../_lib/limits";
import { hit } from "../../_lib/rate-limit";
import { readSession } from "../../_lib/session";
import { VAULT_ID } from "../../_lib/vault-api";
import type { Env } from "../../_lib/types";

interface Body {
  toEmail?: string;
  hash?: string;
}

// 7 days. Long enough that a forgotten email can still be claimed in a
// typical inbox-triage window, short enough that stale tokens don't
// accumulate in KV forever.
const CLAIM_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A transfer is announced within the hour it landed, or not at all. */
const MAX_AGE_SECONDS = 60 * 60;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Raw 7-decimal units → "12.5". */
function displayAmount(raw: bigint): string {
  const frac = (raw % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${raw / 10_000_000n}${frac ? `.${frac}` : ""}`;
}

interface Transfer {
  from: string;
  amount: string;
  symbol: string;
}

/**
 * The transfer of HITZ, XLM or USDC to `recipient` that transaction `hash`
 * made, or null if it isn't one: not found, failed, too old, or anything
 * other than a single `transfer` call on one of those tokens to that address.
 */
async function findTransfer(env: Env, hash: string, recipient: string): Promise<Transfer | null> {
  const res = await new StellarSdk.rpc.Server(env.RPC_URL).getTransaction(hash);
  if (res.status !== "SUCCESS") return null;
  if (Date.now() / 1000 - Number(res.createdAt) > MAX_AGE_SECONDS) return null;

  const envelope = res.envelopeXdr;
  const tx =
    envelope.switch().name === "envelopeTypeTxFeeBump"
      ? new StellarSdk.FeeBumpTransaction(envelope, env.NETWORK_PASSPHRASE).innerTransaction
      : new StellarSdk.Transaction(envelope, env.NETWORK_PASSPHRASE);
  if (tx.operations.length !== 1) return null;
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const invoked = op.func.invokeContract();
  const contract = StellarSdk.Address.fromScAddress(invoked.contractAddress()).toString();
  const policy = gatewayPolicy(env, VAULT_ID);
  const symbol = contract === policy.hitz ? "HITZ" : contract === policy.xlm ? "XLM" : contract === policy.usdc ? "USDC" : null;
  const args = invoked.args();
  if (!symbol || invoked.functionName().toString() !== "transfer" || args.length !== 3) return null;
  try {
    const [from, to, amount] = args.map((a) => StellarSdk.scValToNative(a));
    if (to !== recipient || typeof from !== "string" || typeof amount !== "bigint" || amount <= 0n) return null;
    return { from, amount: displayAmount(amount), symbol };
  } catch {
    return null;
  }
}

export async function POST(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body) return badRequest("invalid body");
  if (!body.toEmail || typeof body.toEmail !== "string" || !isValidEmail(body.toEmail) || body.toEmail.length > 254) {
    return badRequest("valid toEmail required");
  }
  const hash = typeof body.hash === "string" ? body.hash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return badRequest("hash required: the transfer's transaction hash");
  const email = normalizeEmail(body.toEmail);

  const digest = await emailDigest(email);
  const caller = await hit(env.DB, notifyCallerLimits(clientIp(request)));
  if (!caller.ok) return tooManyRequests(caller.retryAfter);

  // One email per transfer, however often the request is repeated. The
  // record holds the recipient's digest, so the same transfer can't be
  // claimed for another address either.
  const sentKey = `notified:${hash}`;
  const announced = await env.MAGIC_LINKS.get(sentKey);
  if (announced) {
    return announced === digest ? json({ ok: true }) : badRequest("no recent transfer to that email with this hash");
  }

  let transfer: Transfer | null;
  try {
    transfer = await findTransfer(env, hash, await deriveAddress(email, env.MASTER_SECRET));
  } catch (err) {
    return serverError(`could not read the transfer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!transfer) return badRequest("no recent transfer to that email with this hash");

  // The recipient's emails per day and everyone's per hour are charged only
  // now, for a transfer that exists: requests naming no real transfer can't
  // use them up.
  const allowance = await hit(env.DB, notifyTransferLimits(digest));
  if (!allowance.ok) return tooManyRequests(allowance.retryAfter);
  await env.MAGIC_LINKS.put(sentKey, digest, { expirationTtl: CLAIM_TOKEN_TTL_SECONDS });

  // Name the sender only when they are signed in as the account that sent it.
  const session = await readSession(request, env);
  const fromLabel = session && session.publicKey === transfer.from ? session.email : "A HITZ user";

  // Mint a single-use login token so the claim link also signs the
  // recipient in. Same KV record shape as /api/auth/login — the existing
  // /api/auth/verify handler consumes it transparently.
  const token = randomToken();
  await env.MAGIC_LINKS.put(
    token,
    JSON.stringify({ email, createdAt: Date.now() }),
    { expirationTtl: CLAIM_TOKEN_TTL_SECONDS }
  );
  const claimLink = `${env.APP_URL}/auth/verify/?token=${token}`;

  try {
    const tmpl = renderClaimEmail({
      fromLabel,
      amount: transfer.amount,
      symbol: transfer.symbol,
      claimLink,
    });
    await sendMail(env, {
      to: { email },
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    });
    return json({ ok: true });
  } catch (err) {
    // Swallow the minted token if delivery failed — otherwise we leave a
    // live login credential in KV for a recipient who never gets the
    // email to claim it. The transfer can be announced again.
    await env.MAGIC_LINKS.delete(token);
    await env.MAGIC_LINKS.delete(sentKey);
    return serverError(
      `failed to send email: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
