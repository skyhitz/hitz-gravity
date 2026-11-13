/**
 * /terminal: the HITZ Terminal, XLM market, leverage and on-chain flow data (functions/_lib/terminal/
 * serves it; the page is a static shell that fetches at runtime).
 *
 * House style: no em-dashes. Use commas or periods.
 */
import type { Metadata } from "next";
import TerminalApp from "../components/terminal/TerminalApp";

export const metadata: Metadata = {
  title: "HITZ Terminal. XLM liquidations, DEX spreads and whale flows",
  description:
    "Live XLM data for traders, funds and protocols: Stellar DEX against Kraken and Coinbase, liquidations across every XLM perpetual, order books, labeled whale and exchange flows, SDF supply, alerts and an API.",
};

export default function TerminalPage() {
  return <TerminalApp />;
}
