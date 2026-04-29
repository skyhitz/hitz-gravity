// Tiny HS256 JWT implementation for session cookies.
//
// Why roll our own: `jose` is ~50KB added to every function bundle for a
// feature we use twice (sign + verify HS256). WebCrypto ships with Workers
// and does the heavy lifting for free. This file is ~80 lines and avoids
// the dependency entirely.
//
// Security properties:
// - HS256 (HMAC-SHA-256) with a 32+ char secret — same family jose uses.
// - Constant-time signature comparison via WebCrypto's HMAC verify.
// - `exp` checked explicitly after parse; missing exp = invalid.

import type { Session } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Normalize Uint8Array → ArrayBuffer so WebCrypto's BufferSource-typed
  // params accept it under TS 5 (which otherwise flags SharedArrayBuffer).
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Sign a session payload. Session.exp is authoritative — we copy it to the
 * JWT exp claim so verifiers can rely on standard JWT semantics too.
 */
export async function signSession(session: Session, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(encoder.encode(JSON.stringify(session)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(signingInput)))
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Verify a JWT and return the Session. Returns null on any failure —
 * malformed token, bad signature, or expired exp. Callers should treat
 * null as "no session; prompt login".
 */
export async function verifySession(
  token: string,
  secret: string
): Promise<Session | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(b64urlDecode(sigB64)),
      toArrayBuffer(encoder.encode(`${headerB64}.${payloadB64}`))
    );
    if (!ok) return null;
    const payload = JSON.parse(decoder.decode(b64urlDecode(payloadB64))) as Session;
    if (typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
