// POST /api/gateway/notify
//
//   body: { toEmail, amountHuman, fromLabel, hash }
//
// Called by the frontend AFTER a "send HITZ to email" transfer lands.
// Emails the recipient a one-click claim link that auto-signs them in:
//   - We mint a single-use token and stash it in KV (same shape as
//     /api/auth/login).
//   - The email points at /auth/verify?token=… so the recipient lands
//     signed-in and immediately sees the transferred balance. Zero extra
//     friction — no "check your inbox for the login link" step after.
//   - Claim tokens get a longer TTL than ordinary login tokens (7 days
//     vs. 10 min); a recipient might not check email until later but the
//     convenience link should still work.
//
// Rate-limiting nuance: we deliberately don't require auth here. Anyone
// who successfully transferred HITZ to a derived address should be able
// to notify the owner. To prevent spam we could require a session, but
// wallet users (the most common case) don't have one. The email abuse
// surface is the same as /auth/login — bounded by what Cloudflare's
// send_email binding will accept. If abuse shows up we'll gate on hash
// verification (re-read the ledger and confirm the transfer actually
// exists).

import { isValidEmail, renderClaimEmail, sendMail } from "../../_lib/email";
import { badRequest, json, readJson, serverError } from "../../_lib/http";
import { normalizeEmail } from "../../_lib/derive";
import type { Env } from "../../_lib/types";

interface Body {
  toEmail?: string;
  amountHuman?: string;
  fromLabel?: string;
  hash?: string;
}

// 7 days. Long enough that a forgotten email can still be claimed in a
// typical inbox-triage window, short enough that stale tokens don't
// accumulate in KV forever.
const CLAIM_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body) return badRequest("invalid body");
  if (!body.toEmail || typeof body.toEmail !== "string" || !isValidEmail(body.toEmail)) {
    return badRequest("valid toEmail required");
  }
  if (!body.amountHuman || typeof body.amountHuman !== "string") {
    return badRequest("amountHuman required");
  }
  const fromLabel =
    typeof body.fromLabel === "string" && body.fromLabel.length > 0
      ? body.fromLabel
      : "A HITZ user";
  const email = normalizeEmail(body.toEmail);

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
      amountHuman: body.amountHuman,
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
    // email to claim it.
    await env.MAGIC_LINKS.delete(token);
    return serverError(
      `failed to send email: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
