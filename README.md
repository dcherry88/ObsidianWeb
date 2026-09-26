# ObsidianWeb

Obsidian-style web viewer/editor for a git-backed markdown vault. See [PLAN.md](PLAN.md).

Two modes, same frontend:

| Mode | How | History | Edit |
|---|---|---|---|
| **Static** (GitHub Pages) | `npm run build:static`, deployed by `.github/workflows/pages.yml` | GitHub API | read-only |
| **Server** | Node/Hono serves the UI + `/api` over a local git vault | local `git log` | commits on save (`ALLOW_WRITE=1`) |

## Run locally (server mode)
```bash
npm install
npm run build
ALLOW_WRITE=1 VAULT_PATH=./vault npm start   # http://localhost:8787
```
Dev with hot reload: `npm run dev:server` and `npm run dev:app` (Vite proxies `/api`).

Env: `VAULT_PATH` (default `./vault`, must be inside a git repo), `PORT` (8787), `ALLOW_WRITE`, `APP_DIST`.

## Pages
Repo Settings → Pages → Source: **GitHub Actions**. Every push to `main` rebuilds and deploys.

## Layout
`vault/` notes · `app/` Vite + Preact UI · `server/` Hono API · `shared/` provider types
