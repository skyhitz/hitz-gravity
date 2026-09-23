/**
 * api.ts — reads the Worker's pre-rendered market snapshots.
 *
 * `next dev` doesn't run the Worker, so in development requests go to
 * `NEXT_PUBLIC_API_ORIGIN` (e.g. a local `wrangler dev` on :8787), falling
 * back to production — the snapshot routes are public and CORS-open.
 */

function apiBase(): string {
  if (process.env.NODE_ENV !== "development") return "";
  return process.env.NEXT_PUBLIC_API_ORIGIN ?? "https://skyhitz.io";
}

/** Resolves null while the snapshot is still being indexed (HTTP 503). */
export async function fetchSnapshot<T>(path: string): Promise<T | null> {
  const res = await fetch(`${apiBase()}${path}`, { headers: { Accept: "application/json" } });
  if (res.status === 503) return null;
  if (!res.ok) throw new Error(`${path} unavailable (HTTP ${res.status})`);
  return (await res.json()) as T;
}
