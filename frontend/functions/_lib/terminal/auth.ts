// Who is calling the terminal, and how they prove it.
//
//   Wallet sign-in   The server hands out a challenge: a transaction with the account as source and
//                    sequence 0 (it can never be submitted), one manageData op carrying a nonce and an
//                    HMAC of it under the terminal secret, valid 5 minutes. Any Stellar wallet signs it.
//                    The server checks the HMAC, the time bounds and the signatures against the
//                    account's signers and medium threshold, then sets a 30-day cookie.
//   Email accounts   The gateway's own session cookie names the account (passed in as emailAccount).
//   API keys         "htz_" and 32 random bytes, shown once; only the SHA-256 is stored.
//
// Pure and erasable TypeScript (WebCrypto and the Stellar SDK only), run in Node by the tests.

import { Account, FeeBumpTransaction, Keypair, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

export const COOKIE = "hitz_terminal";
export const SESSION_TTL_S = 30 * 86_400;
export const CHALLENGE_NAME = "skyhitz.io terminal sign-in";
export const CHALLENGE_TTL_S = 300;
/** A wallet's clock may run this far behind the server's. */
const SKEW_S = 60;

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ─── Bytes ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function buf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

export async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(enc.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, buf(enc.encode(message))));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(enc.encode(text)))));
}

/** Constant-time equality of two byte strings. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ─── Session tokens ───────────────────────────────────────────────────────────

export interface TerminalSession {
  account: string;
  /** Unix seconds. */
  exp: number;
}

export async function signSession(s: TerminalSession, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ a: s.account, e: s.exp })));
  return `t1.${body}.${b64url(await hmac(secret, `session|${body}`))}`;
}

export async function verifySession(token: string, secret: string, nowMs: number): Promise<TerminalSession | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "t1") return null;
  try {
    if (!sameBytes(fromB64url(parts[2]), await hmac(secret, `session|${parts[1]}`))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as { a?: unknown; e?: unknown };
    if (typeof p.a !== "string" || typeof p.e !== "number" || p.e * 1000 <= nowMs) return null;
    return { account: p.a, exp: p.e };
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, maxAge = SESSION_TTL_S): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  }
  return null;
}

// ─── Wallet challenge ─────────────────────────────────────────────────────────

export function requireAccount(input: unknown): string {
  if (typeof input !== "string" || !StrKey.isValidEd25519PublicKey(input.trim())) {
    throw new AuthError(400, "invalid_account", "account must be a Stellar account (G...).");
  }
  return input.trim();
}

const challengeMac = (secret: string, account: string, nonce: Uint8Array, maxTime: number) =>
  hmac(secret, `challenge|${account}|${hex(nonce)}|${maxTime}`).then((m) => m.slice(0, 16));

const fromHex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * The manageData value is the nonce and its MAC as 64 lowercase hex characters, a string. Never a
 * Buffer: the Worker bundles the SDK's browser build, whose own Buffer polyfill does not recognize the
 * runtime's Buffer (manageData throws "value must be a string, Buffer or null"), while Node's tests use
 * the Node build, where both are the same class.
 */
export const CHALLENGE_VALUE_RE = /^[0-9a-f]{64}$/;

export async function buildChallenge(account: string, secret: string, nowMs: number, passphrase: string): Promise<{ xdr: string; expires_at: number }> {
  const acct = requireAccount(account);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const minTime = Math.floor(nowMs / 1000);
  const maxTime = minTime + CHALLENGE_TTL_S;
  const mac = await challengeMac(secret, acct, nonce, maxTime);
  const value = hex(nonce) + hex(mac);
  const tx = new TransactionBuilder(new Account(acct, "-1"), { fee: "100", networkPassphrase: passphrase, timebounds: { minTime, maxTime } })
    .addOperation(Operation.manageData({ name: CHALLENGE_NAME, value, source: acct }))
    .build();
  return { xdr: tx.toXDR(), expires_at: maxTime * 1000 };
}

export interface Signers {
  signers: { key: string; weight: number }[];
  /** The account's medium threshold; at least 1 is required whatever it says. */
  threshold: number;
}

