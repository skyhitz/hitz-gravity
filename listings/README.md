# Listings

Where HITZ Protocol is listed outside skyhitz.io, and the exact files each
listing takes. Each section says what the listing gives us, what to submit
and how. Submissions to other projects' repositories are made from a fork of
that repository, with the file from this folder copied in as it is.

| Listing | Where it shows | Status |
| --- | --- | --- |
| [Official MCP Registry](#official-mcp-registry) | MCP clients and the directories that read the registry | Automatic: [`publish-mcp.yml`](../.github/workflows/publish-mcp.yml) |
| [DefiLlama](#defillama) | TVL, the Stellar chain page, the Dexs category | Pull request to DefiLlama |
| [Soroswap token list](#soroswap-token-list) | Soroban apps, and wallets such as Varial that mark listed tokens "Verified" | Two pull requests to Soroswap: remove the legacy HITZ, list the new one |
| [Stellar Expert directory](#stellar-expert-directory) | A name and tag on our contracts and accounts | Email to Stellar Expert |

House style: no em-dashes. Use commas or periods.

## Official MCP Registry

[`server.json`](../server.json) at the repo root describes the MCP server at
`https://skyhitz.io/mcp` as `io.github.skyhitz/hitz-vault`. The workflow
[`publish-mcp.yml`](../.github/workflows/publish-mcp.yml) publishes it to
https://registry.modelcontextprotocol.io whenever a push to main changes
`server.json`, signing in with GitHub Actions OIDC, so there is no secret to
store. It can also be run from the Actions tab.

- To publish a change, bump `version` in `server.json` and `SERVER_INFO.version`
  in `frontend/functions/api/mcp.ts` together (`tests/site-files.test.mjs`
  checks they match). The registry keeps every version and refuses one it
  already has.
- `description` is at most 100 characters (the registry's schema).
- Check the entry: https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.skyhitz/hitz-vault

## DefiLlama

[`defillama/index.js`](./defillama/index.js) is a TVL adapter: it reads the
vault's `pools()` view on-chain and adds each pool's reserves. Tested against
mainnet on November 16, 2026: 11,189.59 XLM, 1,226.49 USDC and 88.4M HITZ.

DefiLlama prices XLM and USDC but has no price for HITZ, so the TVL it shows
counts only the XLM and USDC side, about half of what skyhitz.io shows (which
values HITZ at the vault's own price).

**Submit**

1. Fork https://github.com/DefiLlama/DefiLlama-Adapters.
2. Copy `defillama/index.js` to `projects/hitz-protocol/index.js`.
3. `npm install`, then `node test.js projects/hitz-protocol/index.js`. It
   should print the XLM and USDC balances above.
4. Open a pull request. Its template asks for the details below.

| Field | Value |
| --- | --- |
| Name | HITZ Protocol |
| Website | https://skyhitz.io |
| Twitter | https://x.com/skyhitz |
| Logo | https://skyhitz.io/icon.png (180 × 180; send a larger square PNG or an SVG if they ask) |
| Short description | Oracle-free, protocol-owned liquidity on Stellar. The Sovereign Vault owns its pools (no LP shares, no withdrawals), follows the market through arbitrage instead of an oracle, and keeps part of every arbitrage profit as a fee. |
| Chain | Stellar |
| Category | Dexs |
| Token | HITZ, `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| CoinGecko / CoinMarketCap ID | None |
| Oracle | None: prices follow the market through arbitrage |
| Forked from | None |
| Audit links | Internal review only, no independent audit: https://docs.skyhitz.io/security/audit/ |
| Treasury address | `GCAETBNBFKVGLYFXKCLMKT6ZVHFXHRSDFSEW7ODIUJYC6R7H2QJ6OKGU` (the admin's account, a registered pool holding about 10M HITZ) |
| Methodology | Counts the reserves of every Sovereign Vault pool, read on-chain from the vault contract's pools() view. |
| GitHub | https://github.com/skyhitz |
| Documentation | https://docs.skyhitz.io/vault/integration/ |
| Referral program | No |

## Soroswap token list

Wallets read this list, not only Soroswap: Varial (SDF's wallet, formerly
Freighter) loads it by default and marks the tokens on it "Verified". Two
changes, in two separate pull requests from the fork `skyhitz/token-list`, so
the removal doesn't wait on the listing's review:

1. **Remove the legacy HITZ.** Branch `remove-legacy-hitz` deletes
   `assets/CBS5ZVKSSUKF4JY77CKUZPN72EDUM3OOGPYZKFC3KQVONXPJTF6UODD7.json` and
   nothing else. That contract is the Stellar Asset Contract of the classic
   `HITZ:GCAETBNB…OKGU`, listed in December 2025. Entries are keyed by
   contract, so a token can't be updated in place: Soroswap's CI drops a
   deleted file from `tokenList.json` after merge. Delisting changes no
   balance and no pool, only the "Verified" mark.
2. **List the new HITZ.** Branch `add-hitz-soroban` adds
   [`soroswap/CBAPZAZN…OY4EU.json`](./soroswap/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU.json).
   The name, symbol and decimals are the contract's own (`name()`, `symbol()`,
   `decimals()`). HITZ is a custom Soroban token, so the entry has no
   `issuer`, and `comment` (SEP-42's field for alerts a wallet can show)
   states the Event Horizon rule.

Both branches start from Soroswap's `main` and pass their gate (`yarn test`,
`yarn verify`). The new entry also validates against the SEP-42 asset-list
schema: wallets that check it reject a list with a bad entry.

On-chain state of the legacy asset, from Horizon on November 17, 2026: about
19.47M HITZ in trustlines, 99.7% of it in two frozen accounts, and every
holder above 1,000 HITZ frozen. Its issuer is unlocked (it is also the new
token's admin), with clawback enabled. `stellar.toml` marks the legacy entry
`status = "dead"` and gives it no `image`.

**What reviewers will ask.** Soroswap's review checklist says a token that
isn't a Stellar Asset Contract "requires a security audit on the Soroban
token code". Both contracts have had an internal review only (`AUDIT.md`);
the PR says so, and links the source and the review.

**What the listing doesn't do.** It gives the "Verified" mark, not trading:
Soroswap has no HITZ pairs and its aggregator can't reach the vault. A
Soroswap HITZ pair would be treated by the token like any other holder: once
it held more than L, buys from it and withdrawals from it would fail until it
was registered as a pool.

After opening the pull requests, post in Soroswap's Discord, as their README
asks.

## Stellar Expert directory

Stellar Expert shows a name and tags for addresses in its directory. Today
it has an entry only for the admin account, under its v1 name (`SkyHitz`,
tagged `issuer`). The directory takes requests by email, and its public
repository is gone.

`frontend/public/.well-known/stellar.toml` lists the three accounts below
under `ACCOUNTS`, so the domain vouches for them.

**Send** from support@skyhitz.io to info@stellar.expert:

> Subject: Directory entries for HITZ Protocol (skyhitz.io)
>
> Hello. We build HITZ Protocol on Stellar mainnet (https://skyhitz.io,
> https://docs.skyhitz.io). Could you add or update these directory entries?
> The accounts are listed in https://skyhitz.io/.well-known/stellar.toml, and
> both contracts are verified on Stellar Expert against their source.
>
> | Address | Name | Domain | Tags |
> | --- | --- | --- | --- |
> | `CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU` | HITZ Sovereign Vault | skyhitz.io | defi |
> | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` | HITZ token | skyhitz.io | defi |
> | `GCAETBNBFKVGLYFXKCLMKT6ZVHFXHRSDFSEW7ODIUJYC6R7H2QJ6OKGU` | Skyhitz (HITZ admin and treasury), today listed as "SkyHitz" | skyhitz.io | issuer |
> | `GDZACFEQZNHDEH4K3RQQWQNXZ5RIT4SNNJZJG6BROYNWMU567HT6BASD` | HITZ arbitrage bot | skyhitz.io | defi |
> | `GBER7ROBYH5NFFKXCDGTSMUKTDQ4U3MEUTUCPJRZZY6EYZVEFDBVNJNB` | HITZ email gateway sponsor | skyhitz.io | application |
>
> Thank you.

Check the result: `https://api.stellar.expert/explorer/directory?address[]=<address>`.
