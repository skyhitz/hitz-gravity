// Browser-side client for the Worker gateway.
//
// Also re-exports a shared email-validation predicate used by both the
// modal and SendToEmail so the two code paths agree on what counts as
// "valid enough to bother submitting".
//
// Endpoints are all same-origin, so the session cookie rides along
// automatically via `credentials: "include"`. Each helper returns a
// discriminated-union result so call sites can pattern-match instead of
// wrapping every call in try/catch.

import * as StellarSdk from "@stellar/stellar-sdk";

// ─── Shared email predicate ──────────────────────────────────────────────
// Mirrors the server-side check in functions/_lib/email.ts. Not a full
// RFC-5322 parser — just "looks like an email, bail out early on typos".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export interface GatewayOk<T> {
  ok: true;
  data: T;
}
export interface GatewayErr {
  ok: false;
  error: string;
}
export type GatewayResult<T> = GatewayOk<T> | GatewayErr;

async function call<T>(
  path: string,
  init?: RequestInit
): Promise<GatewayResult<T>> {
  try {
    const resp = await fetch(path, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      return {
        ok: false,
        error: typeof body.error === "string" ? body.error : `HTTP ${resp.status}`,
      };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────

export function login(email: string) {
  return call<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function verify(token: string) {
  return call<{
    email: string;
    publicKey: string;
    /**
     * Set when a pending legacy-reparation record was redeemed during
     * this verify call. Null on every other login. The verify page uses
     * this to flash a "you just claimed N HITZ (+ M XLM)" confirmation
     * before the redirect home.
     *
     * `xlmAmount` / `xlmTxHash` are populated only for v6+ campaigns
     * where the reparation includes a native-XLM leg alongside HITZ.
     */
    redeemed: {
      amount: string;
      txHash: string;
      xlmAmount?: string;
      xlmTxHash?: string;
    } | null;
  }>(`/api/auth/verify?token=${encodeURIComponent(token)}`);
}

export function me() {
  return call<{ email: string; publicKey: string }>("/api/auth/me");
}

export function logout() {
  return call<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

// ─── Gateway ─────────────────────────────────────────────────────────────

export function resolveEmail(email: string) {
  return call<{ publicKey: string }>("/api/gateway/resolve", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/**
 * Ensure a typed-in G-address has a classic account on chain, creating
 * it (sponsor-funded) if not. Mirrors the side effect resolveEmail has
 * on the derived address. Needed because HITZ SAC transfer refuses
 * destinations without a classic account.
 */
export function bootstrapAddress(address: string) {
  return call<{ publicKey: string }>("/api/gateway/bootstrap", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
}

/**
 * Execute a contract call through the gas-sponsoring gateway. The server
 * derives the user's key from the session cookie, signs, fee-bumps with
 * the sponsor, and submits. Returns the final tx hash.
 */
export function execute(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
) {
  const argsXdr = args.map((a) => a.toXDR("base64"));
  return call<{ hash: string }>("/api/gateway/execute", {
    method: "POST",
    body: JSON.stringify({ contractId, method, argsXdr }),
  });
}

export function notifyClaim(params: {
  toEmail: string;
  amountHuman: string;
  fromLabel: string;
  hash: string;
}) {
  return call<{ ok: true }>("/api/gateway/notify", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Idempotently ensure the session user's derived account exists on chain
 * AND has the configured USDC trustline. WalletContext fires this once on
 * email-session detection so legacy users who bootstrapped before the
 * trustline flow can swap HITZ → USDC without re-logging in.
 *
 * `changed` is true when a tx was submitted (account created, trustline
 * added, or both); false when the account was already in the desired
 * state.
 */
export function ensureTrustline() {
  return call<{ changed: boolean }>("/api/gateway/ensure-trustline", {
    method: "POST",
  });
}

/** One trustline / balance line as Horizon returns it. */
export interface BalanceLine {
  asset_type:
    | "native"
    | "credit_alphanum4"
    | "credit_alphanum12"
    | "liquidity_pool_shares";
  /** Display balance (up to 7 decimals, e.g. "12.3456789"). */
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
}

/**
 * Read classic balances + trustlines for any G-address. Used by the
 * multi-asset Send component to render the asset dropdown from the
 * sender's actual holdings rather than a hard-coded list.
 *
 * Returns `exists: false, balances: []` for accounts that don't exist on
 * chain — call sites should branch on `exists` rather than treating it
 * as an error.
 */
export function getBalances(publicKey: string) {
  return call<{ exists: boolean; balances: BalanceLine[] }>(
    `/api/gateway/balances?publicKey=${encodeURIComponent(publicKey)}`
  );
}
