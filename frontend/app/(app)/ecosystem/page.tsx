/**
 * Fullscreen Holder Ecosystem — opened from the Monitor tab's
 * "Open fullscreen ↗" link. Same live stage, edge to edge.
 */
import type { Metadata } from "next";
import HolderEcosystem from "../../components/ecosystem/HolderEcosystem";
import { pageMetadata } from "../../lib/seo";

// A canvas with no text of its own: it stays out of the search index and the
// sitemap. The same stage is on the home page's Monitor tab.
export const metadata: Metadata = pageMetadata({
  title: "HITZ holder ecosystem. Every account as a body in orbit",
  description: "Every HITZ account as a body in orbit around the Sovereign Vault, live from the Stellar ledger.",
  path: "/ecosystem/",
  index: false,
});

export default function EcosystemPage() {
  return <HolderEcosystem variant="fullscreen" />;
}
