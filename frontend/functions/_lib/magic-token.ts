// Sign-in tokens: what /api/auth/login, /api/gateway/notify and the legacy
// reparation campaign put in the links they mail, and the only thing
// /api/auth/verify redeems.
//
// A token is 32 random bytes in lowercase hex, stored in KV under itself:
//
//   MAGIC_LINKS[<token>] = { email, createdAt }
//
// The same namespace holds other records under prefixed keys: pending
// reparations, the arbitrage bot's state, alert markers, the terminal's used
// challenges. Redeeming reads a key and deletes it, so the value a caller
// sends is checked to be a token before the namespace is touched. No other
// key has a token's form, so nothing else can be read or removed this way.
//
// Erasable TypeScript, run in Node by tests/magic-token.test.mjs.

/** The part of a KV namespace that redeeming a token needs. */
export interface TokenStore {
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export interface TokenRecord {
  email: string;
  /** ms epoch, 0 when the record has none. */
  createdAt: number;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isMagicToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** 32 random bytes in lowercase hex: URL-safe, and the form `isMagicToken` accepts. */
export function newMagicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Redeem a token: its record, or null when `token` isn't a token, was never
 * issued, has expired or was used already. A token works once: its key is
 * deleted the moment it is read, before anything is done with the record.
 */
export async function redeemMagicToken(store: TokenStore, token: unknown): Promise<TokenRecord | null> {
  if (!isMagicToken(token)) return null;
  const raw = await store.get(token);
  if (!raw) return null;
  await store.delete(token);
  try {
    const record = JSON.parse(raw) as { email?: unknown; createdAt?: unknown } | null;
    if (record && typeof record.email === "string" && record.email) {
      return { email: record.email, createdAt: Number(record.createdAt) || 0 };
    }
  } catch {
    // not a token record
  }
  return null;
}
