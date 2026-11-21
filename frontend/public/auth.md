# auth.md

Not an agent? The guide for people is https://skyhitz.io/integrate/, and the HITZ Terminal is at https://skyhitz.io/terminal/.

You are an agent. This document tells you which skyhitz.io APIs need a credential, how to register for one and how to use it. Follow the steps in order; do not skip ahead.

Endpoints live at `https://skyhitz.io`. Everything is HTTPS and JSON, on Stellar mainnet.

## Most of skyhitz.io needs no credential

Do not register for these:

- The vault API, `https://skyhitz.io/api/v1` (described at `https://skyhitz.io/api/v1/openapi.json`), and the MCP server, `https://skyhitz.io/mcp`: quote, build and submit HITZ swaps. Both are keyless and never see a secret key; the user signs in their own wallet.
- HITZ Terminal data on the Free plan: `GET https://skyhitz.io/api/terminal/data/<dataset>` with no credential answers with data an hour behind.

## What the credential is for

HITZ Terminal data on a paid plan: live XLM market, leverage and on-chain flow data from `GET /api/terminal/data/<dataset>`.

The credential is an API key (credential type `api_key`): `htz_` followed by 43 characters, sent as `Authorization: Bearer <key>`. A key reads data at its account's plan. It cannot pay, create keys or change webhooks; those take the account's session (Step 1).

API keys come with the Pro plan (3 keys) and the Institutional plan (10 keys). Prices, rate limits and what each plan sees: `GET https://skyhitz.io/api/terminal/plans`. Plans are paid in USDC or XLM, for 30 days or for a year (twelve periods for the price of ten).

## Supported registration methods

1. **Anonymous Stellar account.** For an agent that holds its own Stellar keypair. No email, no signup form and no account with skyhitz.io: the keypair is the account. You prove you control it by signing a challenge, pay for a plan from it and create a key. skyhitz.io never sees the secret key. There is no claim step: the account, its plan and its keys stay yours. Steps 1 to 5.
2. **User-delegated key.** The user creates a key in the HITZ Terminal, signed in with their own wallet or email account, and puts it in your environment. Step 6.

These are the only two. skyhitz.io runs no OAuth authorization server, so there is no `/.well-known/oauth-protected-resource` to read: this file is the whole description.

## Step 1 — Register: sign a challenge with your key

```http
POST /api/terminal/auth/challenge HTTP/1.1
Host: skyhitz.io
Content-Type: application/json

{"account": "G..."}
```

Response (200):

```json
{"xdr": "AAAA...", "expires_at": 1795000000000, "network_passphrase": "Public Global Stellar Network ; September 2015"}
```

`xdr` is a Stellar transaction from your account with sequence number 0, so it can never be submitted. Before signing, check that it has exactly one operation, a `manageData` named `skyhitz.io terminal sign-in`. Sign it with your account's key within 5 minutes (in JavaScript: `TransactionBuilder.fromXDR(xdr, network_passphrase)`, then `tx.sign(keypair)` and `tx.toXDR()`; every Stellar SDK has the same three steps) and send it back:

```http
POST /api/terminal/auth/verify HTTP/1.1
Host: skyhitz.io
Content-Type: application/json

{"account": "G...", "xdr": "<signed challenge>"}
```

Response (200): `{"account": "G...", "plan": "free"}` and your session, in a cookie:

```
Set-Cookie: hitz_terminal=t1....; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```

Keep the cookie's value and send it as `Cookie: hitz_terminal=<session>` in Steps 2, 3 and 5. It lasts 30 days; sign in again for a new one. A challenge works once.

The account does not need to exist on the network to sign in. To pay in Step 2 it must exist and hold the plan's price in USDC (with a USDC trustline) or XLM, plus XLM for fees. Keep using the same keypair: the plan and the keys belong to that account.

Signing in, and every request that uses a session, refuses an `Origin` header other than `https://skyhitz.io`. Server-side HTTP clients send none; do not add one.

## Step 2 — Pay for a plan

```http
POST /api/terminal/checkout HTTP/1.1
Host: skyhitz.io
Cookie: hitz_terminal=<session>
Content-Type: application/json

{"plan": "pro", "periods": 1, "asset": "USDC"}
```

`plan` is `pro` or `institutional`, the plans with API keys (`trader` has none); `periods` is `1` (30 days) or `12` (a year); `asset` is `USDC` or `XLM`. Response (200), abridged:

```json
{"checkout_id": "...", "pay": {"asset": "USDC", "amount": "99"}, "xdr": "AAAA...", "tx_hash": "...", "valid_until": "..."}
```

`xdr` is one swap in the HITZ Sovereign Vault, from your account: it sells `pay.amount` for HITZ sent to the HITZ treasury. Paying spends real funds, so unless you were told to subscribe, confirm the plan, the period and the amount with your user before signing. Sign it and send it back; skyhitz.io submits it and reads the payment from the chain:

