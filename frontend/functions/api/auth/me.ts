// GET /api/auth/me
//
// Returns the current session, or 401 if there isn't one. The frontend
// calls this on mount to hydrate the email-user state; missing cookie is
// the expected "no session" case, not an error.

import { json, unauthorized } from "../../_lib/http";
import { readSession } from "../../_lib/session";
import type { Env } from "../../_lib/types";

export async function GET(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return unauthorized("no session");
  return json({ email: session.email, publicKey: session.publicKey });
}
