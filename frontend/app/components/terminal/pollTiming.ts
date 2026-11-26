/**
 * When the Terminal's panels poll next. A good answer waits the panel's own cadence; a failure on the
 * server's side, or no answer at all, retries within a minute, so a tab that refreshes every 15 minutes
 * doesn't sit on an error that long. A hidden page polls four times less often either way.
 *
 * Pure and erasable TypeScript, run in Node by tests/terminal-poll-timing.test.mjs. House style: no em-dashes.
 */

export const RETRY_MS = 60_000;

/** A failure worth retrying sooner: the server's (5xx) or no answer at all (0); not a refusal or a rate limit. */
export const retryable = (r: { ok: boolean; status?: number }): boolean => !r.ok && (r.status === 0 || (r.status ?? 0) >= 500);

export const nextPollMs = (everyMs: number, failed: boolean, hidden: boolean): number => (failed ? Math.min(everyMs, RETRY_MS) : everyMs) * (hidden ? 4 : 1);
