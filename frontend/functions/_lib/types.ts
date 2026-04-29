// Shared types for the Worker gateway.
//
// `Env` mirrors the bindings declared in wrangler.toml + any secrets set
// via `wrangler secret put`. Cloudflare injects these as the second arg
// to `fetch(request, env, ctx)`. Keeping one canonical shape here avoids
// drift between handlers — if you add a binding or secret, add it here
// and every handler gets proper types.

export interface Env {
  // Static assets binding — the [assets] block in wrangler.toml points at
  // out/. We delegate non-/api/* requests to this so the Worker only
  // handles API routes. `Fetcher` is the same shape as `fetch` itself.
  ASSETS: { fetch: typeof fetch };

  // KV binding — see wrangler.toml
  MAGIC_LINKS: KVNamespace;

  // Native Cloudflare `send_email` binding. Configured in wrangler.toml
  // with no destination restrictions (we mail arbitrary user-provided
  // addresses). Requires Email Routing to be enabled on the sender
  // domain (skyhitz.io).
  SEND_EMAIL: SendEmail;

  // Plain vars
  APP_URL: string;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  HITZ_CONTRACT_ID: string;
  RPC_URL: string;
  HORIZON_URL: string;
  NETWORK_PASSPHRASE: string;
  BOOTSTRAP_STARTING_BALANCE: string;

  // Operator inbox. Receives "user X just claimed Y HITZ" notices and
  // "sponsor balance is low" alerts. Free-text mailbox; anything that
  // can receive mail works.
  SUPPORT_EMAIL: string;

  // XLM balance below which the sponsor account triggers a low-balance
  // alert email to SUPPORT_EMAIL. Defaults to "50" if unset. Each user
  // claim costs ~1 XLM (account bootstrap), so set this with enough
  // headroom to top up before claims start failing. Numeric string;
  // floats accepted.
  LOW_BALANCE_THRESHOLD_XLM?: string;

  // Single secret — present only at runtime (never in source, never in
  // wrangler.toml). We domain-separate internally (see _lib/derive.ts) to
  // produce three independent materials:
  //   - user key derivation root
  //   - gas-sponsor Stellar Keypair
  //   - session-JWT HMAC key
  //
  // Hex-encoded, ≥32 bytes of entropy. Rotate only if you're willing to
  // reset every email-derived account + the sponsor account.
  MASTER_SECRET: string;

  // Bearer token used by the legacy reparation campaign endpoint.
  LEGACY_REPARATION_TOKEN: string;

  // Issuer of the USDC asset. Email accounts get a USDC trustline added
  // during bootstrap (and on every login, idempotent) so users can receive
  // USDC after swapping HITZ. The trustline reserve is sponsored by the
  // sponsor account, not the user's. Mainnet Centre issuer:
  // GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.
  USDC_ISSUER: string;
}

/** Session payload carried in the httpOnly cookie (JWT). */
export interface Session {
  /** Lowercased email. */
  email: string;
  /** Derived Stellar public key (G...). */
  publicKey: string;
  /** Unix seconds — matches JWT exp. */
  exp: number;
}
