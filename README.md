# ObsidianWeb

A web viewer/editor for a git-backed [Obsidian](https://obsidian.md) vault. Two views of the same notes:

- **Web mode** (default): a wiki/docs-site layout. Folder nav menu, one page at a time, "On this page" outline.
- **Obsidian mode**: tabs, split panes, file tree or flat list, and a markdown editor with live preview.

Both modes have global search, backlinks, a tag browser, raw-markdown view, light/dark/other themes, and **version history with diffs** from the vault's git history.

It runs two ways from the same frontend:

| | **Static (GitHub Pages)** | **Server (Node / Docker)** |
|---|---|---|
| Hosting | GitHub Pages, no backend | Any machine that can run Node or Docker |
| Vault source | Folder in a public repo | A git repo folder **or** a [Fast Note Sync](https://github.com/haierkeys/fast-note-sync-service) service |
| Vault visibility | Public only (the site is public) | Public or private (your network, your auth) |
| History | GitHub API (60 requests/hour/visitor unauthenticated) | Local `git log`, no limits |
| Editing | Read-only | Saves and commits to git (`ALLOW_WRITE=1`) |
| Auth | None | Optional OIDC login (Pocket ID, Entra ID, ...) |

## What it renders
Markdown (tables, task lists, code highlighting), YAML frontmatter, `[[wikilinks]]` and `[[link|alias]]`, `#tags`, `==highlights==`, `> [!note]` callouts, and images via `![[img.png|width]]` or `![](img.png)`, and PDFs: `![[file.pdf]]` embeds the browser's PDF viewer (`![[file.pdf#page=2|400]]` starts on page 2 at 400px tall), `[[file.pdf]]` links to it, and PDFs in the vault appear in the navigation and open as pages of their own. Attachments are found using the `attachmentFolderPath` from the vault's `.obsidian/app.json`. Other Obsidian settings, plugins, Canvas and Dataview are not supported.

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
| `VAULT_SOURCE` | `git` | `git` or `fns` (see [Vault from Fast Note Sync](#vault-from-fast-note-sync)) |
| `OIDC_*`, `PUBLIC_URL` | unset | Login, see [Login with OIDC](#login-with-oidc) |

### Running behind a reverse proxy
Any proxy (Caddy, nginx, Traefik) works: forward everything to port 8787. Enable HTTPS at the proxy.

### Security
By default there is **no authentication**: anyone who can reach the server can read the vault (and, with `ALLOW_WRITE`, change it). For anything private, either enable OIDC login (below) or keep the server on a private network / behind an authenticating proxy. Leave `ALLOW_WRITE` off unless the endpoint is protected.

---

## Login with OIDC
Set `OIDC_ISSUER` and the server requires sign-in for everything except `/healthz`. It uses the authorization-code flow with PKCE, so it works with Pocket ID, Entra ID, Authentik, Keycloak and other standard providers. **Every user who can sign in gets the same access** (no roles yet).

1. In your identity provider, register a client for ObsidianWeb with the redirect/callback URL `https://<your host>/auth/callback` (exactly `PUBLIC_URL` + `/auth/callback`).
2. Set the environment variables:

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | Provider base URL (must serve `/.well-known/openid-configuration`), e.g. `https://id.example.com` |
| `OIDC_CLIENT_ID` | Client ID from the provider |
| `OIDC_CLIENT_SECRET` | Client secret (leave unset for a public/PKCE-only client) |
| `PUBLIC_URL` | The URL users open, e.g. `https://notes.example.com`. Used for the callback URL and the `Secure` cookie flag |
| `OIDC_SCOPES` | Default `openid profile email` |
| `SESSION_TTL_HOURS` | Default `168` (7 days) |
| `OIDC_ALLOW_INSECURE` | `1` to allow a plain-HTTP issuer (local testing only) |

Sessions are kept in server memory, so a restart signs everyone out (they just sign in again). Sign out is in **Settings**. Behind a reverse proxy, forward everything to the container and make sure `PUBLIC_URL` is the public HTTPS address.

> Tested against a small mock OIDC provider (`scripts/mock-oidc.mjs`): login, callback, session, logout, replay protection, 401 for API calls. Not yet tested against Pocket ID itself.

---

## Vault from Fast Note Sync
[Fast Note Sync](https://github.com/haierkeys/fast-note-sync-service) (FNS) is a self-hosted service plus Obsidian plugin that syncs a vault between your desktop and mobile apps. ObsidianWeb can use it as its source, so you do not need a git repo: sync from your devices to FNS, and ObsidianWeb pulls the changes down and serves them.

```bash
cp .env.example .env         # set FNS_TOKEN, FNS_VAULT, PUBLIC_URL, OIDC_*
docker compose up -d --build
```
The included `docker-compose.yml` runs both services. To use an FNS you already run, set the `FNS_*` variables on the `obsidianweb` service only.

How it works: on start and then every `FNS_SYNC_INTERVAL` seconds (default 60; `0` disables the timer) the server lists notes and attachments through FNS's REST API, downloads the ones whose content hash changed into `/data/vault`, and removes ones that were deleted. If FNS is unreachable it keeps serving the last copy and shows the error at `/api/sync/status`. The **↻ Sync now** button in the top bar (or `POST /api/sync`) pulls from FNS immediately and waits for the result. Note history and diffs come from FNS's own per-note history. This mode is **read-only**.

| Variable | Meaning |
|---|---|
| `VAULT_SOURCE` | `fns` (default is `git`) |
| `FNS_URL` | Base URL of the service, e.g. `http://fast-note-sync:9000` |
| `FNS_TOKEN` | An API token created in the FNS admin panel (see below) |
| `FNS_VAULT` | Vault name as shown in the plugin/admin panel |
| `FNS_SYNC_INTERVAL` | Seconds between syncs (default 60) |
| `FNS_CLIENT` | Client name sent as `X-Client` (default `ObsidianWeb`); must equal the token's Client restriction |
| `ATTACHMENT_FOLDER` | Attachment folder (`.obsidian` settings are not synced, so set this if yours isn't the vault root) |
| `DATA_DIR` | Where the synced copy lives (default `./data`, `/data` in Docker; use a volume) |

**Create a dedicated token in the FNS admin panel** (the "Copy API Config" token is for the Obsidian plugin and is bound to that client). Recommended settings: name `obsidianweb`; **Client restriction** `ObsidianWeb` (must match `FNS_CLIENT`); **Protocol** REST only; **Content restriction** Note read-only and Attachment read-only; **Vault** only your vault; optionally restrict the IP to the container's address. FNS answers `code 315 "Scope restricted"` when the protocol, function, vault or client doesn't match, and `code 307` when the token isn't accepted.

> Built from FNS's published REST documentation and tested against a mock of that API (`scripts/mock-fns.mjs`: full sync, incremental update, client/scope errors, outage handling, history) and against a real FNS instance (initial sync of notes and attachments). Per-note history and change-detection on later syncs have only been exercised against the mock so far. If a sync fails, check `/api/sync/status` and the container log; the error text includes FNS's own code (307 not logged in, 314/315 client or scope restricted).

### Deploying with Komodo
`komodo.compose.yml` runs ObsidianWeb alone, against an FNS service you already have, with OIDC required (the container refuses to start without the settings). Create a Komodo stack that clones this repo (`file_paths: komodo.compose.yml`, build enabled) and fill in the environment: `FNS_URL`, `FNS_TOKEN`, `FNS_VAULT`, `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OBSIDIANWEB_IP` (and optionally `ATTACHMENT_FOLDER`, `FNS_SYNC_INTERVAL`, `DEFAULT_LAYOUT`). Its network settings assume an external ipvlan named `vlan103_ipvlan`; edit the file for your own network.

---

## Using the UI
- **Web / Obsidian** toggle: top right. Your choice is remembered in the browser; the default for new visitors comes from `DEFAULT_LAYOUT`.
- **Search**: top bar, `/` or `Ctrl/Cmd+K`. Matches note names and text.
- **Show raw**: toolbar button, shows the markdown source (including frontmatter).
- **History**: right panel. Click a commit to view that version and see a diff against the current one.
- **Navigation (Web mode)**: compact folder menu; opening a page expands only the folders that hold it and collapses the rest, and you can open or close any section by clicking its heading until the next page change.
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

## Roadmap
Ideas to revisit, not commitments.

### Hosted site (server mode)
- **Multi-vault support.** Point the server at a root folder or several vault folders, with a switcher in the interface to flip between them.
- **Multi-vault Fast Note Sync.** A settings section to configure several FNS connections, each with a URL, vault name and token. This is an admin-level permission, which leads to the next items.
  - Connection data such as tokens must be **stored encrypted**, so it can't be scraped from the Docker data volume.
- **OIDC role support.** Today every signed-in user has the same access. Admin would be the base level, with custom role names configurable.
  - Set FNS vault access **per connection by role**.

## Contributing
Issues and PRs are welcome. `npm run typecheck` checks the app and server.

## License
[MIT](LICENSE) © 2026 Danny Cherry. Fork and modify freely. Third-party dependencies keep their own licenses (MIT, BSD, Apache-2.0, MPL-2.0).

The sample notes in `vault/` are test content and are covered by the same license.
