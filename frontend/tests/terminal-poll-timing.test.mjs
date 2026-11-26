// When the Terminal's panels poll next (app/components/terminal/pollTiming.ts): a good answer waits the
// panel's own cadence (four times longer while the page is hidden); a server failure or no answer at all
// retries within a minute, even on a tab that refreshes every 15 minutes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPollMs, retryable, RETRY_MS } from "../app/components/terminal/pollTiming.ts";

test("a good answer waits the panel's own cadence, four times longer when hidden", () => {
  assert.equal(nextPollMs(900_000, false, false), 900_000);
  assert.equal(nextPollMs(60_000, false, true), 240_000);
});

test("a failure retries within a minute, never slower than the panel's cadence", () => {
  assert.equal(RETRY_MS, 60_000);
  assert.equal(nextPollMs(900_000, true, false), 60_000);
  assert.equal(nextPollMs(900_000, true, true), 240_000);
  assert.equal(nextPollMs(15_000, true, false), 15_000);
});

test("only the server's failures and no answer retry sooner, not refusals or rate limits", () => {
  assert.equal(retryable({ ok: false, status: 503 }), true);
  assert.equal(retryable({ ok: false, status: 502 }), true);
  assert.equal(retryable({ ok: false, status: 0 }), true);
  assert.equal(retryable({ ok: false, status: 429 }), false);
  assert.equal(retryable({ ok: false, status: 403 }), false);
  assert.equal(retryable({ ok: true }), false);
});
