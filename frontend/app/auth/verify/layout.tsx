/**
 * The sign-in link's landing page (page.tsx, a client component, which can't
 * export metadata itself). Its URL carries a one-time token: it is no page
 * for a search index, and no crawler should follow a link to it.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Signing you in. HITZ Protocol",
  description: "Completes a sign-in from the link in your email.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function VerifyLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
