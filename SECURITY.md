# Reporting a security problem

If you have found a vulnerability in HITZ Protocol, please tell us privately
before telling anyone else, so it can be fixed before it can be used.

**Email [support@skyhitz.io](mailto:support@skyhitz.io)** with:

- what is affected (a contract, the web app, the API, the MCP server, the
  email gateway),
- how to reproduce it, or the reasoning that shows it,
- what someone could do with it.

Please don't open a public issue or pull request for a vulnerability, and
don't test against other people's accounts or funds. The contracts are live
on mainnet: a proof on testnet or in a unit test is enough.

## What is in scope

| Part | Where |
| --- | --- |
| The HITZ token contract | [`contracts/gravity-token`](./contracts/gravity-token) |
| The Sovereign Vault contract | [`contracts/sovereign-vault`](./contracts/sovereign-vault) |
| The web app, skyhitz.io | [`frontend/app`](./frontend/app) |
| The API, the MCP server and the email gateway | [`frontend/functions`](./frontend/functions) |
| The arbitrage bot | [`frontend/functions/_lib/arb.ts`](./frontend/functions/_lib/arb.ts) |

## What is already known

The internal review of both contracts, with every finding and its status, is
published in [`AUDIT.md`](./AUDIT.md), and the protocol's acknowledged
behaviors and limits in [`LEGAL.md`](./LEGAL.md) and section XII of the
[whitepaper](./WHITEPAPER.md). Neither contract has had an independent audit
yet. A report that restates one of those is still welcome if it shows a
consequence they don't.

The machine-readable version of this page is
[skyhitz.io/.well-known/security.txt](https://skyhitz.io/.well-known/security.txt).
