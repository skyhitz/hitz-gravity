/**
 * seo.ts: one place that builds a page's metadata.
 *
 * Next merges metadata from layouts and pages shallowly: a page that sets
 * `openGraph` replaces the layout's whole `openGraph` object, image included.
 * So every page gets its complete set here: title, description, canonical
 * URL, Open Graph and Twitter card, all from the same title and description.
 *
 * House style: no em-dashes. Use commas or periods.
 */

import type { Metadata } from "next";
import { OG_IMAGE, PROTOCOL_NAME, X_HANDLE, pageUrl } from "./site";

export interface PageSeo {
  /** Shown in the tab and as the search result's headline. Aim for 60 characters or fewer. */
  title: string;
  /** The search result's snippet. Aim for 160 characters or fewer. */
  description: string;
  /** The page's path, e.g. "/whitepaper/". */
  path: string;
  /** False for pages that only make sense mid-task; they stay out of the sitemap too. */
  index?: boolean;
  /** "article" for long-form documents. */
  type?: "website" | "article";
}

export function pageMetadata(page: PageSeo): Metadata {
  const url = pageUrl(page.path);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      type: page.type ?? "website",
      url,
      siteName: PROTOCOL_NAME,
      locale: "en_US",
      title: page.title,
      description: page.description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      site: X_HANDLE,
      creator: X_HANDLE,
      title: page.title,
      description: page.description,
      images: [OG_IMAGE.url],
    },
    // Links on a page left out of the index still count, so they are followed.
    ...(page.index === false ? { robots: { index: false, follow: true } } : {}),
  };
}
