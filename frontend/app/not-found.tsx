/**
 * 404. A page that says where things are, in place of a dead end: someone who
 * followed an old link (the Skyhitz v1 music platform lived on this domain)
 * should land one click from what they wanted.
 *
 * House style: no em-dashes. Use commas or periods.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { DOCS_URL, PROTOCOL_NAME } from "./lib/site";

export const metadata: Metadata = {
  title: `Page not found. ${PROTOCOL_NAME}`,
  description: "This page doesn't exist. Find the app, the whitepaper, the API and the docs from here.",
  robots: { index: false, follow: true },
};

const LINKS: [href: string, label: string, text: string][] = [
  ["/", "The app", "Swap HITZ, XLM and USDC in the Sovereign Vault."],
  ["/whitepaper/", "Whitepaper", "How the protocol provides liquidity without LPs or oracles."],
  ["/integrate/", "API and MCP server", "Trade from a bot, an app or an AI agent."],
  ["/terminal/", "HITZ Terminal", "XLM market, leverage and on-chain flow data."],
];

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center">
      <main className="max-w-xl mx-auto px-6 py-16 w-full">
        <p className="text-accent text-sm font-medium tracking-widest uppercase">404</p>
        <h1 className="text-3xl font-bold tracking-tight mt-2">This page doesn&apos;t exist</h1>
        <p className="text-muted mt-3 leading-relaxed">
          The link may be old: skyhitz.io is now the home of {PROTOCOL_NAME}, oracle-free, protocol-owned liquidity on
          Stellar. The music platform that lived here is archived.
        </p>
        <ul className="mt-8 divide-y divide-border-soft border-y border-border-soft">
          {LINKS.map(([href, label, text]) => (
            <li key={href}>
              <Link href={href} className="flex items-baseline justify-between gap-4 py-3 group">
                <span className="text-sm font-medium group-hover:text-accent transition-colors">{label}</span>
                <span className="text-xs text-muted text-right">{text}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted mt-6">
          Looking for the documentation? It is at{" "}
          <a href={`${DOCS_URL}/`} className="text-accent hover:underline">
            docs.skyhitz.io
          </a>
          , including{" "}
          <a href={`${DOCS_URL}/history/skyhitz-v1`} className="text-accent hover:underline">
            what happened to Skyhitz v1
          </a>
          .
        </p>
      </main>
    </div>
  );
}
