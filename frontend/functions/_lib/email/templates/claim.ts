import { baseEmail, buttonStyle, escapeHtml } from "./shared";

/**
 * "Someone sent you 12.5 HITZ". The amount and asset come from the transfer
 * on chain (api/gateway/notify.ts), never from the request.
 */
export function renderClaimEmail(params: {
  fromLabel: string;
  amount: string;
  /** HITZ, XLM or USDC. */
  symbol: string;
  claimLink: string;
}) {
  const received = `${params.amount} ${params.symbol}`;
  const subject = `You received ${received}`;
  const text = [
    `${params.fromLabel} sent you ${received}.`,
    "",
    "Claim it by signing in here:",
    params.claimLink,
    "",
    "It is already on-chain. The link just unlocks the account tied to your email.",
  ].join("\n");
  const html = baseEmail(
    `You received ${received}`,
    `
      <p style="margin:0 0 16px;color:#cfd2dc;"><strong style="color:#fff;">${escapeHtml(params.fromLabel)}</strong> sent you <strong style="color:#fff;">${escapeHtml(received)}</strong>.</p>
      <p style="margin:0 0 24px;color:#cfd2dc;">It is already on-chain. The link below unlocks the account tied to your email.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(params.claimLink)}" style="${buttonStyle}">Claim your ${escapeHtml(params.symbol)}</a>
      </p>
      <p style="margin:0;color:#8a8f9a;font-size:12px;">
        If you didn't expect this, you can ignore this email. Nothing happens until you sign in.
      </p>
    `
  );
  return { subject, text, html };
}
