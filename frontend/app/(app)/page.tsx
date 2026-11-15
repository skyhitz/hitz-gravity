/**
 * Home. The app (components/HomeApp.tsx, a client component) with the written
 * part of the page (components/About.tsx, a server component) passed into it,
 * and the structured data that describes both.
 *
 * House style: no em-dashes. Use commas or periods.
 */

import type { Metadata } from "next";
import About from "../components/About";
import HomeApp from "../components/HomeApp";
import JsonLd from "../components/JsonLd";
import { FAQS } from "../lib/faq";
import { ORG_ID, SITE_ID, graph, organization, website } from "../lib/schema";
import { pageMetadata } from "../lib/seo";
import { HOME_DESCRIPTION, HOME_TITLE, OG_IMAGE, PROTOCOL_NAME, SITE_URL } from "../lib/site";

export const metadata: Metadata = pageMetadata({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: "/" });

const structuredData = graph(
  organization,
  website,
  {
    "@type": "WebApplication",
    "@id": `${SITE_URL}/#app`,
    name: PROTOCOL_NAME,
    url: `${SITE_URL}/`,
    description: HOME_DESCRIPTION,
    image: OG_IMAGE.url,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript and a Stellar wallet or an email address.",
    isAccessibleForFree: true,
    inLanguage: "en",
    isPartOf: { "@id": SITE_ID },
    provider: { "@id": ORG_ID },
    featureList: [
      "Swap HITZ, XLM and USDC in the Sovereign Vault",
      "Trade with a Stellar wallet or an email account",
      "Live Total Mass, Event Horizon and vault fees",
      "Keyless HTTP API and MCP server for bots and AI agents",
    ],
  },
  {
    "@type": "FAQPage",
    "@id": `${SITE_URL}/#questions`,
    isPartOf: { "@id": SITE_ID },
    mainEntity: FAQS.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  }
);

export default function HomePage() {
  return (
    <>
      <JsonLd data={structuredData} />
      <HomeApp>
        <About />
      </HomeApp>
    </>
  );
}
