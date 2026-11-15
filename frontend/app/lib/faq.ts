/**
 * faq.ts: the questions answered on the home page.
 *
 * One list feeds both the visible section (components/About.tsx) and the
 * FAQPage structured data, so what a search engine or an assistant quotes is
 * word for word what the page shows.
 *
 * Every answer restates the whitepaper (WHITEPAPER.md): change a fact there
 * first, then here. Figures that move are given with their date and where
 * the live value is. Answers are plain text, because structured data can't
 * carry markup.
 *
 * House style: no em-dashes. Use commas or periods.
 */

export interface Faq {
  /** Anchor on the home page: /#<id>. */
  id: string;
  question: string;
  answer: string;
  /** Where the long answer is. */
  more?: { label: string; href: string };
}

export const FAQS: Faq[] = [
  {
    id: "what-is-hitz-protocol",
    question: "What is HITZ Protocol?",
    answer:
      "HITZ Protocol is an oracle-free financial primitive on Stellar (Soroban), built by Skyhitz. Its goal is to solve liquidity provisioning without depending on outside capital (mercenary LPs) or outside price feeds (oracles). Two contracts form a closed loop: the Sovereign Vault, HITZ's own exchange, which owns its liquidity, and the HITZ token, which bounds how much one account can hold and still move freely.",
    more: { label: "Read the whitepaper", href: "/whitepaper/" },
  },
  {
    id: "no-oracle",
    question: "How does the Sovereign Vault set prices without an oracle?",
    answer:
      "The vault reads no price feed. It keeps one constant-product pool per trusted asset, XLM and USDC today, each against HITZ. When the market moves, the vault's rate falls behind until someone trades it back, and anyone can. Skyhitz runs an open-source arbitrage bot that does it every five minutes from a public account, paying the same fees as everyone.",
    more: { label: "The arbitrage bot", href: "https://docs.skyhitz.io/vault/arbitrage-bot" },
  },
  {
    id: "swap-fee",
    question: "What does a swap cost?",
    answer:
      "Each hop through a pool pays 1% when the vault is calm. The fee rises exponentially, up to 10%, while a trade leaves one asset dislocated against another, and falls back to 1% on its own with a 2-hour time constant. HITZ to XLM or USDC is one hop. XLM to USDC is two hops through HITZ in one call. The fee stays in the pool it was taken from, so the liquidity compounds. The swap screen shows the fee before you sign.",
    more: { label: "The fee math", href: "https://docs.skyhitz.io/vault/integration" },
  },
  {
    id: "event-horizon",
    question: "What is the Event Horizon?",
    answer:
      "The Event Horizon, L, is the most HITZ one account can hold and still send anywhere. It is the square root of Total Mass S, the HITZ held by the protocol's registered pools: L = √S in whole HITZ. In November 2026 S is about 98.4 million HITZ and L about 9,900 HITZ. L grows as the vault deepens. The live value is in the vault endpoint of the public API, as hitz.event_horizon.",
    more: { label: "Live vault numbers", href: "/api/v1/vault" },
  },
  {
    id: "vaulted",
    question: "What happens when an account is vaulted?",
    answer:
      "An account holding more than L is vaulted: it can send HITZ only to a registered pool, such as by selling it into the Sovereign Vault. Incoming transfers never fail, so a purchase can take an account past L. The account is released as soon as its balance is back under L, by selling into the vault or because the vault grew. At November 2026 prices L is worth about $0.32, so almost any purchase vaults the buyer. The swap screen says so before you sign. The limit is per account, not per person.",
  },
  {
    id: "no-withdrawals",
    question: "Can liquidity be withdrawn from the vault?",
    answer:
      "No. The vault has no LP shares and no withdrawals. The protocol seeded each pool, anyone can deposit at a pool's current ratio as a contribution, and nothing leaves the vault except swap outputs. The liquidity HITZ trades against can't be pulled.",
  },
  {
    id: "how-to-trade",
    question: "How do I trade HITZ?",
    answer:
      "On skyhitz.io, connect a Stellar wallet such as Freighter, xBull, Albedo or LOBSTR, or sign in with an email address. An email account is derived from your address, the gateway signs for it, and a sponsor pays the network fees. Either way you can swap between HITZ, XLM and USDC in the Sovereign Vault.",
  },
  {
    id: "bots-and-agents",
    question: "Can a bot or an AI agent trade HITZ?",
    answer:
      "Yes. A keyless HTTP API at skyhitz.io/api/v1 quotes trades and builds unsigned swap transactions, and an MCP server at skyhitz.io/mcp gives AI agents the same tools: get_vault, get_account, quote, build_swap, submit_transaction and get_transaction. Neither ever holds a key. The user signs with their own wallet.",
    more: { label: "API and MCP server", href: "/integrate/" },
  },
  {
    id: "admin-powers",
    question: "Who controls the contracts?",
    answer:
      "One admin account, which is also the treasury, administers both contracts. Code upgrades and new asset listings take effect only after a public 7-day notice. The admin can register or remove pools and routers on the token at once, which exempts an address from the Event Horizon or changes S. Each contract has a one-way exit that ends these powers for good.",
    more: { label: "Admin, timelocks and decentralization", href: "/whitepaper/#admin-timelocks-and-decentralization" },
  },
  {
    id: "audit",
    question: "Has HITZ Protocol been audited?",
    answer:
      "Both contracts have been reviewed internally, and the findings and their status are published. Neither has had an independent audit yet. Both are verified on Stellar Expert against their source.",
    more: { label: "Security review", href: "https://docs.skyhitz.io/security/audit" },
  },
  {
    id: "supply",
    question: "What is the supply of HITZ?",
    answer:
      "At most 100,000,000 HITZ, with 7 decimals. The ceiling is compiled into the token contract and the supply is fully minted. On November 13, 2026 the Sovereign Vault's pools held 88.4% of it and the treasury 10.0%.",
  },
  {
    id: "known-limits",
    question: "What are the known limits?",
    answer:
      "Without an oracle the vault's price follows the market only as fast as arbitrage moves it. Liquidity is thin, about $5,800 in November 2026: large trades move the price far, and at that depth a purchase of $20 or more paid the fee at its 10% cap. L is small today. A listed asset carries its issuer's risk: Circle can freeze the vault's USDC. Admin powers remain until renounced.",
    more: { label: "Legal disclosure", href: "https://docs.skyhitz.io/legal" },
  },
];
