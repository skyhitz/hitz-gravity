// GET /api/auth/me
//
// Returns the current session, or 401 if there isn't one.
//
// GET /api/auth/session
//
// The same question for the frontend, which asks on every page load: 200
// either way, with {email: null, publicKey: null} when nobody is signed in.
// Having no session is the normal case there, and a 401 for it would put an
// error in every visitor's browser console.

import { json, unauthorized } from "../../_lib/http";
import { readSession } from "../../_lib/session";
import type { Env } from "../../_lib/types";

export async function GET(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return unauthorized("no session");
  return json({ email: session.email, publicKey: session.publicKey });
}

export async function GET_SESSION(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  return json({ email: session?.email ?? null, publicKey: session?.publicKey ?? null });
}
