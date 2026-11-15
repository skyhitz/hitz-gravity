/**
 * schema.ts: the schema.org entities the pages describe themselves with.
 *
 * The organization and the site are defined once and referred to by @id, so
 * every page's structured data points at the same two entities.
 *
 * House style: no em-dashes. Use commas or periods.
 */

import {
  DOCS_URL,
  GITHUB_ORG_URL,
  GITHUB_URL,
  HOME_DESCRIPTION,
  ORG_NAME,
  PROTOCOL_NAME,
  SITE_URL,
  SUPPORT_EMAIL,
  TAGLINE,
  X_URL,
  pageUrl,
} from "./site";

export const ORG_ID = `${SITE_URL}/#organization`;
export const SITE_ID = `${SITE_URL}/#website`;

type Thing = Record<string, unknown>;

export const organization: Thing = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: ORG_NAME,
  url: `${SITE_URL}/`,
  logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png`, width: 180, height: 180 },
  description: `${ORG_NAME} builds ${PROTOCOL_NAME}: ${TAGLINE.charAt(0).toLowerCase()}${TAGLINE.slice(1)}, and the HITZ Terminal for XLM market data.`,
  email: SUPPORT_EMAIL,
  sameAs: [GITHUB_ORG_URL, X_URL],
};

export const website: Thing = {
  "@type": "WebSite",
  "@id": SITE_ID,
  url: `${SITE_URL}/`,
  name: PROTOCOL_NAME,
  alternateName: [ORG_NAME, "HITZ"],
  description: HOME_DESCRIPTION,
  inLanguage: "en",
  publisher: { "@id": ORG_ID },
};

/** Home › Page, for pages one level down. */
export function breadcrumb(name: string, path: string): Thing {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: PROTOCOL_NAME, item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name, item: pageUrl(path) },
    ],
  };
}

/** Wrap entities in one graph. */
export function graph(...things: Thing[]): Record<string, unknown> {
  return { "@context": "https://schema.org", "@graph": things };
}

export { DOCS_URL, GITHUB_URL };