```http
POST /api/terminal/checkout/confirm HTTP/1.1
Host: skyhitz.io
Cookie: hitz_terminal=<session>
Content-Type: application/json

{"id": "<checkout_id>", "xdr": "<signed swap>"}
```

When the answer's `status` is `paid`, `subscription.plan` and `subscription.until` say what you have. `pending` means the payment is not on chain yet: confirm again a few seconds later with `{"id": "<checkout_id>"}`. `expired` means start a new checkout. Paying for the same plan before it ends adds the time to it.

## Step 3 — Create the API key

```http
POST /api/terminal/keys HTTP/1.1
Host: skyhitz.io
Cookie: hitz_terminal=<session>
Content-Type: application/json

{"label": "my agent"}
```

Response (200):

```json
{"key": "htz_...", "prefix": "htz_...", "label": "my agent", "note": "Copy this key now: it is shown once. Send it as Authorization: Bearer <key>."}
```

`key` is your credential. It is returned exactly once, and skyhitz.io keeps only its SHA-256: store it (for example as `HITZ_TERMINAL_KEY`) and never log it. `prefix` names the key when you list or revoke it. Make one key per agent or project, so each can be revoked on its own.

## Step 4 — Use the credential

```http
GET /api/terminal/data/overview HTTP/1.1
Host: skyhitz.io
Authorization: Bearer <key>
```

Datasets: `overview`, `spreads`, `liquidations`, `liquidation_feed`, `leverage`, `books`, `flows`, `transfers`, `sdf`, `alerts`, `labels` and `status`. Series take `from` and `to` (an ISO date or time, or Unix seconds or milliseconds) and `resolution` (`1m`, `5m`, `1h` or `1d`); `liquidation_feed`, `transfers` and `alerts` take `limit` (up to 500), and `transfers` takes `min_xlm`. A request for more than the plan covers is narrowed and says so in `meta.limited`; a dataset the plan lacks is refused, naming the plan that has it. Every answer with data carries the `X-Terminal-Plan` header and a `license`: the data is for your own use, not for redistribution.

Read the key from your environment when you make the call. Do not echo it, log it, or put it in commit messages, error reports or screenshots.

## Step 5 — Revoke a key

```http
POST /api/terminal/keys/revoke HTTP/1.1
Host: skyhitz.io
Cookie: hitz_terminal=<session>
Content-Type: application/json

{"prefix": "<prefix>"}
```

Revoke a key you no longer need, or one that may have leaked, and create a new one in Step 3. `GET /api/terminal/me` with the session lists your plan, keys and payments.

## Step 6 — Get a key from the user

If you hold no Stellar key of your own, or the plan is the user's, the user makes the key:

1. Send them to https://skyhitz.io/terminal/. They sign in with their Stellar wallet (one signature) or their skyhitz.io email account.
2. If they have no Pro or Institutional plan, they choose one there and pay in USDC or XLM.
3. Under API keys they press New key, copy the key (it is shown once) and set it in your environment, for example as `HITZ_TERMINAL_KEY`.

Do not ask them to paste the key into the conversation, and never ask for a secret key or seed phrase. Read the key from the environment and use it as in Step 4. They revoke it on the same page.

## Revocation

A key stops working when it is revoked (Step 5, or by the user in the terminal) and pauses while its account has no plan with API keys. The answer tells you which: `401` with `invalid_key` means the key is unknown or revoked, so drop it and get a new one (Steps 1 to 3, or ask the user); `402` with `plan_required` means the plan ended, so pay for it again (Step 2) and the same key works again.

## Errors

Every error is JSON with a message and a code, `{"error": "<what happened>", "code": "<code>"}`, and some add a field the table names.

| Status | Code | What to do |
| --- | --- | --- |
| 400 | `invalid_account` | Send a Stellar account address (`G...`). |
| 401 | `bad_challenge`, `challenge_expired`, `challenge_used`, `not_signed` | Ask for a new challenge and sign it, unchanged, with the account's key. |
| 401 | `sign_in` | The session is missing or expired: sign in again (Step 1). |
| 401 | `invalid_key` | The key is malformed, unknown or revoked: drop it. |
| 402 | `plan_required` | The account has no plan with API keys: pay for one (Step 2). |
| 403 | `plan_required` | The dataset needs a higher plan, named in `upgrade`. |
| 403 | `session_required` | Keys, payments and webhooks take the session, not an API key. |
| 403 | `cross_site` | Send the request without an `Origin` header. |
| 409 | `too_many_keys` | Revoke a key first (Step 5). |
| 429 | `rate_limited` | Wait the `Retry-After` seconds, then retry. |
| 5xx | | Back off exponentially and retry the same request. |

Retry only `429` and `5xx`. For any other `4xx`, change the request as the table says. Signing in is limited to 20 requests per 10 minutes per IP address; data limits per plan are in `GET /api/terminal/plans`.