/** A signed challenge: ours, unexpired, unchanged, and signed with enough weight. Returns its nonce. */
export async function verifyChallenge(xdr: string, account: string, secret: string, signers: Signers, nowMs: number, passphrase: string): Promise<string> {
  const bad = (message: string) => new AuthError(401, "bad_challenge", message);
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(String(xdr), passphrase);
  } catch {
    throw bad("The signed challenge is not a Stellar transaction.");
  }
  if (tx instanceof FeeBumpTransaction) throw bad("Sign the challenge itself, not a fee bump.");
  if (tx.source !== account || tx.sequence !== "0" || tx.operations.length !== 1) throw bad("This is not the challenge for this account.");
  const op = tx.operations[0];
  if (op.type !== "manageData" || op.name !== CHALLENGE_NAME || (op.source && op.source !== account)) throw bad("This is not a terminal sign-in challenge.");
  const text = op.value ? new TextDecoder().decode(new Uint8Array(op.value)) : "";
  const minTime = Number(tx.timeBounds?.minTime ?? 0);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!CHALLENGE_VALUE_RE.test(text) || maxTime - minTime !== CHALLENGE_TTL_S) throw bad("The challenge was changed.");
  const value = fromHex(text);
  const now = Math.floor(nowMs / 1000);
  if (now < minTime - SKEW_S || now > maxTime) throw new AuthError(401, "challenge_expired", "The challenge expired. Ask for a new one.");
  if (!sameBytes(value.slice(16), await challengeMac(secret, account, value.slice(0, 16), maxTime))) throw bad("The challenge was not issued here.");
  const hash = tx.hash();
  let weight = 0;
  for (const s of signers.signers) {
    if (s.weight <= 0) continue;
    let kp: Keypair;
    try {
      kp = Keypair.fromPublicKey(s.key);
    } catch {
      continue;
    }
    // Plain bytes on both sides: the SDK's Buffers and the runtime's are different classes in the Worker.
    const hint = new Uint8Array(kp.signatureHint());
    if (tx.signatures.some((sig) => sameBytes(new Uint8Array(sig.hint()), hint) && kp.verify(hash, sig.signature()))) weight += s.weight;
  }
  if (weight < Math.max(1, signers.threshold)) throw new AuthError(401, "not_signed", "The challenge is not signed by this account's key.");
  return hex(value.slice(0, 16));
}

/** Signers and medium threshold from Horizon's account record; the master key alone for an account
 *  that does not exist yet. */
export function signersFromHorizon(account: string, record: unknown): Signers {
  const r = record as { signers?: { key?: string; weight?: number; type?: string }[]; thresholds?: { med_threshold?: number } } | null;
  if (!r || !Array.isArray(r.signers)) return { signers: [{ key: account, weight: 1 }], threshold: 1 };
  const signers = r.signers
    .filter((s) => (s.type ?? "ed25519_public_key") === "ed25519_public_key" && typeof s.key === "string" && typeof s.weight === "number")
    .map((s) => ({ key: s.key as string, weight: s.weight as number }));
  return { signers, threshold: r.thresholds?.med_threshold ?? 0 };
}

// ─── API keys ─────────────────────────────────────────────────────────────────

export const KEY_RE = /^htz_[A-Za-z0-9_-]{43}$/;

export function newApiKey(): { key: string; prefix: string } {
  const key = `htz_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { key, prefix: key.slice(0, 12) };
}

// ─── Who is calling ───────────────────────────────────────────────────────────

export type Via = "key" | "wallet" | "email" | "none";

export interface Caller {
  account: string | null;
  via: Via;
  keyHash?: string;
}

export interface IdentifyDeps {
  secret: string;
  /** The account of an active (not revoked) key, by its SHA-256. */
  keyAccount(hash: string): Promise<string | null>;
  /** The account of the email gateway's session, if any. */
  emailAccount(request: Request): Promise<string | null>;
  nowMs: number;
}

/**
 * A key wins over cookies, and a key that is presented but unknown is refused rather than read as a
 * free visitor, so a revoked key fails loudly. Then the terminal cookie, then the email session.
 */
export async function identify(request: Request, deps: IdentifyDeps): Promise<Caller> {
  const header = request.headers.get("Authorization");
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m || !KEY_RE.test(m[1])) throw new AuthError(401, "invalid_key", "Send an API key as Authorization: Bearer htz_...");
    const hash = await sha256Hex(m[1]);
    const account = await deps.keyAccount(hash);
    if (!account) throw new AuthError(401, "invalid_key", "This API key is unknown or revoked.");
    return { account, via: "key", keyHash: hash };
  }
  const token = cookieValue(request, COOKIE);
  if (token) {
    const s = await verifySession(token, deps.secret, deps.nowMs);
    if (s) return { account: s.account, via: "wallet" };
  }
  const email = await deps.emailAccount(request);
  if (email) return { account: email, via: "email" };
  return { account: null, via: "none" };
}
