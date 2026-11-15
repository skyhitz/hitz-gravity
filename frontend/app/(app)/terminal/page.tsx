/**
 * /terminal: the HITZ Terminal, XLM market, leverage and on-chain flow data (functions/_lib/terminal/
 * serves it; the page is a static shell that fetches at runtime).
 *
 * House style: no em-dashes. Use commas or periods.
 */
import type { Metadata } from "next";
import JsonLd from "../../components/JsonLd";
import TerminalApp from "../../components/terminal/TerminalApp";
import { ORG_ID, SITE_ID, breadcrumb, graph, organization, website } from "../../lib/schema";
import { pageMetadata } from "../../lib/seo";
import { OG_IMAGE, pageUrl } from "../../lib/site";

const PATH = "/terminal/";
const TITLE = "HITZ Terminal. XLM liquidations, DEX spreads and whale flows";
const DESCRIPTION =
  "Live XLM data: Stellar DEX against Kraken and Coinbase, liquidations across XLM perpetuals, order books, labeled whale and exchange flows, alerts and an API.";

export const metadata: Metadata = pageMetadata({ title: TITLE, description: DESCRIPTION, path: PATH });

const structuredData = graph(
  organization,
  website,
  {
    "@type": "WebApplication",
    "@id": `${pageUrl(PATH)}#app`,
    name: "HITZ Terminal",
    url: pageUrl(PATH),
    description:
      "Live XLM data for traders, funds and protocols: Stellar DEX against Kraken and Coinbase, liquidations across every XLM perpetual, order books, labeled whale and exchange flows, SDF supply, alerts and an API. Paid plans are paid in USDC or XLM through one Sovereign Vault swap that buys HITZ for the treasury.",
    image: OG_IMAGE.url,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    inLanguage: "en",
    isPartOf: { "@id": SITE_ID },
    provider: { "@id": ORG_ID },
  },
  breadcrumb("HITZ Terminal", PATH)
);

export default function TerminalPage() {
  return (
    <>
      <JsonLd data={structuredData} />
      <TerminalApp />
    </>
  );
}
