// Cookie helpers for the session JWT.
//
// One cookie name (`hitz_session`), one shape, three operations: read from
// request, set on response, clear on response. HttpOnly + Secure + SameSite
// lax is the safe baseline — we never need the token in JS and the only
// cross-site context is the Stellar Wallets Kit popup (which doesn't touch
// our cookies).

import { getServerKeys } from "./derive";
import { verifySession } from "./jwt";
import type { Env, Session } from "./types";

export const COOKIE_NAME = "hitz_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Parse the session cookie out of an incoming request. Returns null if missing/invalid/expired. */
export async function readSession(
  request: Request,
  env: Env
): Promise<Session | null> {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const match = header
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const { jwtSecret } = await getServerKeys(env.MASTER_SECRET);
  return verifySession(token, jwtSecret);
}

/** Build a Set-Cookie header value for a fresh session. */
export function serializeSessionCookie(jwt: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return [
    `${COOKIE_NAME}=${jwt}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** Build a Set-Cookie header value that clears the session. */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
