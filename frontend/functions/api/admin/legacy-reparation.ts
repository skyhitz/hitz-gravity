// POST /api/admin/legacy-reparation
//
//   Authorization: Bearer <LEGACY_REPARATION_TOKEN>
//   body: { email, amount, xlmAmount? }
//
// Two writes per call:
//   1. Magic-link token → MAGIC_LINKS[<token>] (30-day TTL)
//   2. Pending reparation record → MAGIC_LINKS["reparation:<email>"]
//      with the `amount` (HITZ) and optional `xlmAmount` (native XLM) to
//      be transferred when the user actually claims.
//
// The v6 reparation campaign splits legacy value across HITZ + XLM, so
// rows can carry a non-zero `xlmAmount`. Pre-v6 callers omit it and the
// redeem flow falls back to a single HITZ transfer.
//
// Then send the campaign email. If email send fails we roll back the
// magic-link token but leave the reparation record — that way a future
// retry of the same email reuses the existing pending record (and can
// even be resent with the same or a different amount).
//
// The actual HITZ transfer happens lazily inside /api/auth/verify, NOT
// here. Users who never click the email cost us nothing.

import {
  isValidEmail,
  renderLegacyReparationEmail,
  sendMail,
} from "../../_lib/email";
import { badRequest, json, readJson, serverError } from "../../_lib/http";
import { normalizeEmail } from "../../_lib/derive";
import { putPendingReparation } from "../../_lib/reparation";
import type { Env } from "../../_lib/types";

interface Body {
  email?: string;
  amount?: string | number;
  xlmAmount?: string | number;
}

// 30 days is long enough for an inbox campaign while still expiring old links.
const LEGACY_CLAIM_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 && token === env.LEGACY_REPARATION_TOKEN;
}

// Decimal string with up to 7 fractional digits (HITZ uses 7 decimals,
// matching Stellar's classic precision). Rejects scientific notation,
// signs, whitespace — anything that would surprise toStroopsI128.
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

function normalizeAmount(raw: string | number | undefined): string | null {
  if (raw === undefined) return null;
  const s = typeof raw === "number" ? raw.toString() : raw.trim();
  if (!AMOUNT_RE.test(s)) return null;
  // Reject zero — there's no point creating a pending record for nothing.
  if (Number.parseFloat(s) <= 0) return null;
  return s;
}

export async function POST(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await readJson<Body>(request);
  if (!body?.email || typeof body.email !== "string") {
    return badRequest("email required");
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return badRequest("invalid email");

  const amount = normalizeAmount(body.amount);
  if (!amount) {
    return badRequest("amount required (decimal string, ≤7 fractional digits, > 0)");
  }

  // Optional XLM leg. If the caller sends the field at all it must parse
  // cleanly — undefined is fine (skip the leg), but a malformed string is
  // an error so a typo'd column never silently degrades to HITZ-only.
  let xlmAmount: string | undefined;
  if (body.xlmAmount !== undefined && body.xlmAmount !== null && body.xlmAmount !== "") {
    const normalized = normalizeAmount(body.xlmAmount);
    if (!normalized) {
      return badRequest("xlmAmount must be a decimal string, ≤7 fractional digits, > 0");
    }
    xlmAmount = normalized;
  }

  const token = randomToken();
  await env.MAGIC_LINKS.put(
    token,
    JSON.stringify({ email, createdAt: Date.now() }),
    { expirationTtl: LEGACY_CLAIM_TOKEN_TTL_SECONDS }
  );
  // Pending reparation record. Outlives the token (1 year) so a failed
  // first-click redemption can be retried on the user's next login.
  await putPendingReparation(env, email, amount, xlmAmount);

  const claimLink = `${env.APP_URL}/auth/verify/?token=${token}`;
  try {
    const tmpl = renderLegacyReparationEmail(claimLink);
    await sendMail(env, {
      to: { email },
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    });
    return json({ ok: true, email, amount, xlmAmount });
  } catch (err) {
    // Roll back the magic-link token (it was tied to this email send).
    // Leave the reparation record alone — the operator can retry the
    // send later and the same pending record will still be valid.
    await env.MAGIC_LINKS.delete(token);
    return serverError(
      `failed to send email: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
