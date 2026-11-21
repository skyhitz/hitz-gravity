// public/auth.md: what an agent reads to get a credential for skyhitz.io (https://skyhitz.io/auth.md),
// checked against the terminal it describes. It is plain markdown that nothing compiles, so a route
// renamed or a detail changed in the terminal would leave it teaching agents a flow that no longer works.
//
// It is also what the isitagentready.com scanner's authMd check reads, and that check keys off words, not
// meaning: it finds a self-contained registration flow by its "## Step N — " headings, request lines and
// credential words, and it reads any registration method named in the file as one the site supports,
// even in a sentence saying it is not. The first test keeps what the check reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildChallenge, newApiKey, sessionCookie } from "../functions/_lib/terminal/auth.ts";
import { PLANS } from "../functions/_lib/terminal/plans.ts";
import { handleTerminal } from "../functions/_lib/terminal/routes.ts";
import { testDb } from "./helpers/d1.mjs";
import { fakeKv } from "./helpers/kv.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const authMd = () => readFileSync(join(root, "public", "auth.md"), "utf8");
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

/** The ```http blocks: the method, path, headers and body of each request the file shows. */
function requests(text) {
  return [...text.matchAll(/^```http\n([\s\S]*?)^```$/gm)].map(([, block]) => {
    const [head, ...body] = block.trimEnd().split("\n\n");
    const [line, ...headerLines] = head.split("\n");
    const m = /^(GET|POST) (\/\S*) HTTP\/1\.1$/.exec(line);
    assert.ok(m, `not a request line: ${line}`);
    const headers = Object.fromEntries(headerLines.map((h) => [h.slice(0, h.indexOf(":")).trim(), h.slice(h.indexOf(":") + 1).trim()]));
    return { method: m[1], path: m[2], headers, body: body.join("\n\n").trim() };
  });
}

test("auth.md keeps what the authMd check reads", () => {
  const text = authMd();
  assert.equal(text.split("\n")[0], "# auth.md", "the check wants an H1 that contains auth.md");
  assert.match(text, /You are an agent/);
  const steps = [...text.matchAll(/^## Step (\d+) — /gm)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 3, "the check finds the flow by its Step headings, with an em-dash");
  assert.deepEqual(steps, steps.map((_, i) => i + 1), "steps are numbered 1, 2, 3 and so on");
  assert.match(text, /`api_key`/);
  assert.match(text, /Authorization: Bearer/);
  assert.match(text, /\banonymous\b/i, "the method an agent with its own Stellar key uses");
  // Methods skyhitz.io does not offer: naming one, even to say so, would make the check report it.
  for (const name of [/id-jag/i, /identity[ _-]assertion/i, /verified[ _-]email/i]) assert.doesNotMatch(text, name);
});

test("every request auth.md shows reaches a terminal route", async () => {
  const shown = requests(authMd());
  assert.ok(shown.length >= 5, "the flow is written as requests an agent can send");
  const deps = {
    db: testDb(),
    market: new Proxy({}, { get: () => async () => ({ rows: [] }) }),
    chain: () => {
      throw new Error("no chain in this test");
    },
    secret: "e".repeat(64),
    passphrase: Networks.PUBLIC,
    appUrl: "https://skyhitz.io",
    kv: fakeKv(),
    emailAccount: async () => null,
    horizonAccount: async () => null,
    send: async () => 200,
    cache: null,
    nowMs: NOW,
    waitUntil: () => {},
  };
  for (const r of shown) {
    assert.equal(r.headers.Host, "skyhitz.io");
    assert.ok(r.path.startsWith("/api/terminal/"), `${r.path}: only the terminal's requests are checked here`);
    // Placeholders such as <session> are for the agent to fill in: send the request without them.
    const headers = Object.fromEntries(Object.entries(r.headers).filter(([name, value]) => name !== "Host" && !value.includes("<")));
    const res = await handleTerminal(new Request(`https://skyhitz.io${r.path}`, { method: r.method, headers, body: r.method === "POST" ? r.body : undefined }), deps);
    assert.notEqual(res.status, 404, `${r.method} ${r.path}: ${await res.text()}`);
  }
});

test("auth.md states the challenge, the session and the key as the terminal makes them", async () => {
  const text = authMd();
  const { xdr, expires_at } = await buildChallenge(Keypair.random().publicKey(), "e".repeat(64), NOW, Networks.PUBLIC);
  const op = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC).operations[0];
  assert.ok(text.includes(`\`${op.name}\``), `agents are told to check that the operation is named ${op.name}`);
  assert.ok(text.includes(`${(expires_at - NOW) / 60_000} minutes`), "how long a challenge can be signed");
  const [cookie, ...attributes] = sessionCookie("t1.a.b").split("; ");
  assert.ok(text.includes(`Cookie: ${cookie.slice(0, cookie.indexOf("=") + 1)}`), "the session cookie's name");
  const maxAge = Number(attributes.find((a) => a.startsWith("Max-Age=")).slice("Max-Age=".length));
  assert.ok(text.includes(`${maxAge / 86_400} days`), "how long a session lasts");
  const { key } = newApiKey();
  assert.ok(text.includes(`\`htz_\` followed by ${key.length - "htz_".length} characters`), "the key's shape");
});

test("the plan auth.md buys comes with API keys", () => {
  const checkout = requests(authMd()).find((r) => r.path === "/api/terminal/checkout");
  assert.ok(checkout, "auth.md shows the checkout request");
  const { plan } = JSON.parse(checkout.body);
  assert.ok(PLANS[plan]?.apiKeys > 0, `the checkout example buys "${plan}", which makes no API keys`);
});
