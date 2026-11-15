import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

const GITHUB = 'https://github.com/skyhitz/hitz-gravity'
const SITE = 'https://docs.skyhitz.io'
const APP = 'https://skyhitz.io'
const DESCRIPTION =
  'Documentation for HITZ Protocol, oracle-free, protocol-owned liquidity on Stellar: the whitepaper, the Sovereign Vault integration guide, the security review and how the app works.'

// Who publishes these docs and what they document, for search engines and AI
// systems that read structured data. The @ids are the ones skyhitz.io uses,
// so both sites describe the same organization.
const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${APP}/#organization`,
      name: 'Skyhitz',
      url: `${APP}/`,
      logo: `${APP}/icon.png`,
      sameAs: ['https://github.com/skyhitz', 'https://x.com/skyhitz'],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: `${SITE}/`,
      name: 'HITZ Protocol Docs',
      description: DESCRIPTION,
      inLanguage: 'en',
      publisher: { '@id': `${APP}/#organization` },
      about: { '@id': `${APP}/#website` },
    },
  ],
}

// Content comes from the repository's own markdown, copied into content/ by
// scripts/sync.mjs before every start and build. Edit the source files, not
// content/.
const config: Config = {
  title: 'HITZ Protocol Docs',
  tagline: 'Oracle-free, protocol-owned liquidity on Stellar',
  url: SITE,
  baseUrl: '/',
  // Cloudflare Pages serves every page at its trailing-slash URL and redirects
  // the other form to it. Saying so here makes the canonical links, the
  // sitemap and the internal links name the URL that answers, not one that
  // redirects.
  trailingSlash: true,
  // generated/ holds what scripts/sync.mjs writes for machines: each page as
  // plain markdown and llms-full.txt.
  staticDirectories: ['static', 'generated'],
  favicon: 'img/favicon.ico',
  headTags: [
    {
      tagName: 'script',
      attributes: { type: 'application/ld+json' },
      innerHTML: JSON.stringify(STRUCTURED_DATA).replace(/</g, '\\u003c'),
    },
  ],
  organizationName: 'skyhitz',
  projectName: 'hitz-gravity',
  onBrokenLinks: 'throw',
  // The synced files are plain CommonMark, not MDX.
  markdown: { format: 'detect', hooks: { onBrokenMarkdownLinks: 'throw' } },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
        // No <changefreq> or <priority>: one value for every page says nothing, and search engines ignore them.
        // The whitepaper's canonical page is skyhitz.io/whitepaper (scripts/sync.mjs), so it isn't listed here.
        sitemap: { changefreq: null, priority: null, ignorePatterns: ['/whitepaper/'] },
      },
    ],
  ],
  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Pages of the archived v1 docs (music platform) that used to live
        // here: send old links to the page that explains where they went.
        redirects: [
          '/architecture/overview',
          '/backend/algolia',
          '/backend/graphql',
          '/backend/r2-storage',
          '/backend/stellar-soroban',
          '/frontend/app-structure',
          '/frontend/player',
          '/frontend/search-and-external',
          '/operations/deploy',
          '/operations/treasury-bot',
          '/security/threat-model',
          '/tokenomics/apr-math',
          '/tokenomics/flows',
          '/tokenomics/rewards',
        ].map((from) => ({ from, to: '/history/skyhitz-v1' })),
      },
    ],
  ],
  themeConfig: {
    // Link previews: the same image as skyhitz.io.
    image: `${APP}/og.png`,
    metadata: [
      { name: 'twitter:site', content: '@skyhitz' },
      { name: 'twitter:creator', content: '@skyhitz' },
      { property: 'og:site_name', content: 'HITZ Protocol Docs' },
      { name: 'theme-color', content: '#0a0a0a' },
    ],
    colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
    navbar: {
      title: 'Skyhitz',
      items: [
        { to: '/whitepaper', label: 'Whitepaper', position: 'left' },
        { to: '/vault/integration', label: 'Integrate', position: 'left' },
        { to: '/security/audit', label: 'Security', position: 'left' },
        { href: 'https://skyhitz.io', label: 'App', position: 'right' },
        { href: GITHUB, label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Protocol',
          items: [
            { label: 'Whitepaper', to: '/whitepaper' },
            { label: 'Integrating the vault', to: '/vault/integration' },
            { label: 'API and MCP server', href: 'https://skyhitz.io/integrate/' },
            { label: 'Security review', to: '/security/audit' },
          ],
        },
        {
          title: 'On-chain',
          items: [
            { label: 'HITZ token', href: 'https://stellar.expert/explorer/public/contract/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU' },
            { label: 'Sovereign Vault', href: 'https://stellar.expert/explorer/public/contract/CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU' },
            { label: 'stellar.toml', href: 'https://skyhitz.io/.well-known/stellar.toml' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'App', href: 'https://skyhitz.io' },
            { label: 'HITZ Terminal', href: 'https://skyhitz.io/terminal/' },
            { label: 'GitHub', href: GITHUB },
            { label: 'X', href: 'https://x.com/skyhitz' },
          ],
        },
      ],
      copyright: `Skyhitz · built from <a href="${GITHUB}">skyhitz/hitz-gravity</a>`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'toml'],
    },
  },
}

export default config
