// POST /api/auth/logout
//
// Clears the session cookie. Nothing else to do server-side — sessions are
// stateless JWTs, so there's no row to delete. The cookie's Max-Age=0
// tells the browser to drop it immediately.

import { json } from "../../_lib/http";
import { clearSessionCookie } from "../../_lib/session";
import type { Env } from "../../_lib/types";

export async function POST(_request: Request, _env: Env): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
