# Project notes for Claude

The repo map is `README.md`. The frontend has its own notes in `frontend/AGENTS.md`.

## How a change ships

1. Work on a branch, never on main.
2. Run the checks for what changed: `cargo test --workspace` for the contracts; `pnpm test`,
   `pnpm lint` and `pnpm build` in `frontend/`; `npm run build` in `docs/` when markdown that
   feeds docs.skyhitz.io changed (the build fails on broken links and anchors).
3. When the job is done, open a pull request into main, every time. Never push to main directly.
4. Merging into main deploys skyhitz.io whenever `frontend/` changed
   (`.github/workflows/deploy-frontend.yml`), and docs.skyhitz.io whenever `docs/` or a markdown
   file it publishes changed (`.github/workflows/deploy-docs.yml`).
