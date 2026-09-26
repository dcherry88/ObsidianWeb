# ObsidianWeb

A web viewer/editor for a git-backed [Obsidian](https://obsidian.md) vault. Two views of the same notes:

- **Web mode** (default): a wiki/docs-site layout. Folder nav menu, one page at a time, "On this page" outline.
- **Obsidian mode**: tabs, split panes, file tree or flat list, and a markdown editor with live preview.

Both modes have global search, backlinks, a tag browser, raw-markdown view, light/dark/other themes, and **version history with diffs** from the vault's git history.

It runs two ways from the same frontend:

| | **Static (GitHub Pages)** | **Server (Node / Docker)** |
|---|---|---|
| Hosting | GitHub Pages, no backend | Any machine that can run Node or Docker |
| Vault visibility | Public only (the site is public) | Public or private (your network, your auth) |
| History | GitHub API (60 requests/hour/visitor unauthenticated) | Local `git log`, no limits |
| Editing | Read-only | Saves and commits to git (`ALLOW_WRITE=1`) |
| Auth | None | None built in yet (see [Security](#security)) |

## What it renders
Markdown (tables, task lists, code highlighting), YAML frontmatter, `[[wikilinks]]` and `[[link|alias]]`, `#tags`, `==highlights==`, `> [!note]` callouts, and images via `![[img.png|width]]` or `![](img.png)`. Attachments are found using the `attachmentFolderPath` from the vault's `.obsidian/app.json`. Other Obsidian settings, plugins, Canvas and Dataview are not supported.

### Vertical sections (dashboard grids)
Lay out key/value tables in rows and columns using HTML-comment directives. Plain Obsidian ignores the comments and shows the tables normally; ObsidianWeb renders them as a borderless grid.
```markdown
<!-- sections -->
<!-- col1 -->
| Sites | |
|---|---|
| Home | https://example.com |

<!-- col2 -->
| Servers | |
|---|---|
| web-01 | 10.0.0.11 |

<!-- row -->
<!-- col1 -->
| Contacts | |
|---|---|
| Lead | [[People/Ada Lovelace]] |
<!-- /sections -->
```
Each table's header row is the section title and the two columns are key and value. `<!-- colN -->` picks the column for what follows (`<!-- col -->` = next column), several tables under one column stack, `<!-- row -->` starts a new row, and `<!-- /sections -->` ends the grid. Up to 6 columns; they stack on narrow screens. Live example: `vault/Guide/Vertical Sections.md`.

## Repo layout
```
vault/     your notes (a normal Obsidian vault; open this folder in Obsidian)
app/       frontend (Vite + Preact + CodeMirror 6)
server/    Node API (Hono) that serves the app and reads the vault via git
shared/    types shared by app and server
scripts/   static-site build helper
.github/workflows/pages.yml   GitHub Pages deploy
Dockerfile
```
Keep the vault in its own subfolder so Obsidian doesn't see the app's files as notes.

---

## Deploy option 1: GitHub Pages (static)

**One-time setup**
1. Put your notes in `vault/` (or fork this repo and replace the sample notes).
2. In the repo go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. Without this the workflow deploys nothing and the site returns 404.
3. Push to `main`. The **Deploy to Pages** workflow builds the site and publishes it at `https://<user>.github.io/<repo>/`. Every later push to `main` redeploys.

If the first run happened before you changed the Pages source, re-run it from the **Actions** tab.

**How it works:** the build copies `vault/` into the site, writes an `index.json` note list and a `config.json`, and the browser fetches notes as plain files. Version history and old versions come from the GitHub API and `raw.githubusercontent.com`, so the repo must be public. Anonymous GitHub API access is limited to 60 requests per hour per visitor IP; the History panel makes one request per note opened.

**Optional repository variables** (Settings → Secrets and variables → Actions → **Variables**):

| Variable | Effect |
|---|---|
| `DEFAULT_LAYOUT` | `doc` (Web mode, default) or `vault` (Obsidian mode) for first-time visitors |
| `VAULT_REPO` | `owner/name` of a *separate* repo that holds the vault (see below) |
| `VAULT_BRANCH` | branch of that repo (default `main`) |
| `VAULT_REPO_PATH` | folder inside that repo where the notes live (default: repo root) |

### Keeping the vault in a separate repo
Set `VAULT_REPO` (and optionally `VAULT_BRANCH`, `VAULT_REPO_PATH`) as repository variables in the UI repo. The workflow then checks out the vault repo at build time and builds from it, and History reads that repo's commits. Notes:
- The vault repo must be public (the workflow checks it out anonymously, and History uses the public API).
- Pushing to the vault repo does **not** rebuild the site by itself. Re-run the workflow, or add a `repository_dispatch` or scheduled trigger.
- This path is implemented but has not been exercised end to end against a real second repo.

### Building the static site locally
```bash
npm install
npm run build:static      # output in app/dist
npx serve app/dist        # or any static file server
```
`VAULT_DIR` (default `vault`) picks the notes folder.

### Custom domain / subpath
Assets use relative URLs and routing is hash-based (`#/Folder/Note.md`), so the site works under `/<repo>/` or at a domain root with no configuration. A custom domain is set in the repo's Pages settings.

---

## Deploy option 2: Node server (local, VM or Docker)

The server serves the built frontend plus a small `/api`. It reads your vault with `git` (the vault folder must be inside a git repository) and can commit edits.

### Run directly
Requires Node 22+ and `git`.
```bash
npm install
npm run build
ALLOW_WRITE=1 VAULT_PATH=./vault npm start      # http://localhost:8787
```
Development with hot reload: `npm run dev:server` in one terminal and `npm run dev:app` in another (Vite proxies `/api`).

### Run with Docker
The repo's `Dockerfile` builds the app and starts the server. Mount your vault (a git working copy) at `/vault`:
```bash
docker build -t obsidianweb .
docker run -d --name obsidianweb -p 8787:8787 \
  -v /path/to/your/vault-repo:/vault \
  -e VAULT_PATH=/vault \
  obsidianweb
```
If your vault lives in a subfolder of the repo, mount the repo and point `VAULT_PATH` at the subfolder (for example `-v /path/repo:/repo -e VAULT_PATH=/repo/vault`).

Docker Compose:
```yaml
services:
  obsidianweb:
    build: .
    ports: ["8787:8787"]
    environment:
      VAULT_PATH: /vault
      # ALLOW_WRITE: "1"
      # GIT_AUTHOR_NAME: "Your Name"
      # GIT_AUTHOR_EMAIL: "you@example.com"
      # GIT_COMMITTER_NAME: "Your Name"
      # GIT_COMMITTER_EMAIL: "you@example.com"
    volumes:
      - /path/to/your/vault-repo:/vault
    restart: unless-stopped
```
Notes for containers:
- The image marks all directories as git-safe, so a bind-mounted vault owned by another user still works.
- For read-write mode the container needs a git identity, which is what the `GIT_*` variables above provide. Written commits appear in the mounted repo; push them yourself (or with a cron/sync job).
- The container does not `git pull`. To show upstream changes, update the mounted repo on the host (for example a cron job running `git pull`).
- The Docker image has not been built in this repo's CI; if the build fails on your platform, please open an issue.

### Server environment variables
| Variable | Default | Meaning |
|---|---|---|
| `VAULT_PATH` | `./vault` | Notes folder; must be inside a git repo |
| `PORT` | `8787` | Listen port |
| `ALLOW_WRITE` | off | `1`/`true` lets the UI save (each save is a git commit) |
| `DEFAULT_LAYOUT` | `doc` | `doc` (Web mode) or `vault` (Obsidian mode) for first-time visitors |
| `APP_DIST` | `./app/dist` | Where the built frontend is |

### Running behind a reverse proxy
Any proxy (Caddy, nginx, Traefik) works: forward everything to port 8787. Enable HTTPS at the proxy.

### Security
There is **no built-in authentication yet**. Anyone who can reach the server can read the whole vault, and if `ALLOW_WRITE` is on, change it. Until OIDC login lands (planned; see [PLAN.md](PLAN.md)):
- Do not expose the server directly to the internet with a private vault.
- Put it behind an authenticating proxy (Authelia, Pocket ID with a forward-auth proxy, Cloudflare Access, basic auth) or keep it on a private network/VPN.
- Leave `ALLOW_WRITE` off unless the endpoint is protected.

---

## Using the UI
- **Web / Obsidian** toggle: top right. Your choice is remembered in the browser; the default for new visitors comes from `DEFAULT_LAYOUT`.
- **Search**: top bar, `/` or `Ctrl/Cmd+K`. Matches note names and text.
- **Show raw**: toolbar button, shows the markdown source (including frontmatter).
- **History**: right panel. Click a commit to view that version and see a diff against the current one.
- **Split** (Obsidian mode): open a second note beside the current one, or use the ⧉ icon on a tab.
- **Edit** (Obsidian mode, server with `ALLOW_WRITE=1`): editor with live preview; `Ctrl/Cmd+S` saves and commits. In static mode the editor is view-only and nothing is saved.
- **Settings** (⚙): theme, accent color, default view. Stored in the browser only.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Pages site is a 404 | Pages source is not **GitHub Actions**, or the first run predates that setting. Change it and re-run the workflow. |
| Old version still showing after a deploy | Browser cache; hard refresh. |
| History panel empty or errors on Pages | GitHub API rate limit (60/hr anonymous) or a private repo. |
| Images missing | Attachment isn't in the folder set by `attachmentFolderPath`, or filename case differs (Pages is case-sensitive). |
| `git` errors in Docker | Vault isn't a git repo, or the mount path is wrong. |
| Save fails with "writes disabled" | Start the server with `ALLOW_WRITE=1`. |

## Contributing
Issues and PRs are welcome. `npm run typecheck` checks the app and server.

## License
[MIT](LICENSE) © 2026 Danny Cherry. Fork and modify freely. Third-party dependencies keep their own licenses (MIT, BSD, Apache-2.0, MPL-2.0).

The sample notes in `vault/` are test content and are covered by the same license.
