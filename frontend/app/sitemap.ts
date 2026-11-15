/**
 * /sitemap.xml: the pages a search engine should index (lib/site.ts,
 * INDEXED_PAGES). Written out once at build time, like every other route.
 *
 * No <lastmod>: a date is only useful when it is the day the page's content
 * last changed, and a build date would claim every page changed on every
 * deploy. Search engines are told to ignore dates like that, and then ignore
 * the real ones too.
 */

import type { MetadataRoute } from "next";
import { INDEXED_PAGES, pageUrl } from "./lib/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXED_PAGES.map((path) => ({ url: pageUrl(path) }));
}
