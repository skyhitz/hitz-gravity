import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

const sidebars: SidebarsConfig = {
  docs: [
    'index',
    'whitepaper',
    {
      type: 'category',
      label: 'Sovereign Vault',
      collapsed: false,
      items: ['vault/integration', 'vault/migration'],
    },
    {
      type: 'category',
      label: 'Security',
      collapsed: false,
      items: ['security/audit', 'security/fee-backtest'],
    },
    {
      type: 'category',
      label: 'App and data',
      items: ['app/frontend', 'app/data'],
    },
    {
      type: 'category',
      label: 'History',
      items: ['history/testnet', 'history/skyhitz-v1'],
    },
    'legal',
  ],
}

export default sidebars
