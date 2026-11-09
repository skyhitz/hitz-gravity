import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

const GITHUB = 'https://github.com/skyhitz/hitz-gravity'

// Content comes from the repository's own markdown, copied into content/ by
// scripts/sync.mjs before every start and build. Edit the source files, not
// content/.
const config: Config = {
  title: 'Skyhitz Docs',
  tagline: 'HITZ, the Gravity token, and the Sovereign Vault',
  url: 'https://docs.skyhitz.io',
  baseUrl: '/',
  favicon: 'img/favicon.ico',
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
