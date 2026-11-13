import { baseEmail, buttonStyle, escapeHtml } from "./shared";

export function renderLegacyReparationEmail(claimLink: string) {
  const subject = "A New Path for SKYHITZ: Reclaim Your Legacy Balance";
  const text = [
    "Hello,",
    "",
    "We are shifting our focus from music technology to Decentralized Finance (DeFi) infrastructure.",
    "",
    "Combining decentralized money and music tech created too many moving parts. This complexity made it impossible to iterate fast or find a sustainable business model. The old model left our liquidity vulnerable to bad actors, and the burden of sustaining a streaming infrastructure became unsustainable without broader institutional support.",
    "",
    "We are starting with a clean slate on Stellar. Our new protocol, HITZ Protocol, provides liquidity without outside LPs or oracles: its Sovereign Vault owns its liquidity and keeps part of every arbitrage profit in its pools, and the HITZ token caps how much any single account can hold and move freely.",
    "",
    "Claim Your Legacy Balance",
    "We have converted your legacy balance into the new HITZ token (and XLM, where it applies), ready for you to claim.",
    "",
    "Claim Your New HITZ Balance Here",
    claimLink,
    "",
    "(You only need your email to access your magic link.)",
    "",
    "Thank you for being part of our evolution.",
    "",
    "The SKYHITZ Team",
  ].join("\n");
  const html = baseEmail(
    "Claim Your Legacy Balance",
    `
      <p style="margin:0 0 16px;color:#cfd2dc;">Hello,</p>
      <p style="margin:0 0 16px;color:#cfd2dc;">We are shifting our focus from music technology to Decentralized Finance (DeFi) infrastructure.</p>
      <p style="margin:0 0 16px;color:#cfd2dc;">Combining decentralized money and music tech created too many moving parts. This complexity made it impossible to iterate fast or find a sustainable business model. The old model left our liquidity vulnerable to bad actors, and the burden of sustaining a streaming infrastructure became unsustainable without broader institutional support.</p>
      <p style="margin:0 0 16px;color:#cfd2dc;">We are starting with a clean slate on Stellar. Our new protocol, HITZ Protocol, provides liquidity without outside LPs or oracles: its Sovereign Vault owns its liquidity and keeps part of every arbitrage profit in its pools, and the HITZ token caps how much any single account can hold and move freely.</p>
      <h2 style="margin:24px 0 10px;font-size:18px;color:#fff;">Claim Your Legacy Balance</h2>
      <p style="margin:0 0 22px;color:#cfd2dc;">We have converted your legacy balance into the new HITZ token (and XLM, where it applies), ready for you to claim.</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(claimLink)}" style="${buttonStyle}">Claim Your New HITZ Balance Here</a>
      </p>
      <p style="margin:0 0 8px;color:#8a8f9a;font-size:13px;">Or copy &amp; paste this URL:</p>
      <p style="margin:0 0 24px;word-break:break-all;">
        <a href="${escapeHtml(claimLink)}" style="color:#a78bfa;">${escapeHtml(claimLink)}</a>
      </p>
      <p style="margin:0 0 16px;color:#8a8f9a;font-size:13px;">(You only need your email to access your magic link.)</p>
      <p style="margin:0;color:#cfd2dc;">Thank you for being part of our evolution.</p>
      <p style="margin:8px 0 0;color:#cfd2dc;">The SKYHITZ Team</p>
    `
  );
  return { subject, text, html };
}
