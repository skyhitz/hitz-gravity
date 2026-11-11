// POST /api/auth/login  { email: string }
//
// First leg of the magic-link flow. We do NOT confirm the email belongs to
// a real person (there's no account table — accounts are derived from
// email, so "login" and "signup" are the same operation). We just:
//   1. Validate the email shape.
//   2. Rate-limit: per caller address, per email, and overall. Each call
//      sends an email from our domain to whatever address was typed.
//   3. Generate a 32-byte random token, stash {email, createdAt} in KV
//      with a 10-minute TTL.
//   4. Email the user a link to /auth/verify?token=...
//
// Returns {ok:true} either way on valid-looking emails so attackers can't
// enumerate valid accounts (and because there's nothing to enumerate —
// every email is "valid" in the sense that it derives an address).

import { isValidEmail, renderMagicLinkEmail, sendMail } from "../../_lib/email";
import { badRequest, clientIp, json, readJson, serverError, tooManyRequests } from "../../_lib/http";
import { emailDigest, normalizeEmail } from "../../_lib/derive";
import { loginLimits } from "../../_lib/limits";
import { hit } from "../../_lib/rate-limit";
import type { Env } from "../../_lib/types";

// 10 minutes — short enough that a stolen link has tiny window, long enough
// that users can fish the email out of a second device.
const TOKEN_TTL_SECONDS = 10 * 60;

interface Body {
  email?: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // hex — URL-safe, no padding worries
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body?.email || typeof body.email !== "string") {
    return badRequest("email required");
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email) || email.length > 254) return badRequest("invalid email");

  const verdict = await hit(env.DB, loginLimits(clientIp(request), await emailDigest(email)));
  if (!verdict.ok) return tooManyRequests(verdict.retryAfter);

  const token = randomToken();
  await env.MAGIC_LINKS.put(
    token,
    JSON.stringify({ email, createdAt: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

  const link = `${env.APP_URL}/auth/verify/?token=${token}`;
  try {
    const tmpl = renderMagicLinkEmail(link);
    await sendMail(env, {
      to: { email },
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    });
  } catch (err) {
    // Swallow the original token if we couldn't deliver — no dead tokens
    // sitting in KV. The user will retry.
    await env.MAGIC_LINKS.delete(token);
    return serverError(`failed to send email: ${err instanceof Error ? err.message : String(err)}`);
  }

  return json({ ok: true });
}
