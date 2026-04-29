// Everything derived from a single MASTER_SECRET.
//
// One secret is easier to rotate-never, back up once, and manage in
// wrangler. We domain-separate inside SHA-256 so the three derived
// materials are independent — compromise of one can't be chained into
// the others:
//
//   user_seed_root = SHA-256("hitz:v1:users"   || master_bytes)
//   sponsor_seed   = SHA-256("hitz:v1:sponsor" || master_bytes)   → ed25519 Keypair
//   jwt_key        = SHA-256("hitz:v1:jwt"     || master_bytes)   → HMAC key bytes
//
// Per-user Stellar address derivation then layers the email on top of
// user_seed_root:
//
//   user_seed = SHA-256( user_seed_root || SHA-256(lowercase_email) )
//
// so the user derivation retains the same "master || email-hash" shape
// it had before, but with an extra domain-separation step first.
//
// Runs inside Cloudflare Workers via WebCrypto — no Node APIs.

import { Keypair } from "@stellar/stellar-sdk";

/** Normalize an email the same way everywhere — lowercase + trim. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into an ArrayBuffer-backed view to satisfy WebCrypto's BufferSource
  // typing under TS 5 strictness (rules out SharedArrayBuffer backing).
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ─── Server-wide key material, memoized per-isolate ──────────────────────

export interface ServerKeys {
  /** 32 bytes used as the root for per-user derivation. */
  userSeedRoot: Uint8Array;
  /** The gas-sponsor Stellar Keypair. Its G-address is what the operator must fund. */
  sponsorKeypair: Keypair;
  /** Hex string used as HMAC-SHA-256 key for session JWTs. */
  jwtSecret: string;
}

// One MASTER_SECRET → one ServerKeys per isolate. Workers reuse isolates
// across requests, so this effectively caches the three SHA-256 rounds
// + Keypair construction for the lifetime of the instance.
const keysCache = new Map<string, Promise<ServerKeys>>();

async function deriveLabel(master: Uint8Array, label: string): Promise<Uint8Array> {
  return sha256(concat(new TextEncoder().encode(label), master));
}

export function getServerKeys(masterSecretHex: string): Promise<ServerKeys> {
  const cached = keysCache.get(masterSecretHex);
  if (cached) return cached;
  const pending = (async () => {
    const master = hexToBytes(masterSecretHex);
    if (master.length < 32) {
      throw new Error("MASTER_SECRET must be at least 32 bytes of hex");
    }
    const [userSeedRoot, sponsorSeed, jwtSeed] = await Promise.all([
      deriveLabel(master, "hitz:v1:users"),
      deriveLabel(master, "hitz:v1:sponsor"),
      deriveLabel(master, "hitz:v1:jwt"),
    ]);
    const sponsorKeypair = Keypair.fromRawEd25519Seed(Buffer.from(sponsorSeed));
    return {
      userSeedRoot,
      sponsorKeypair,
      jwtSecret: bytesToHex(jwtSeed),
    };
  })();
  keysCache.set(masterSecretHex, pending);
  return pending;
}

// ─── Per-user derivation ─────────────────────────────────────────────────

async function deriveUserSeed(email: string, root: Uint8Array): Promise<Uint8Array> {
  const normalized = normalizeEmail(email);
  const emailHash = await sha256(new TextEncoder().encode(normalized));
  return sha256(concat(root, emailHash));
}

/**
 * Return the Stellar Keypair for an email. Public key is freely shareable;
 * the private key should never leave the Worker boundary.
 */
export async function deriveKeypair(
  email: string,
  masterSecretHex: string
): Promise<Keypair> {
  const keys = await getServerKeys(masterSecretHex);
  const seed = await deriveUserSeed(email, keys.userSeedRoot);
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/** Convenience — just the G-address, no private material held in memory. */
export async function deriveAddress(
  email: string,
  masterSecretHex: string
): Promise<string> {
  const kp = await deriveKeypair(email, masterSecretHex);
  return kp.publicKey();
}
