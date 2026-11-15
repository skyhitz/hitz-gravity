/**
 * site.ts: the names, addresses and URLs that the pages, their metadata and
 * their structured data share, so a search result, a link preview, the
 * sitemap and the page itself can't say different things.
 *
 * No imports: safe to use from server components, client components and
 * build-time route files alike.
 *
 * House style: no em-dashes. Use commas or periods.
 */

export const SITE_URL = "https://skyhitz.io";
export const DOCS_URL = "https://docs.skyhitz.io";
export const GITHUB_URL = "https://github.com/skyhitz/hitz-gravity";
export const GITHUB_ORG_URL = "https://github.com/skyhitz";
export const X_URL = "https://x.com/skyhitz";
export const X_HANDLE = "@skyhitz";
export const SUPPORT_EMAIL = "support@skyhitz.io";

/** The protocol is what the site is about; Skyhitz is who builds it. */
export const PROTOCOL_NAME = "HITZ Protocol";
export const ORG_NAME = "Skyhitz";
export const TAGLINE = "Oracle-free, protocol-owned liquidity on Stellar";

export const HOME_TITLE = `${PROTOCOL_NAME}. ${TAGLINE}`;
/** Under 160 characters, so a search result shows all of it. */
export const HOME_DESCRIPTION =
  "Swap HITZ, XLM and USDC in the Sovereign Vault on Stellar: liquidity the protocol owns, priced by arbitrage with no oracle. Wallet, email, API or MCP.";

/** The goal, in the whitepaper's own words. */
export const PROTOCOL_SUMMARY =
  "HITZ Protocol is an oracle-free financial primitive on Stellar (Soroban). Its goal is to solve liquidity provisioning without depending on outside capital (mercenary LPs) or outside price feeds (oracles).";

/** Link-preview image, 1200 × 630 (public/og.png, drawn by scripts/og-image.mjs). */
export const OG_IMAGE = {
  url: `${SITE_URL}/og.png`,
  width: 1200,
  height: 630,
  alt: `${PROTOCOL_NAME}: ${TAGLINE.charAt(0).toLowerCase()}${TAGLINE.slice(1)}`,
  type: "image/png",
} as const;

/** Mainnet contracts. The same values as lib/stellar.ts and lib/vault.ts, which tests/site.test.mjs checks. */
export const HITZ_CONTRACT = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
export const VAULT_CONTRACT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";

export const explorerContract = (id: string) => `https://stellar.expert/explorer/public/contract/${id}`;

/** A page's full URL, with the trailing slash every page is served at (next.config.ts). */
export function pageUrl(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return clean ? `${SITE_URL}/${clean}/` : `${SITE_URL}/`;
}

/**
 * The pages a search engine should index, in the order the sitemap lists
 * them. Pages that only make sense mid-task (/sign, /auth/verify) and the
 * canvas-only /ecosystem are left out and marked noindex.
 */
export const INDEXED_PAGES = ["/", "/whitepaper/", "/integrate/", "/terminal/"] as const;
