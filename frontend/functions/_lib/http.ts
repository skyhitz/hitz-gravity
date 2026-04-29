// Small JSON response helpers. Every endpoint returns the same shape on
// error — {error: string} — so the client has one parsing path to worry
// about. Success shapes are endpoint-specific.

export function json<T>(data: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export function badRequest(msg: string): Response {
  return json({ error: msg }, { status: 400 });
}

export function unauthorized(msg = "unauthorized"): Response {
  return json({ error: msg }, { status: 401 });
}

export function serverError(msg: string): Response {
  return json({ error: msg }, { status: 500 });
}

/** Safely parse a JSON body; returns null on bad JSON or wrong content-type. */
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  const ct = req.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
