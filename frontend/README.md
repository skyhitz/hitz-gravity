# HITZ Frontend

Next.js 16 app (static export) + a Cloudflare Worker for the email-based
gas-sponsoring gateway. Deployed as a single Worker with the Static
Assets binding — Cloudflare's recommended successor to Pages.

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
```

## Deploy

```bash
pnpm build                    # next build → out/
npx wrangler deploy           # bundles worker + uploads assets
```

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

# 6. Fund that G-address with testnet XLM (Friendbot is fine for testnet)
curl "https://friendbot.stellar.org?addr=G..."

# 7. Create token used by /api/admin/legacy-reparation
npx wrangler secret put LEGACY_REPARATION_TOKEN

```

That's it. One secret, one funded account, and you're live.

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
| POST   | `/api/gateway/resolve`     | email → derived Stellar address                    |
| POST   | `/api/gateway/execute`     | Fee-bumped Soroban contract call ( session req. )  |
| POST   | `/api/gateway/notify`      | Mail a claim link to an email recipient            |
| POST   | `/api/admin/legacy-reparation` | Send legacy migration email with claim magic-link |
| GET    | `/api/gateway/sponsor`     | Ops — returns the gas-sponsor public key           |

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
- One-time bootstrap reserves (~1 XLM × 805 email rows): **~805 XLM**
- Operational buffer (fees + base reserve + slack): **~50 XLM**
- **Recommended sponsor XLM funding: ~4,565 XLM** (3,708 + 805 + 50)

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
   `+ ~1 XLM × email-row count` (one-time bootstrap reserves)
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
     the link and `/api/auth/verify` redeems the record (bootstrap + HITZ
     SAC transfer + optional XLM Payment, all inline within the verify
     request).
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
