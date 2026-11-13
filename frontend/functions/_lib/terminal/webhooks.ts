// Alerts pushed to subscribers' webhooks. The cron (every 5 minutes) asks the data worker for the alerts
// since its cursor, and sends each one once to every webhook whose account's plan includes webhooks.
// Bodies are signed: X-Skyhitz-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body"> under the
// webhook's own secret, which is derived from MASTER_SECRET and its id (shown to the owner, never stored).
//
// Erasable TypeScript, run in Node by tests/terminal-webhooks.test.mjs.

import { hex, hmac } from "./auth.ts";
import { PLANS } from "./plans.ts";
import { planAt } from "./billing.ts";
import { activeWebhooks, deliveredPairs, getState, purchasesOf, recordDelivery, setState, type WebhookRow } from "./store.ts";

export const FORMATS = ["json", "discord", "slack"] as const;
export type WebhookFormat = (typeof FORMATS)[number];
export const ALERT_KINDS = ["exchange_deposit", "exchange_withdrawal", "sdf_deposit", "liquidation_burst", "spread_spike"] as const;

export interface Alert {
  id: string;
  kind: string;
  at: number;
  title: string;
  text: string;
  data: Record<string, unknown>;
}

/** HTTPS to a public host name only: no IP literals, no local names, no credentials, the default port. */
export function checkWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length > 500) return { ok: false, reason: "url must be a string of at most 500 characters." };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "url is not a valid URL." };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "Webhooks must use https." };
  if (u.username || u.password) return { ok: false, reason: "No credentials in the URL." };
  if (u.port && u.port !== "443") return { ok: false, reason: "Webhooks use the default https port." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || host.includes(":")) return { ok: false, reason: "Use a public host name, not an IP address." };
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return { ok: false, reason: "Use a public host name." };
  return { ok: true, url: u.toString() };
}

export async function webhookSecret(terminalSecret: string, id: string): Promise<string> {
  return `whsec_${hex(await hmac(terminalSecret, `webhook|${id}`))}`;
}

export async function signatureHeader(secret: string, body: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${hex(await hmac(secret, `${t}.${body}`))}`;
}

/** The body for a webhook's format: our JSON, or a message Discord or Slack posts as is. */
export function bodyFor(format: string, a: Alert): string {
  if (format === "discord") return JSON.stringify({ username: "HITZ Terminal", content: `**${a.title}**\n${a.text}`.slice(0, 1900) });
  if (format === "slack") return JSON.stringify({ text: `*${a.title}*\n${a.text}` });
  return JSON.stringify({ id: a.id, kind: a.kind, at: new Date(a.at).toISOString(), title: a.title, text: a.text, data: a.data, source: "HITZ Terminal" });
}

const wants = (hook: WebhookRow, kind: string) => {
  if (!hook.kinds) return true;
  try {
    return (JSON.parse(hook.kinds) as string[]).includes(kind);
  } catch {
    return true;
  }
};

export type Send = (url: string, body: string, headers: Record<string, string>) => Promise<number>;

/** POST with a 5-second limit; the HTTP status, or 0 when the request itself failed. */
export const sendHttp: Send = async (url, body, headers) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", "User-Agent": "HITZ-Terminal-Webhooks/1", ...headers }, signal: ctl.signal, redirect: "manual" });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
};

export const CURSOR_KEY = "alerts_cursor";
/** Alerts arrive late (Coinalyze runs up to 25 minutes behind, transfers every 10): each run looks back this far. */
export const OVERLAP_MS = 60 * 60_000;
/** Nothing older than this is pushed, so a first run or a long outage does not flood anyone. */
export const MAX_AGE_MS = 6 * 3_600_000;
export const MAX_SENDS_PER_RUN = 300;

export interface DeliverDeps {
  db: D1Database;
  alerts(fromMs: number, toMs: number): Promise<Alert[]>;
  send: Send;
  terminalSecret: string;
  nowMs: number;
}

export async function deliverAlerts(d: DeliverDeps) {
  const report = { alerts: 0, sent: 0, failed: 0, hooks: 0 };
  const hooks = await activeWebhooks(d.db);
  const cursor = Number((await getState(d.db, CURSOR_KEY)) ?? d.nowMs - OVERLAP_MS);
  const fromMs = Math.max(d.nowMs - MAX_AGE_MS, cursor - OVERLAP_MS);
  if (!hooks.length) {
    await setState(d.db, CURSOR_KEY, String(d.nowMs));
    return report;
  }
  const plans = await purchasesOf(d.db, [...new Set(hooks.map((h) => h.account))]);
  const eligible = hooks.filter((h) => {
    const p = planAt(plans.get(h.account) ?? [], d.nowMs);
    const room = PLANS[p.plan].webhooks;
    // An account over its plan's allowance (after a downgrade) keeps its oldest webhooks only.
    return room > 0 && hooks.filter((x) => x.account === h.account).indexOf(h) < room;
  });
  report.hooks = eligible.length;
  const alerts = (await d.alerts(fromMs, d.nowMs)).filter((a) => a.at >= d.nowMs - MAX_AGE_MS).sort((a, b) => a.at - b.at);
  report.alerts = alerts.length;
  const done = await deliveredPairs(d.db, alerts.map((a) => a.id));
  for (const a of alerts) {
    for (const h of eligible) {
      if (report.sent + report.failed >= MAX_SENDS_PER_RUN) break;
      if (done.has(`${h.id}|${a.id}`) || !wants(h, a.kind)) continue;
      const body = bodyFor(h.format, a);
      const secret = await webhookSecret(d.terminalSecret, h.id);
      const status = await d.send(h.url, body, { "X-Skyhitz-Signature": await signatureHeader(secret, body, d.nowMs), "X-Skyhitz-Alert-Id": a.id });
      await recordDelivery(d.db, h.id, a.id, status, d.nowMs);
      if (status >= 200 && status < 300) report.sent += 1;
      else report.failed += 1;
    }
  }
  if (report.sent + report.failed < MAX_SENDS_PER_RUN) await setState(d.db, CURSOR_KEY, String(d.nowMs));
  return report;
}

export function sampleAlert(nowMs: number): Alert {
  return {
    id: `test:${nowMs}`,
    kind: "test",
    at: nowMs,
    title: "Test alert from the HITZ Terminal",
    text: "Your webhook works. Real alerts look like this one: a title, a line of text, and the data behind it.",
    data: { test: true },
  };
}
