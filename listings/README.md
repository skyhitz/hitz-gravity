# Listings

Where HITZ Protocol is listed outside skyhitz.io, and the exact files each
listing takes. Each section says what the listing gives us, what to submit
and how. Submissions to other projects' repositories are made from a fork of
that repository, with the file from this folder copied in as it is.

| Listing | Where it shows | Status |
| --- | --- | --- |
| [Official MCP Registry](#official-mcp-registry) | MCP clients and the directories that read the registry | Automatic: [`publish-mcp.yml`](../.github/workflows/publish-mcp.yml) |
| [DefiLlama](#defillama) | TVL, the Stellar chain page, the Dexs category | Pull request to DefiLlama |
| [Soroswap token list](#soroswap-token-list) | Soroban apps and wallets that read the list | Pull request to Soroswap |
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

[`soroswap/CBAPZAZN…OY4EU.json`](./soroswap/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU.json)
is the entry for the HITZ token. The name, symbol and decimals are the
contract's own (`name()`, `symbol()`, `decimals()`), and the domain is the one
whose [stellar.toml](https://skyhitz.io/.well-known/stellar.toml) lists the
contract. HITZ is a custom Soroban token, so the entry has no `issuer`.

**Submit**

1. Fork https://github.com/soroswap/token-list.
2. Copy the file into `assets/`, keeping its name (the contract address).
3. `yarn`, then `yarn verify`. It fetches the icon and checks the fields.
4. Open a pull request that adds only that file: one that changes anything
   else is closed automatically. Then let the Soroswap team know on Discord,
   as their README asks.

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
