/**
 * About — the written part of the home page: what HITZ Protocol is, how the
 * loop works, the facts someone checks first, and the questions people ask.
 *
 * A server component, rendered below the app (components/HomeApp.tsx takes it
 * as children). The app above it is a tool: on its own it tells a first-time
 * visitor, a search engine or an AI system reading the HTML almost nothing.
 * This is where the page says what it is, in text that is in the HTML and
 * costs no JavaScript. The page's h1 is here.
 *
 * Every statement restates the whitepaper (WHITEPAPER.md). The questions come
 * from lib/faq.ts, which also feeds the FAQPage structured data.
 *
 * House style: no em-dashes. Use commas or periods.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { FAQS } from "../lib/faq";
import {
  DOCS_URL,
  GITHUB_URL,
  HITZ_CONTRACT,
  ORG_NAME,
  PROTOCOL_NAME,
  PROTOCOL_SUMMARY,
  TAGLINE,
  VAULT_CONTRACT,
  explorerContract,
} from "../lib/site";

const STEPS: { title: string; text: string }[] = [
  {
    title: "The protocol owns the liquidity.",
    text: "The vault keeps one constant-product pool per trusted asset, XLM and USDC today, against HITZ. The protocol seeded them, anyone can add to them at the pool's ratio, and nothing leaves them except swap outputs. There are no LP shares to redeem.",
  },
  {
    title: "Arbitrage replaces the oracle.",
    text: "When XLM moves against USDC elsewhere, the vault's rate between them falls behind until someone trades it back. Anyone can. Skyhitz runs an open-source bot that does it every five minutes from a public account.",
  },
  {
    title: "The fee keeps the arbitrage profit.",
    text: "Every hop pays 1%, rising exponentially to 10% while a trade leaves one asset dislocated against another, and the fee stays in the pool it was taken from. In a replay on five months of real Stellar DEX prices, the vault's fees were 67% to 89% of what the arbitrage made.",
  },
  {
    title: "Large balances flow back to the vault.",
    text: "The HITZ in the protocol's pools is Total Mass S, and L = √S is the most HITZ one account can hold and still send anywhere. Above L an account is vaulted: it can send HITZ only to a registered pool, such as by selling it into the vault, which adds to S.",
  },
];

/** A contract address, linked to its page on Stellar Expert. */
function Contract({ id }: { id: string }) {
  return (
    <a className="mono about-address" href={explorerContract(id)} target="_blank" rel="noopener noreferrer">
      {id}
    </a>
  );
}

const FACTS: [string, ReactNode][] = [
  ["Network", "Stellar mainnet (Soroban smart contracts)"],
  ["HITZ token", <Contract key="t" id={HITZ_CONTRACT} />],
  ["Sovereign Vault", <Contract key="v" id={VAULT_CONTRACT} />],
  ["Token standard", "SEP-41, 7 decimals"],
  ["Supply", "100,000,000 HITZ at most, fully minted"],
  ["Listed assets", "XLM and USDC (Circle), each in its own pool against HITZ"],
  ["Swap fee", "1% per hop when the vault is calm, up to 10% while one asset is dislocated against another"],
  ["Price source", "No oracle. Prices follow the market through arbitrage"],
  ["Liquidity", "Owned by the protocol. No LP shares, no withdrawals"],
  ["Changes", "Code upgrades and new listings wait 7 days in public"],
  ["Built by", ORG_NAME],
];

/** The text with each hyphenated word kept on one line: "protocol-owned" never breaks at its hyphen. */
function Unbroken({ text }: { text: string }) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <span key={i}>
          {i > 0 && " "}
          {word.includes("-") ? <span style={{ whiteSpace: "nowrap" }}>{word}</span> : word}
        </span>
      ))}
    </>
  );
}

/** Site paths go through the router; the API and other sites are plain links. */
function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  const isPage = href.startsWith("/") && !href.startsWith("/api/");
  return isPage ? <Link href={href}>{children}</Link> : <a href={href}>{children}</a>;
}

export default function About() {
  return (
    <section className="about" aria-labelledby="about-title">
      <p className="section-label">About</p>
      <h1 id="about-title">
        {PROTOCOL_NAME}: <Unbroken text={`${TAGLINE.charAt(0).toLowerCase()}${TAGLINE.slice(1)}`} />
      </h1>
      <p className="lede">{PROTOCOL_SUMMARY} Two contracts form a closed loop.</p>

      <div className="about-grid">
        <article className="about-card">
          <h2>The Sovereign Vault</h2>
          <p>
            HITZ&apos;s own exchange owns its liquidity: no LP shares, no withdrawals. Its prices follow the market
            through arbitrage instead of an oracle, and its fee keeps part of every arbitrage profit in its pools, so
            the liquidity compounds.
          </p>
        </article>
        <article className="about-card">
          <h2>The HITZ token</h2>
          <p>
            The token bounds concentration per account. An account holding more than the Event Horizon L = √S, where
            S is the HITZ in the protocol&apos;s pools, can send HITZ only back into a pool. L grows as the vault
            deepens.
          </p>
        </article>
      </div>

      <h2 id="how-it-works">How the loop works</h2>
      <ol className="about-steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong> {step.text}
          </li>
        ))}
      </ol>
      <p>
        The loop needs no price feed and no liquidity provider who can leave. What it needs is trading: arbitrage to
        keep the price honest, and flow for the fee to compound on. The{" "}
        <Link href="/whitepaper/">whitepaper</Link> has the derivation, the fee math and the evidence.
      </p>

      <h2 id="facts">Key facts</h2>
      <dl className="about-facts">
        {FACTS.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h2 id="questions">Questions</h2>
      <div className="faq">
        {FAQS.map((faq) => (
          <details key={faq.id} id={faq.id}>
            <summary>{faq.question}</summary>
            <p>
              {faq.answer}
              {faq.more && (
                <>
                  {" "}
                  <MoreLink href={faq.more.href}>{faq.more.label} →</MoreLink>
                </>
              )}
            </p>
          </details>
        ))}
      </div>

      <nav className="about-links" aria-label={`More about ${PROTOCOL_NAME}`}>
        <Link href="/whitepaper/">Whitepaper</Link>
        <a href={`${DOCS_URL}/`}>Documentation</a>
        <Link href="/integrate/">API and MCP server</Link>
        <Link href="/terminal/">HITZ Terminal</Link>
        <a href={`${DOCS_URL}/security/audit`}>Security review</a>
        <a href={`${DOCS_URL}/legal`}>Legal disclosure</a>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          Source code
        </a>
      </nav>
    </section>
  );
}
