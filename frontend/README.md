# HITZ Frontend

Next.js 16 app (static export) + a Cloudflare Worker for the email-based
gas-sponsoring gateway and the on-chain data cron. Deployed as a single
Worker with the Static Assets binding, Cloudflare's recommended successor
to Pages.

The app trades through the HITZ Sovereign Vault
(`CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU`): `app/lib/vault.ts`
talks to it, `app/lib/vaultMath.ts` is an exact port of its fee math (run
`node --experimental-strip-types scripts/check-vault-math.mjs` to replay the
contract's golden vectors against it), and `app/components/VaultSwap.tsx` /
`ReleaseCard.tsx` are the Trade tab and the sell-to-release card. The
Worker cron (`functions/_lib/ingest.ts`) turns the vault's events into the
Monitor's price and liquidity snapshots.

## Layout

```
app/                      Next.js App Router — all routes static ( output: "export" )
functions/worker.ts       Worker entrypoint — routes /api/auth/* and /api/gateway/*
functions/api/            Handlers (plain async (req, env) => Response)
functions/_lib/           Shared helpers (email, derive, jwt, stellar, …)
out/                      Build output ( created by `next build` )
wrangler.toml             Worker config ( assets + KV + send_email + vars )
```

Two tsconfigs: the root one for the Next app, `functions/tsconfig.json`
for the Workers runtime. ESLint ignores `functions/` (covered by the
functions tsconfig instead).

## Dev

```bash
pnpm dev            # next dev on :3000
pnpm build          # static export → out/
pnpm test           # Logic tests (Node 22.6+): gateway policy, rate limits, reserves, account records, recovery, jobs
```

## Deploy

Every push to `main` that touches `frontend/` deploys itself:
`.github/workflows/deploy-frontend.yml` runs the tests, builds, applies
pending D1 migrations and runs `wrangler deploy`. Start it by hand from the
Actions tab ("Deploy frontend", Run workflow) to redeploy `main`. It needs
two secrets in the repository's "Cloudflare" environment: `CLOUDFLARE_API_TOKEN`, a token from the "Edit
Cloudflare Workers" template with Account, D1, Edit added, and
`CLOUDFLARE_ACCOUNT_ID`.

The same steps from a machine:

```bash
pnpm build                                        # next build → out/
npx wrangler d1 migrations apply hitz-data --remote   # only when migrations/ changed
npx wrangler deploy                               # bundles worker + uploads assets
```

Apply new D1 migrations before deploying a Worker that reads the new
schema.

Single deploy ships the Worker and the static site together. The
`[assets]` binding in `wrangler.toml` points at `out/`, and the Worker
only runs for `/api/*` paths (via `run_worker_first`).

## One-time Cloudflare setup

The gateway depends on a KV namespace, the native `send_email` binding,
and a single secret. Everything else is deterministic:

```bash
# 1. KV namespace for magic-link tokens
npx wrangler kv namespace create MAGIC_LINKS
# → copy the returned id into wrangler.toml

# 2. Enable Email Routing on skyhitz.io (Cloudflare dashboard → Email →
#    Email Routing → Enable) and verify at least one destination address.
#    This is Cloudflare's gate for outbound send_email; without it the
#    binding refuses to deliver. Already done on skyhitz.io.

# 3. Generate a 32-byte master secret (keep this somewhere safe — rotating
#    it resets every derived user account AND the gas-sponsor address).
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'

# 4. Set it as a Worker secret
npx wrangler secret put MASTER_SECRET

# 5. Look up the gas-sponsor Stellar address (deterministic from MASTER_SECRET)
curl https://hitz.skyhitz.io/api/gateway/sponsor
#   → { "publicKey": "G..." }

# 6. Fund that G-address with XLM. It is a hot wallet behind public
#    endpoints: keep in it what a few weeks of use need (see "Gateway
#    guards" below) and let the low-balance alert ask for more.

# 7. Create token used by /api/admin/legacy-reparation
npx wrangler secret put LEGACY_REPARATION_TOKEN

```

That's it. One secret, one funded account, and you're live. Apply the D1
migrations too (`npx wrangler d1 migrations apply hitz-data --remote`): the
gateway's rate limits and account registry live there.

### What the secret produces

`MASTER_SECRET` (32+ bytes of hex) is domain-separated inside
`functions/_lib/derive.ts` into three independent materials:

| Derivation                             | Use                                   |
| -------------------------------------- | ------------------------------------- |
| `SHA-256("hitz:v1:users" ‖ master)`    | Root for per-email Stellar keypairs   |
| `SHA-256("hitz:v1:sponsor" ‖ master)`  | The gas-sponsor Stellar Keypair       |
| `SHA-256("hitz:v1:jwt" ‖ master)`      | HMAC key for session JWTs             |

Keys are computed once per Worker isolate and cached in memory.

## DNS / Email

Outbound mail uses Cloudflare's native `send_email` Workers binding — no
third-party service, no API key. Requirements on the sender domain
(`skyhitz.io`):

- Email Routing enabled on the zone
- At least one verified destination address
- SPF / DKIM records Cloudflare auto-provisions when Email Routing is
  turned on (nothing to do manually)

Configured in `wrangler.toml` as `[[send_email]] name = "SEND_EMAIL"` with
no destination restrictions so the gateway can mail arbitrary recipients
(magic links, claim notifications).

## Endpoints

| Method | Path                       | What it does                                       |
| ------ | -------------------------- | -------------------------------------------------- |
| POST   | `/api/auth/login`          | Email a single-use magic-link token                |
| GET    | `/api/auth/verify`         | Consume token → set session cookie                 |
| GET    | `/api/auth/me`             | Current session ( 401 if none )                    |
| POST   | `/api/auth/logout`         | Clear session cookie                               |
| POST   | `/api/gateway/resolve`     | email → derived Stellar address ( lookup only )    |
| POST   | `/api/gateway/execute`     | Fee-bumped transfer or vault swap ( session req. ) |
| POST   | `/api/gateway/notify`      | Mail a claim link for a transfer found on chain    |
| POST   | `/api/admin/legacy-reparation` | Send legacy migration email with claim magic-link |
| GET    | `/api/gateway/sponsor`     | Ops — returns the gas-sponsor public key           |

### Public vault API and MCP server

Keyless, CORS-open, for bots, apps and AI agents (`functions/api/v1.ts`,
`functions/api/mcp.ts`, logic in `functions/_lib/vault-api.ts`). Nothing
here holds a key: `POST /api/v1/swap` returns an unsigned transaction for the
caller's own account. The user-facing guide is the
[Integrate page](https://skyhitz.io/integrate/) (`app/integrate/`), and
`/sign` (`app/components/SignTransaction.tsx`) signs a built swap with the
user's wallet.

| Method | Path                       | What it does                                       |
| ------ | -------------------------- | -------------------------------------------------- |
| GET    | `/api/v1/vault`            | Pools, prices, fees, USD values, the Event Horizon |
| GET    | `/api/v1/quote`            | Exact quote (`sell`, `buy`, `amount` or `buy_amount`, optional `account`) |
| POST   | `/api/v1/swap`             | Unsigned, simulated swap transaction (base64 XDR) and sign links |
| POST   | `/api/v1/submit`           | Relays a signed vault transaction, waits for the result |
| GET    | `/api/v1/tx`               | Transaction status, swap decoded                   |
| GET    | `/api/v1/account`          | Balances, trustlines, room under the Event Horizon |
| GET    | `/api/v1/openapi.json`     | OpenAPI 3.1 description                            |
| GET    | `/api/v1/bot`              | Our arbitrage bot: address, mode, last run, totals, recent trades |
| POST   | `/mcp`                     | MCP server (Streamable HTTP, stateless): `get_vault`, `get_account`, `quote`, `build_swap`, `submit_transaction`, `get_transaction` |

Quotes run `app/lib/vaultMath.ts` (the exact port of the contract math) on
`pools()`, and `swap` simulates the transaction it returns, so both match
the contract to the stroop. USD values come from the cron's liquidity
snapshot. `/mcp` is listed in `run_worker_first` next to `/api/*`.

### Arbitrage bot

Skyhitz's own vault/SDEX arbitrage runs in the Worker on a second cron
(`2-59/5 * * * *`): `functions/_lib/arb.ts` is the strategy and its two legs
(the SDEX buy-back first, then the vault swap), `functions/_lib/arb-ops.ts`
the cron run around it (D1 log in `arb_runs`, guards, alerts, status),
`functions/_lib/arb-worker.ts` the Worker's bindings, and
`scripts/arb-bot.mjs` runs the same strategy from Node for anyone.
`ARB_BOT_MODE` (`off` / `dry-run` / `live`) and `ARB_BOT_ADDRESS` are vars;
the key is a secret (`npx wrangler secret put ARB_BOT_SECRET`);
`ARB_BOT_MIN_PROFIT_XLM` and `ARB_BOT_MAX_TRADE_XLM` are optional overrides.

Before changing the bot's live path, run `pnpm test` (it trades against a
simulated network in `tests/arb.test.mjs` and `tests/arb-ops.test.mjs`) and
`node --experimental-strip-types scripts/arb-testnet-rehearsal.mjs` (it trades
for real on testnet). `scripts/arb-replay.mjs` replays the planner on past
SDEX prices. Strategy, numbers, limits and guards:
[`ARB_BOT.md`](./ARB_BOT.md).

### HITZ Terminal

XLM market, leverage and on-chain flow data, sold by plan at
[skyhitz.io/terminal](https://skyhitz.io/terminal/) (`app/terminal/`,
`app/components/terminal/`) and as an API under `/api/terminal/*`
(`functions/api/terminal.ts`, logic in `functions/_lib/terminal/`).

- **Data:** read on every request from the data worker's read-only
  `MarketData` entry point through the `MARKET` service binding
  (`wrangler.toml`). Nothing it returns is stored here; free answers are
  edge-cached for a minute, paid ones never.
- **Plans** (`plans.ts`, the one table the page, the gate and checkout
  read): Free (an hour behind), Trader $29, Pro $99 (API keys),
  Institutional $499, per 30 days; a year costs ten periods. `gate.ts`
  turns a plan and a query into the exact call: datasets, delay, history,
  bins, sizes.
- **Payment:** `POST /api/terminal/checkout` builds one vault swap selling
  USDC or XLM for HITZ sent to the treasury (the token's admin, a
  registered pool, checked on chain; `TERMINAL_TREASURY` overrides it).
  `POST /api/terminal/checkout/confirm` reads the paying transaction and
  checks what it did, so a fee bump or the email gateway's own transaction
  pays too; a transaction pays one checkout once. Purchases are an
  append-only ledger (`terminal_purchases`) folded into the current plan by
  `billing.ts`; the cron confirms payments whose page was closed.
- **Access:** wallets sign a challenge transaction that can never be
  submitted (sequence 0, an HMAC'd nonce burnt after use); email accounts
  use their session. API keys (`htz_…`) are shown once and stored as
  SHA-256; a key reads data and cannot pay, make keys or change webhooks.
- **Alerts:** the cron pushes each alert once to every paying subscriber's
  webhooks, signed `X-Skyhitz-Signature: t=…,v1=…` (HMAC-SHA256 of
  `t.body`) with a per-webhook secret derived from `MASTER_SECRET`.

| Method | Path | What it does |
| ------ | ---- | ------------ |
| GET  | `/api/terminal/plans` | Plans, prices, what each sees (public) |
| GET  | `/api/terminal/data/<dataset>` | `overview`, `spreads`, `liquidations`, `liquidation_feed`, `leverage`, `books`, `flows`, `transfers`, `sdf`, `alerts`, `labels`, `status` |
| GET  | `/api/terminal/me` | The caller's plan, keys, webhooks, payments |
| POST | `/api/terminal/auth/challenge`, `/auth/verify`, `/auth/logout` | Wallet sign-in |
| POST | `/api/terminal/checkout`, `/checkout/confirm` | Pay for a plan |
| POST | `/api/terminal/keys`, `/keys/revoke` | API keys |
| POST | `/api/terminal/webhooks`, `/webhooks/delete`, `/webhooks/test` | Alert webhooks |

Deploy the data worker first (the binding calls its methods by name), then
`npx wrangler d1 migrations apply hitz-data --remote` (migration
`0006_terminal.sql`), then this Worker. `tests/terminal-*.test.mjs` run
whole requests, payments and deliveries against SQLite with the real
migrations.

## Gateway guards

The sponsor is a hot wallet behind public endpoints, so the gateway is built
to give nothing away and to bound what anyone can make it spend.

- **No gifts.** An email account is created with a zero balance. The sponsor
  holds its reserve (1 XLM, and 0.5 XLM more for a USDC trustline) and pays
  its fees; that XLM is locked, not spent, and comes back when the account is
  merged. Every account the gateway creates, and every trustline it sponsors
  for an account it didn't create, is recorded in D1 first
  (`gateway_accounts`, with the digest the account's key derives from;
  `functions/_lib/gateway-accounts.ts`), so the Worker can always open the
  account again.
- **Accounts only when needed.** Signing in and resolving an email create
  nothing. An account is created the first time its owner makes a call that
  simulates successfully (they have something to move), or claims a legacy
  reparation. The USDC trustline is added the first time they swap into USDC.
  HITZ can be sent to an email that has no account: its balances live in the
  token contract. So can 1 XLM or more, which opens the account with the
  sender's XLM. USDC needs the recipient's trustline first.
- **`execute` is an allowlist** (`functions/_lib/gateway-policy.ts`): a
  `transfer` of the account's own HITZ, XLM or USDC, or a vault `swap` of its
  own funds. The simulation must need no signature but the account's own, and
  its resource fee must be under 0.5 XLM. The sponsor's fee bid is 0.001 XLM
  per operation.
- **`notify` needs the transfer.** It mails a claim link only for a recent,
  successful transfer to the address derived from that email, once per
  transfer, and takes the amount and asset from the transaction.
- **Rate limits** in D1 (`functions/_lib/limits.ts`), per caller address
  (an IPv6 /64 counts as one), per email or account, and overall:

  | What | Per caller / email / account | Overall |
  |---|---|---|
  | Sign-in emails | 5 per 10 min and 30 a day per address; 3 per 10 min and 10 a day per email | 300 an hour |
  | Claim emails | 10 requests an hour per address; 5 emails a day per recipient | 200 an hour |
  | Lookups (`resolve`) | 60 per 10 min per address | |
  | Sponsored transactions | 30 attempts an hour and 100 a day per account | 500 sent a day |
  | New email accounts | 5 a day per address | `GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY` (30) |

  The caller's own limits are checked first, and a request they refuse is
  not counted against the overall ones, so one caller can't use up what
  everyone shares. The overall totals are charged only for what is really
  done: a claim email for a transfer found on chain, a transaction that
  simulated successfully.

- **A floor.** Below `GATEWAY_MIN_SPONSOR_XLM` (5) of spendable XLM the
  sponsor stops sponsoring and `execute` answers 503.
- **Alerts** to `SUPPORT_EMAIL`, at most one a day each, from the cron: the
  sponsor's *spendable* balance under `LOW_BALANCE_THRESHOLD_XLM` (50), 15 or
  more new email accounts in 24 hours, and an overall limit being reached.

### Operator jobs

Privileged actions on the sponsor are not HTTP endpoints. They are rows in D1
(`admin_jobs`) that the cron runs one at a time and writes the result back
to (`functions/_lib/admin-jobs.ts`, `sponsor-ops.ts`):

```bash
npx wrangler d1 execute hitz-data --remote --command \
  "INSERT INTO admin_jobs (command) VALUES ('{\"type\":\"recovery-plan\"}')"
npx wrangler d1 execute hitz-data --remote --command \
  "SELECT id, status, result FROM admin_jobs ORDER BY id DESC LIMIT 3"
```

| Job | What it does |
|---|---|
| `{"type":"recovery-plan"}` | Counts the email accounts that were never used and whose reserve the sponsor can take back (`functions/_lib/recovery.ts`). Sends nothing. |
| `{"type":"recovery-run","limit":N}` | Revokes the sponsorship of up to N (99 at most) of those accounts and pays the XLM that frees to the HITZ contract's admin, in one transaction. |

## Legacy Reparation Campaign (one-time run)

The campaign runs a **lazy claim** flow: emails kick off magic links, and the
payouts only move when a user actually clicks. Un-claimed rows cost zero
on-chain.

The v6+ campaign (`reparation_program_v6_xlm_49.csv`) splits each user's
payout across two assets:
- **HITZ** via SAC `transfer(sponsor → user)` (Soroban tx)
- **XLM** via classic native `Payment(sponsor → user)` (separate tx — Soroban
  + classic ops cannot share a transaction)

The two legs are submitted sequentially with per-leg hash tracking. A
partial failure (HITZ landed, XLM didn't) is safe: retries skip any leg
whose hash is already persisted.

### Campaign totals (v6 — `reparation_program_v6_xlm_49.csv`)

- Total rows: **825** (805 email rows + 20 on-chain rows)
- HITZ pool to fund the sponsor: **46,149.3881937 HITZ**
- XLM payouts to fund the sponsor: **3,708.0183674 XLM**
- Account reserves (1 XLM locked per email row that claims, 805 at most;
  sponsored, not given away): **up to ~805 XLM**
- Operational buffer (fees + base reserve + slack): **~50 XLM**
- **Sponsor XLM if every row claimed: ~4,565 XLM** (3,708 + 805 + 50). Claims
  are lazy, so fund what the next weeks need and top up on the alert, rather
  than parking it all in the hot wallet.

The 20 on-chain rows in the v6 CSV have `reparation_xlm_amount = 0`, so the
on-chain branch only sends HITZ for those rows. (Only the email-magic-link
branch needs bootstrap reserves.)

### Pre-flight (run once before sending any emails)

The sponsor account holds the entire reparation pool. Two on-chain ops the
contract admin runs from a wallet (these are NOT in code, do them by hand):

1. **Register the sponsor as a router on the HITZ contract.** Routers are
   exempt from vault rules as senders and don't affect TotalMass, so the
   sponsor can hold the pool without becoming Vaulted.

   ```
   register_router_address(<sponsor G-address>)
   ```

2. **Transfer the full HITZ reparation pool to the sponsor.**

   ```
   transfer(admin, <sponsor>, 46149.3881937)
   ```

3. **Fund sponsor XLM.** Required total =
   `sum(reparation_xlm_amount)` (user payouts)
   `+ 1 XLM × email rows that claim` (account reserves, locked not spent)
   `+ buffer` (fees + base reserve + slack).

   For the v6 CSV: **~4,565 XLM** total. Sponsor address comes from
   `GET /api/gateway/sponsor`.

4. **Set operator notification config.** The sponsor will email
   `SUPPORT_EMAIL` on every successful claim (HITZ + XLM legs both shown
   in the notification) and once per 24h when XLM drops below
   `LOW_BALANCE_THRESHOLD_XLM` (defaults to "50"). Both are declared in
   `wrangler.toml` `[vars]`; override either by editing the file before
   `wrangler deploy`.

### Run the campaign

1. Pass the v6 CSV via `--file /Users/alejomendoza/Desktop/reparation_program_v6_xlm_49.csv`
   (or your own path). Leading title lines without commas are auto-skipped;
   the parser locates the header by the first comma-bearing line.
2. Script behavior:
   - **email present:** POST `{ email, amount, xlmAmount? }` to the admin
     endpoint. Endpoint records a pending reparation in KV (1-year TTL) and
     sends the magic-link email. Both legs move only when the user clicks
     the link and `/api/auth/verify` redeems the record (account creation,
     sponsored and with a zero balance, + HITZ transfer + optional XLM
     Payment, all inline within the verify request).
   - **email empty:** transfer `new_hitz_amount` HITZ directly from the
     sponsor to `publicKey`, then (if `reparation_xlm_amount > 0`) submit
     a separate native Payment for the XLM amount. Both require the
     classic account to already exist on-chain. Driven by `--sponsor-secret`.
3. Dry run the full campaign (no network calls, but still validates that
   every row parses cleanly):
   ```bash
   pnpm send:legacy-reparation -- \
     --file /Users/alejomendoza/Desktop/reparation_program_v6_xlm_49.csv \
     --endpoint https://skyhitz.io/api/admin/legacy-reparation \
     --token "$LEGACY_REPARATION_TOKEN" \
     --contract-id "$HITZ_CONTRACT_ID" \
     --rpc-url "https://soroban-mainnet.stellar.org" \
     --network-passphrase "Public Global Stellar Network ; September 2015" \
     --sponsor-secret "$SPONSOR_SECRET" \
     --dry-run
   ```
4. Live run (drop `--dry-run`):
   ```bash
   pnpm send:legacy-reparation -- \
     --file /Users/alejomendoza/Desktop/reparation_program_v6_xlm_49.csv \
     --endpoint https://skyhitz.io/api/admin/legacy-reparation \
     --token "$LEGACY_REPARATION_TOKEN" \
     --contract-id "$HITZ_CONTRACT_ID" \
     --rpc-url "https://soroban-mainnet.stellar.org" \
     --network-passphrase "Public Global Stellar Network ; September 2015" \
     --sponsor-secret "$SPONSOR_SECRET"
   ```
5. Optional throttling (defaults to 250 ms between rows):
   ```bash
   pnpm send:legacy-reparation -- ... --delay-ms 500
   ```

### Idempotency / retry

- Magic-link tokens are single-use: re-clicking a link that already
  redeemed is a no-op.
- Reparation records persist for 1 year. If redemption fails on first
  click (e.g. transient RPC error), the record stays `pending`/`failed`
  with whatever per-leg hashes already landed (`txHash` for HITZ,
  `xlmTxHash` for XLM). The user can retry by logging in again via
  `/api/auth/login`; verify re-runs redemption and skips any leg whose
  hash is already persisted, so retries never double-pay.
- Re-running the script's email branch with the same CSV is safe; the
  admin endpoint overwrites the pending record with the latest amounts.
- Re-running the on-chain branch is **not** idempotent (no record to
  short-circuit on). If the script crashes mid-loop, the standard fix
  is to remove already-paid rows from the CSV before re-running.

## Connection modes

The UI supports two interchangeable connection types:

- **Wallet** — Stellar Wallets Kit. Users sign locally; fees paid in XLM
  from their own account.
- **Email** — Magic-link sign-in. The Worker derives a Stellar keypair
  from the email + MASTER_SECRET, signs on the user's behalf, and wraps
  the tx in a FeeBumpTransaction paid by the sponsor. Users never hold
  XLM or see a seed phrase.

`callContract(contractId, method, args)` in `WalletContext` routes
transparently to whichever mode is active. Components don't branch on
connection type — they just call it.

### Soroban TTL — transparent state restoration

Soroban persistent storage has a ~30 day TTL. State belonging to a user
who has been dormant for that long is **archived** to cold storage and
can't be read or written without first submitting a `RestoreFootprintOp`.

Both paths handle this inline:

- **Email (custodial):** `prepareContractCall` in
  `functions/_lib/stellar.ts` inspects `simulateTransaction`'s
  `restorePreamble`. If present, it submits a sponsor-signed restore tx
  (the sponsor pays, since `RestoreFootprintOp` doesn't require Soroban
  auth from the data owner) and re-simulates before assembling the real
  call.
- **Wallet (non-custodial):** `restoreArchivedState` in
  `app/lib/stellar.ts` performs the equivalent restore, signed and paid
  by the user via Stellar Wallets Kit — one extra signature prompt.

No scenario component, page, or hook branches on archival. A dormant
holder clicking Send after 90 days sees the same flow as a daily user.
