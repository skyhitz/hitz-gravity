// A doc page's <head>, as the theme writes it, plus one thing the theme has no
// option for: a canonical URL on another site.
//
// The whitepaper is published twice, here and, designed, at
// skyhitz.io/whitepaper. Two pages with the same text compete with each other
// in search; the canonical link tells search engines which one to rank.
// scripts/sync.mjs sets `canonical_url` in that page's front matter.

import React from 'react'
import Head from '@docusaurus/Head'
import { useDoc } from '@docusaurus/plugin-content-docs/client'
import Metadata from '@theme-original/DocItem/Metadata'

export default function DocItemMetadata(): React.ReactNode {
  const { frontMatter } = useDoc()
  const canonical = (frontMatter as { canonical_url?: unknown }).canonical_url
  return (
    <>
      <Metadata />
      {typeof canonical === 'string' && canonical ? (
        <Head>
          <link rel="canonical" href={canonical} />
          <meta property="og:url" content={canonical} />
        </Head>
      ) : null}
    </>
  )
}
