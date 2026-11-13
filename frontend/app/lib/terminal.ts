/**
 * Client for the HITZ Terminal's API (/api/terminal/*, functions/_lib/terminal/routes.ts). Same-origin
 * fetches: the session cookie rides along; API keys are for other people's code, not this page.
 *
 * House style: no em-dashes.
 */

export type PlanId = "free" | "trader" | "pro" | "institutional";

export interface PublicPlan {
  id: PlanId;
  name: string;
  usd_per_30_days: number;
  usd_per_year: number;
  tagline: string;
  features: string[];
  delay_minutes: number;
  intraday_days: number | null;
  daily_days: number | null;
  finest_resolution: string;
  datasets: string[];
  api_keys: number;
  webhooks: number;
}

export interface Me {
  account: string | null;
  via: "key" | "wallet" | "email" | "none";
  plan: PlanId;
  plan_name: string;
  until: string | null;
  limits?: { api_keys: number; webhooks: number; requests_per_minute: number; requests_per_day: number };
  keys?: { prefix: string; label: string | null; created_at: string | null; last_used_at: string | null; revoked: boolean }[];
  webhooks?: { id: string; url: string; format: string; kinds: string[] | null; secret: string; failures: number; last_status: number | null; disabled: boolean }[];
  checkouts?: { id: string; plan: PlanId; periods: number; usd: number; asset: string; amount: string; status: string; created_at: string | null; tx_hash: string | null }[];
}

export interface Meta {
  plan: PlanId;
  dataset: string;
  delayed_by_minutes: number;
  from?: string;
  to?: string;
  resolution?: string;
  limited?: string[];
  as_of: string;
  license: string;
}

export type Result<T> = { ok: true; data: T; meta: Meta } | { ok: false; status: number; code: string; error: string; upgrade?: PlanId };

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T & { error?: string; code?: string; upgrade?: PlanId } }> {
  const res = await fetch(`/api/terminal${path}`, { credentials: "same-origin", ...init });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = { error: `HTTP ${res.status}`, code: "bad_response" };
  }
  return { status: res.status, body: body as T & { error?: string; code?: string; upgrade?: PlanId } };
}

export class TerminalError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status >= 400) throw new TerminalError(r.status, r.body.code ?? "error", r.body.error ?? `HTTP ${r.status}`);
  return r.body;
}

export async function data<T>(dataset: string, params: Record<string, string | number | undefined> = {}): Promise<Result<T>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const r = await call<{ data: T; meta: Meta }>(`/data/${dataset}${q.size ? `?${q}` : ""}`);
  if (r.status >= 400) return { ok: false, status: r.status, code: r.body.code ?? "error", error: r.body.error ?? `HTTP ${r.status}`, upgrade: r.body.upgrade };
  return { ok: true, data: r.body.data, meta: r.body.meta };
}

export const plans = async () => (await call<{ plans: PublicPlan[] }>("/plans")).body.plans ?? [];
export const me = async () => (await call<Me>("/me")).body;
export const challenge = (account: string) => post<{ xdr: string; expires_at: number; network_passphrase: string }>("/auth/challenge", { account });
export const verify = (account: string, xdr: string) => post<{ account: string; plan: PlanId }>("/auth/verify", { account, xdr });
export const logout = () => post<{ ok: true }>("/auth/logout", {});

export interface Checkout {
  checkout_id: string;
  plan: PlanId;
  plan_name: string;
  periods: number;
  usd: number;
  pay: { asset: "USDC" | "XLM"; amount: string };
  treasury: string;
  expected_hitz_to_treasury: string | null;
  xdr: string;
  tx_hash: string;
  valid_until: string;
  gateway_call: { contractId: string; method: string; argsXdr: string[] };
}

export interface Confirmed {
  checkout_id: string;
  status: "pending" | "paid" | "expired";
  message?: string;
  tx_hash?: string;
  hitz_to_treasury?: string | null;
  subscription: { plan: PlanId; until: string | null };
}

export const startCheckout = (plan: PlanId, periods: number, asset: "USDC" | "XLM") => post<Checkout>("/checkout", { plan, periods, asset });
export const confirmCheckout = (id: string, proof: { xdr?: string; tx_hash?: string }) => post<Confirmed>("/checkout/confirm", { id, ...proof });
export const createKey = (label: string) => post<{ key: string; prefix: string; label: string | null }>("/keys", { label });
export const revokeKey = (prefix: string) => post<{ revoked: string }>("/keys/revoke", { prefix });
export const createWebhook = (url: string, format: string) => post<{ id: string; secret: string }>("/webhooks", { url, format });
export const deleteWebhook = (id: string) => post<{ deleted: string }>("/webhooks/delete", { id });
export const testWebhook = (id: string) => post<{ status: number; ok: boolean }>("/webhooks/test", { id });

export const PLAN_LABEL: Record<PlanId, string> = { free: "Free", trader: "Trader", pro: "Pro", institutional: "Institutional" };
