// Transactional email via Cloudflare's native `send_email` Workers binding.
//
// Prereqs (one-time, Cloudflare dashboard):
//   1. Enable Email Routing on the sender domain (skyhitz.io).
//   2. Verify at least one destination address — Cloudflare requires the
//      zone to be Email-Routing-active before any outbound send.
//   3. Add a `send_email` binding to the Pages project (see wrangler.toml).
//
// The binding lives on `env.SEND_EMAIL`. With no destination restrictions
// configured we can send to any recipient — which we need, since magic-link
// + claim emails go to arbitrary user-provided addresses.
//
// MIME is built with `mimetext` (pure-JS, Workers-safe). The native API
// takes raw RFC-5322 text, not a structured envelope like MailChannels did,
// so we render both parts (text + html) and hand the whole string to
// `EmailMessage`.
//
// Two templates:
//   renderMagicLinkEmail  — "click here to log in"
//   renderClaimEmail      — "someone sent you HITZ; click to claim"

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import {
  renderClaimNotifyEmail,
  renderLowBalanceAlertEmail,
} from "./email/templates/admin-notify";
import { renderClaimEmail } from "./email/templates/claim";
import { renderLegacyReparationEmail } from "./email/templates/legacy-reparation";
import { renderMagicLinkEmail } from "./email/templates/magic-link";
import type { Env } from "./types";

interface MailAddress {
  email: string;
  name?: string;
}

interface SendArgs {
  to: MailAddress;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(env: Env, args: SendArgs): Promise<void> {
  const msg = createMimeMessage();
  msg.setSender({ name: env.EMAIL_FROM_NAME, addr: env.EMAIL_FROM });
  msg.setRecipient(
    args.to.name ? { name: args.to.name, addr: args.to.email } : args.to.email
  );
  msg.setSubject(args.subject);
  // Order matters: text first, then html — clients pick the last part they
  // understand, so html wins for rich clients while text remains the
  // fallback for plaintext readers.
  msg.addMessage({ contentType: "text/plain", data: args.text });
  msg.addMessage({ contentType: "text/html", data: args.html });

  const message = new EmailMessage(env.EMAIL_FROM, args.to.email, msg.asRaw());
  await env.SEND_EMAIL.send(message);
}

export {
  renderClaimEmail,
  renderClaimNotifyEmail,
  renderLegacyReparationEmail,
  renderLowBalanceAlertEmail,
  renderMagicLinkEmail,
};

// ─── Validation ──────────────────────────────────────────────────────────

// RFC 5322 compliance isn't the goal — we just want "clearly an email", and
// the actual delivery step is the final truth. This catches typos early
// without rejecting weird-but-valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}
