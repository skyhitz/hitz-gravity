import { baseEmail, buttonStyle, escapeHtml } from "./shared";

export function renderClaimEmail(params: {
  fromLabel: string;
  amountHuman: string;
  claimLink: string;
}) {
  const subject = `You received ${params.amountHuman} HITZ`;
  const text = [
    `${params.fromLabel} sent you ${params.amountHuman} HITZ.`,
    "",
    "Claim your tokens by signing in here:",
    params.claimLink,
    "",
    "Your tokens are already on-chain — the link just unlocks the account tied to your email.",
  ].join("\n");
  const html = baseEmail(
    `You received ${escapeHtml(params.amountHuman)} HITZ`,
    `
      <p style="margin:0 0 16px;color:#cfd2dc;"><strong style="color:#fff;">${escapeHtml(params.fromLabel)}</strong> sent you <strong style="color:#fff;">${escapeHtml(params.amountHuman)} HITZ</strong>.</p>
      <p style="margin:0 0 24px;color:#cfd2dc;">Your tokens are already on-chain — the link below unlocks the account tied to your email.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(params.claimLink)}" style="${buttonStyle}">Claim your HITZ</a>
      </p>
      <p style="margin:0;color:#8a8f9a;font-size:12px;">
        If you didn't expect this, you can ignore this email — nothing will happen until you sign in.
      </p>
    `
  );
  return { subject, text, html };
}
