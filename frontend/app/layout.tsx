import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { pageMetadata } from "./lib/seo";
import { HOME_DESCRIPTION, HOME_TITLE, ORG_NAME, PROTOCOL_NAME, SITE_URL } from "./lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The defaults every page starts from. Each page sets its own title,
// description and canonical URL with pageMetadata (lib/seo.ts); what is here
// is what they share, and what a page without metadata of its own falls back on.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  ...pageMetadata({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: "/" }),
  // No canonical by default: a page that forgot its own must not claim to be the home page.
  alternates: undefined,
  applicationName: PROTOCOL_NAME,
  authors: [{ name: ORG_NAME, url: SITE_URL }],
  creator: ORG_NAME,
  publisher: ORG_NAME,
  category: "finance",
  keywords: [
    "HITZ Protocol",
    "HITZ",
    "Sovereign Vault",
    "Skyhitz",
    "Stellar",
    "Soroban",
    "protocol-owned liquidity",
    "oracle-free",
    "automated market maker",
    "Event Horizon",
    "XLM",
    "USDC",
    "MCP server",
  ],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large", "max-video-preview": -1 },
  },
  // app/favicon.ico is linked by Next on its own; this adds the home-screen icon.
  icons: { apple: [{ url: "/icon.png", sizes: "180x180", type: "image/png" }] },
  // Numbers and addresses on these pages are contract ids and amounts, not phone numbers.
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
};

// No providers here: the wallet and protocol state belong to the app pages
// only, and are mounted by app/(app)/layout.tsx.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
