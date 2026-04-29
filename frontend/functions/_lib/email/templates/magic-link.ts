import { baseEmail, buttonStyle, escapeHtml } from "./shared";

export function renderMagicLinkEmail(link: string) {
  const subject = "Your HITZ sign-in link";
  const text = [
    "Click the link below to sign in to HITZ.",
    "",
    link,
    "",
    "This link is valid for 10 minutes and can only be used once.",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");
  const html = baseEmail(
    "Sign in to HITZ",
    `
      <p style="margin:0 0 16px;color:#cfd2dc;">Click the button below to sign in to your HITZ account.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(link)}" style="${buttonStyle}">Sign in</a>
      </p>
      <p style="margin:0 0 8px;color:#8a8f9a;font-size:13px;">Or copy &amp; paste this URL:</p>
      <p style="margin:0 0 24px;word-break:break-all;">
        <a href="${escapeHtml(link)}" style="color:#a78bfa;">${escapeHtml(link)}</a>
      </p>
      <p style="margin:0;color:#8a8f9a;font-size:12px;">
        This link is valid for 10 minutes and can only be used once. If you didn't request this, ignore this email.
      </p>
    `
  );
  return { subject, text, html };
}
