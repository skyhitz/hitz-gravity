/**
 * Fullscreen Holder Ecosystem — opened from the Monitor tab's
 * "Open fullscreen ↗" link. Same live stage, edge to edge.
 */
import type { Metadata } from "next";
import HolderEcosystem from "../components/ecosystem/HolderEcosystem";

export const metadata: Metadata = {
  title: "HITZ Holder Ecosystem",
  description: "Every HITZ account as a body in orbit, live from the Stellar ledger.",
};

export default function EcosystemPage() {
  return <HolderEcosystem variant="fullscreen" />;
}
