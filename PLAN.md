# Obsidian Web UI: Build Plan

> **Status:** this is the original planning document. The project has moved on: see [README.md](README.md) for what exists today (server mode with OIDC, Fast Note Sync source, PDF and image support, backlinks and tags, mobile layout, Docker/Komodo deployment) and its **Roadmap** section for what's next. Kept for the reasoning behind the early decisions.

## Goal
A static, read-first web viewer/editor for an Obsidian vault stored in a public Git repo, deployable on GitHub Pages, with an Obsidian-like layout and git-backed version history.

## Architecture (no backend)
- Pure static SPA (Vite + TypeScript; Preact or vanilla to keep the bundle small). Output to `dist/` for Pages.
- Vault lives in the same repo (`/vault`) or a separate repo fetched at runtime.
- **Data source**: GitHub REST API (unauthenticated for public repos, optional PAT for writes/rate limits).
  - Tree: `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1`
  - File: `raw.githubusercontent.com` (or contents API)
  - History: `GET /repos/{o}/{r}/commits?path=<file>`; version at a commit: contents API `?ref=<sha>`
- **Build-time index** (GitHub Action): generates `index.json` (file tree, titles, tags, frontmatter, link graph, backlinks) so the client avoids N API calls and Pages works without rate limits.

## Deployment modes (one frontend, swappable data adapter)
The UI talks only to a `VaultProvider` interface: `tree()`, `read(path, ref?)`, `history(path)`, `write(path, content)`. Two implementations:

| Mode | Provider | Where it runs | History | Write |
|---|---|---|---|---|
| **Static** (Pages) | `GitHubProvider` + prebuilt `index.json` | GitHub Pages | GitHub API | PAT, opt-in |
| **Server** | `LocalGitProvider` | Node server (Docker-able) | local `git log`/`git show` | direct, commit on save |

- Same frontend bundle for both; the mode is chosen by `vault-ui.config.json` or env vars (`VAULT_PATH`, or `REPO_URL` + `BRANCH`).
- Server mode: small Node (Hono/Express) app that serves `dist/` plus `/api/*`, points at a local vault dir or clones a remote and pulls on an interval. Optional basic auth/token, so a private vault works.
- **Layout options**: (a) UI + `/vault` in one repo (default, current test repo); (b) UI repo separate, vault via `vault.repo` in config (static) or `REPO_URL` (server). Only config changes, no code changes.
- In-repo layout: `/vault` (notes), `/app` (frontend), `/server`, `/.github/workflows`. Keeping the vault in its own subfolder lets you point Obsidian at `/vault` only and keeps app files out of the vault.

## Auth (server mode only)
- Generic **OIDC** (authorization code + PKCE) via a standard client library (e.g. `openid-client`), configured only by env: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`. Discovery comes from the issuer's `/.well-known/openid-configuration`.
- Target provider: **Pocket ID**. Any spec-compliant provider (Entra ID later) should work by changing the issuer and client values; no Entra-specific work planned.
- Session: server-side session in an HttpOnly, SameSite cookie. The frontend never sees tokens.
- Authorization: optional allowlist by email or by group claim (`OIDC_ALLOWED_GROUPS`); a separate group or claim can gate write access (read-only vs editor).
- Auth off by default for local use; static/Pages mode has no auth (public repo only).

## Layout
1. **Left sidebar**, toggle between:
   - Folder tree (collapsible, active-file highlight, persisted expand state)
   - Navbar/flat view (search + file list, sorted by name/modified, tag filter)
2. **Main pane**: tabs; per-tab mode switch **Preview / Edit** (plus optional split).
3. **Right sidebar** (collapsible): backlinks, outline (headings), tags, **History** panel.
4. Hash routing (`#/Projects/Alpha/Overview`) so it works on Pages with no server rewrites.

## Rendering
- `markdown-it` (or `unified/remark`) + plugins: frontmatter, task lists, tables, callouts (`> [!note]`), highlight `==x==`, footnotes.
- Custom pass for `[[wikilinks]]`, `[[a|alias]]`, `![[embeds]]`, `#tags`, resolved against `index.json`.
- Code highlighting (highlight.js/Shiki); sanitize with DOMPurify.

## Editor
- CodeMirror 6 (markdown mode, same engine Obsidian uses).
- Phase 1: edits held locally (localStorage draft) and download/copy only.
- Phase 3: commit via GitHub API with user PAT (stored locally), creating a commit per save.

## Version history
- History panel per file: list commits (author, date, message).
- Click a commit → view that version; **diff view** vs. current or previous (`diff` lib, side-by-side/inline).
- "Restore this version" loads it into the editor (commit only if write is enabled).
- Fallback for private/large repos: GitHub Action can pre-generate `history/<path>.json`.

## GitHub Pages compatibility
- Vite `base` set to `/<repo>/`; hash routing; `404.html` not needed.
- Action: build index → build app → deploy via `actions/deploy-pages`.
- Config in `vault-ui.config.json` (repo, branch, vault path, default view).

## Phases
| # | Deliverable | Notes |
|---|---|---|
| 0 | Dummy vault (done, `/vault`) + repo + Pages skeleton | Test bed |
| 1 | Read-only viewer: tree sidebar, preview, wikilinks | Core value |
| 2 | Navbar view, search, tabs, backlinks/outline | Obsidian feel |
| 3 | History panel + diff via GitHub API | Requested feature |
| 4 | Editor (CM6), local drafts | Mode toggle |
| 5 | Commit-back with PAT, restore version | Optional write |
| 6 | Polish: themes (light/dark), mobile, graph view (stretch) | |

## Test vault
`/vault` contains folders (Projects/Alpha, Projects/Beta, Daily, Reference/Snippets), wikilinks, frontmatter, tables, tasks, callouts, code blocks. Commit it in several small commits so history has something to show.

## Open Questions & Assumptions
**Assumptions**
- Public repo, so unauthenticated API reads suffice (60 req/hr/IP limit, hence the build-time index).
- Read-only is the MVP; writing is opt-in via PAT.
- Vault is markdown-only; plugins/canvas/dataview are out of scope.

**Open questions**
- Vault in the same repo as the UI, or separate? (Separate means the index Action must live in the vault repo or the UI fetches the tree live.)
- Is a real private vault the eventual target? That breaks "public Pages + API" (needs auth, and Pages on private repos requires a paid plan). Worth deciding early.
- Do you want writes at all? A PAT in browser storage is a real security tradeoff.
- Framework preference (vanilla vs Preact vs React)?

**Risks / edge cases**
- API rate limits and per-file history calls (mitigate with index and caching).
- Wikilink resolution ambiguity (same filename in different folders; Obsidian uses shortest-path matching).
- Attachments/images with relative paths and spaces in names.
- Large vaults: recursive tree can truncate at 100k entries; the index needs chunking.
- Rendering diffs of renamed files (`--follow` isn't available in the API).
- Obsidian-specific syntax has no spec, so expect parity gaps.
