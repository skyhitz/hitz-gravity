export const buttonStyle =
  "display:inline-block;padding:12px 20px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

export function baseEmail(heading: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#0a0b10;color:#e4e6ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0b10;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12141b;border:1px solid #272a35;border-radius:16px;">
        <tr><td style="padding:32px 28px;">
          <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8a8f9a;margin-bottom:6px;">HITZ</div>
          <h1 style="margin:0 0 24px;font-size:22px;color:#fff;font-weight:600;">${escapeHtml(heading)}</h1>
          ${bodyHtml}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#5a5f6a;font-size:11px;">© HITZ · Gravity Protocol</p>
    </td></tr>
  </table>
</body></html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
