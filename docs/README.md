# docs.skyhitz.io

The documentation site, built with [Docusaurus](https://docusaurus.io)
from this repository's own markdown, so the site always says what the repo
says.

## How it works

`scripts/sync.mjs` runs before every `start` and `build`. It copies each
file in its `PAGES` list (the root README, the whitepaper, the vault's
integration and migration notes, the security review, the fee backtest,
the frontend and reports READMEs, the testnet record and the legal
disclosure) into `content/`, adds front matter, and rewrites relative
links: a link to another published file points to its docs page, anything
else to the file on GitHub.

- Edit the source files, never `content/`. It is generated and git-ignored.
- Pages with no source in the repo live in `extra/` and are copied as they
  are (today only the note on the archived v1 platform).
- `sidebars.ts` sets the order. To publish another file, add it to `PAGES`
  and to the sidebar.
- The build fails on a link to a missing file, a broken page link or a
  broken anchor, so a rename in the repo can't silently break the site.
- Routes of the archived v1 docs redirect to `/history/skyhitz-v1`
  (`docusaurus.config.ts`).

## Dev

```bash
npm ci
npm start           # sync + dev server on :3000
npm run build       # sync + static site → build/
npm run serve       # serve build/
```

## Deploy

The site is the Cloudflare Pages project `skyhitz-docs` (direct upload),
with the custom domain docs.skyhitz.io.

```bash
npm run deploy      # build, then wrangler pages deploy build --branch main
```

`--branch main` is production. Deploying with any other branch name gives a
preview URL on `skyhitz-docs.pages.dev` and leaves docs.skyhitz.io alone.
Wrangler needs `CLOUDFLARE_API_TOKEN` with Pages edit permission, or a
`wrangler login` session.
