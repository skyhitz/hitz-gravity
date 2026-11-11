// Operator-facing notifications. These go to SUPPORT_EMAIL, never to end
// users, so the tone is terse and the bodies are dense with the data the
// operator actually needs (addresses, amounts, tx hashes).
//
// Two templates today:
//   renderClaimNotifyEmail       — fires after a successful lazy claim
//   renderLowBalanceAlertEmail   — fires when sponsor XLM dips below the
//                                  configured threshold (debounced 24h via KV)

import { baseEmail, buttonStyle, escapeHtml } from "./shared";

interface ClaimNotifyArgs {
  email: string;
  publicKey: string;
  amount: string;
  txHash: string;
  /** Set only when the v6+ XLM leg ran. Renders an extra row + tx hash. */
  xlmAmount?: string;
  xlmTxHash?: string;
  network: "mainnet" | "testnet";
}

export function renderClaimNotifyEmail(args: ClaimNotifyArgs) {
  const { email, publicKey, amount, txHash, xlmAmount, xlmTxHash, network } =
    args;
  const explorerBase =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  const explorer = `${explorerBase}/tx/${txHash}`;
  const xlmExplorer = xlmTxHash ? `${explorerBase}/tx/${xlmTxHash}` : null;
  const summary = xlmAmount
    ? `${amount} HITZ + ${xlmAmount} XLM`
    : `${amount} HITZ`;
  const subject = `[HITZ] Claimed ${summary} — ${email}`;
  const textLines = [
    "A legacy reparation claim was redeemed.",
    "",
    `Email:        ${email}`,
    `Address:      ${publicKey}`,
    `HITZ amount:  ${amount}`,
    `HITZ tx:      ${txHash}`,
    `HITZ link:    ${explorer}`,
  ];
  if (xlmAmount && xlmTxHash) {
    textLines.push(
      `XLM amount:   ${xlmAmount}`,
      `XLM tx:       ${xlmTxHash}`,
      `XLM link:     ${xlmExplorer}`
    );
  }
  textLines.push("", "No action required.");
  const text = textLines.join("\n");
  const xlmRows =
    xlmAmount && xlmTxHash && xlmExplorer
      ? `
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">XLM amount</td><td style="padding:4px 0;">${escapeHtml(xlmAmount)} XLM</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">XLM tx</td><td style="padding:4px 0;word-break:break-all;">${escapeHtml(xlmTxHash)}</td></tr>
      `
      : "";
  const xlmButton =
    xlmExplorer && xlmTxHash
      ? `
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(xlmExplorer)}" style="${buttonStyle}">View XLM tx</a>
      </p>`
      : "";
  const html = baseEmail(
    "Reparation claim redeemed",
    `
      <p style="margin:0 0 16px;color:#cfd2dc;">A legacy reparation claim was just redeemed.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#cfd2dc;">
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Email</td><td style="padding:4px 0;">${escapeHtml(email)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Address</td><td style="padding:4px 0;word-break:break-all;">${escapeHtml(publicKey)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">HITZ amount</td><td style="padding:4px 0;">${escapeHtml(amount)} HITZ</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">HITZ tx</td><td style="padding:4px 0;word-break:break-all;">${escapeHtml(txHash)}</td></tr>
        ${xlmRows}
      </table>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(explorer)}" style="${buttonStyle}">View HITZ tx</a>
      </p>
      ${xlmButton}
      <p style="margin:0;color:#8a8f9a;font-size:13px;">No action required. This is an informational notice.</p>
    `
  );
  return { subject, text, html };
}

interface LowBalanceArgs {
  sponsorAddress: string;
  /** What the sponsor can pay out or spend on fees. */
  spendableXlm: string;
  /** Held as reserves, mostly for the email accounts it sponsors. */
  lockedXlm: string;
  thresholdXlm: string;
  network: "mainnet" | "testnet";
}

export function renderLowBalanceAlertEmail(args: LowBalanceArgs) {
  const { sponsorAddress, spendableXlm, lockedXlm, thresholdXlm, network } = args;
  const explorer =
    network === "mainnet"
      ? `https://stellar.expert/explorer/public/account/${sponsorAddress}`
      : `https://stellar.expert/explorer/testnet/account/${sponsorAddress}`;
  const subject = `[HITZ] Sponsor low: ${spendableXlm} XLM spendable`;
  const text = [
    "The gas sponsor is running low on spendable XLM.",
    "",
    `Address:    ${sponsorAddress}`,
    `Spendable:  ${spendableXlm} XLM`,
    `Locked:     ${lockedXlm} XLM (reserves, not spendable)`,
    `Threshold:  ${thresholdXlm} XLM`,
    `Explorer:   ${explorer}`,
    "",
    "The sponsor pays the fees of email users' transactions, locks 1 XLM",
    "for each new email account, and pays legacy claims their XLM. Below",
    "5 XLM spendable it stops sponsoring until it is topped up.",
    "",
    "This alert is debounced for 24 hours.",
  ].join("\n");
  const html = baseEmail(
    "Sponsor balance low",
    `
      <p style="margin:0 0 16px;color:#cfd2dc;">The gas sponsor is running low on spendable XLM.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#cfd2dc;">
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Address</td><td style="padding:4px 0;word-break:break-all;">${escapeHtml(sponsorAddress)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Spendable</td><td style="padding:4px 0;color:#fca5a5;">${escapeHtml(spendableXlm)} XLM</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Locked</td><td style="padding:4px 0;">${escapeHtml(lockedXlm)} XLM (reserves, not spendable)</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#8a8f9a;">Threshold</td><td style="padding:4px 0;">${escapeHtml(thresholdXlm)} XLM</td></tr>
      </table>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(explorer)}" style="${buttonStyle}">View on Stellar Expert</a>
      </p>
      <p style="margin:0 0 8px;color:#cfd2dc;">The sponsor pays the fees of email users' transactions, locks 1 XLM for each new email account, and pays legacy claims their XLM. Below 5 XLM spendable it stops sponsoring until it is topped up.</p>
      <p style="margin:0;color:#8a8f9a;font-size:13px;">This alert is debounced for 24 hours.</p>
    `
  );
  return { subject, text, html };
}
