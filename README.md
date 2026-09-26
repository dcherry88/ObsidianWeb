# ObsidianWeb

A web viewer/editor for a git-backed [Obsidian](https://obsidian.md) vault. Two views of the same notes:

- **Web mode** (default): a wiki/docs-site layout. Folder nav menu, one page at a time, "On this page" outline.
- **Obsidian mode**: tabs, split panes, file tree or flat list, and a markdown editor with live preview.

Both modes have global search, backlinks, a tag browser, raw-markdown view, light/dark/other themes, and **version history with diffs** from the vault's git history.

**Live demo:** <https://dcherry88.github.io/ObsidianWeb/> (static mode, showing the sample notes in `vault/`). Good pages to try:
[Markdown showcase](https://dcherry88.github.io/ObsidianWeb/#/Guide/Markdown%20Showcase.md) ·
[Links and backlinks](https://dcherry88.github.io/ObsidianWeb/#/Guide/Links%20and%20Backlinks.md) ·
[Tags](https://dcherry88.github.io/ObsidianWeb/#/Guide/Tags%20Demo.md) ·
[Vertical sections](https://dcherry88.github.io/ObsidianWeb/#/Guide/Vertical%20Sections.md) ·
[Images](https://dcherry88.github.io/ObsidianWeb/#/Reference/Images.md) ·
[PDFs](https://dcherry88.github.io/ObsidianWeb/#/Reference/PDFs.md) ·
[History diffs](https://dcherry88.github.io/ObsidianWeb/#/Guide/History%20Demo.md)

It runs two ways from the same frontend:

| | **Static (GitHub Pages)** | **Server (Node / Docker)** |
|---|---|---|
| Hosting | GitHub Pages, no backend | Any machine that can run Node or Docker |
| Vault source | Folder in a public repo | A git repo folder **or** a [Fast Note Sync](https://github.com/haierkeys/fast-note-sync-service) service |
| Vault visibility | Public only (the site is public) | Public or private (your network, your auth) |
| History | GitHub API (60 requests/hour/visitor unauthenticated) | Local `git log`, no limits |
| Editing | Read-only | Create, edit, rename and delete pages and folders (`ALLOW_WRITE=1`): commits to git, or writes back to Fast Note Sync |
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
| `ALLOW_WRITE` | off | `1`/`true` turns on editing: create, edit, rename and delete pages and folders (git: each change is a commit; FNS: written back to FNS) |
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

Sessions are saved to `DATA_DIR/sessions.json` (mode 600, `/data` in Docker), so restarts and redeploys don't sign anyone out as long as that folder persists. Only a hash of each session ID is stored, so a copy of the file can't be used to impersonate a user. Deleting the file signs everyone out. Sign out is in **Settings**. Behind a reverse proxy, forward everything to the container and make sure `PUBLIC_URL` is the public HTTPS address.

> Tested against a small mock OIDC provider (`scripts/mock-oidc.mjs`): login, callback, session, session persistence across restarts, logout, replay protection, 401 for API calls. Also used in production with Pocket ID.

---

## Vault from Fast Note Sync
[Fast Note Sync](https://github.com/haierkeys/fast-note-sync-service) (FNS) is a self-hosted service plus Obsidian plugin that syncs a vault between your desktop and mobile apps. ObsidianWeb can use it as its source, so you do not need a git repo: sync from your devices to FNS, and ObsidianWeb pulls the changes down and serves them.

```bash
cp .env.example .env         # set FNS_TOKEN, FNS_VAULT, PUBLIC_URL, OIDC_*
docker compose up -d --build
```
The included `docker-compose.yml` runs both services. To use an FNS you already run, set the `FNS_*` variables on the `obsidianweb` service only.

How it works: on start and then every `FNS_SYNC_INTERVAL` seconds (default 60; `0` disables the timer) the server lists notes and attachments through FNS's REST API, downloads the ones whose content hash changed into `/data/vault`, and removes ones that were deleted. If FNS is unreachable it keeps serving the last copy and shows the error at `/api/sync/status`. The **↻ Sync now** button in the top bar (or `POST /api/sync`) pulls from FNS immediately and waits for the result. Note history and diffs come from FNS's own per-note history. Editing is off by default; see [Editing on the hosted site](#editing-on-the-hosted-site).

| Variable | Meaning |
|---|---|
| `VAULT_SOURCE` | `fns` (default is `git`) |
| `FNS_URL` | Base URL of the service, e.g. `http://fast-note-sync:9000` |
| `FNS_TOKEN` | An API token created in the FNS admin panel (see below) |
| `FNS_VAULT` | Vault name as shown in the plugin/admin panel |
| `FNS_SYNC_INTERVAL` | Seconds between syncs (default 60) |
| `FNS_CLIENT` | Client name sent as `X-Client` (default `ObsidianWeb`); must equal the token's Client restriction |
| `FNS_CLIENT_PER_USER` | `1` sends each edit as the client type `<FNS_CLIENT>-<person>` (for example `ObsidianWeb-ada-lovelace`), so the person shows in the type column of FNS's log and history. Off by default. The token's Client restriction must be a wildcard such as `ObsidianWeb*`, otherwise writes fail with code 315. Reading and syncing keep using plain `FNS_CLIENT` |
| `ATTACHMENT_FOLDER` | Attachment folder (`.obsidian` settings are not synced, so set this if yours isn't the vault root) |
| `DATA_DIR` | Where the synced copy lives (default `./data`, `/data` in Docker; use a volume) |

**Create a dedicated token in the FNS admin panel** (the "Copy API Config" token is for the Obsidian plugin and is bound to that client). Recommended settings: name `obsidianweb`; **Client restriction** `ObsidianWeb` (must match `FNS_CLIENT`); **Protocol** REST only; **Content restriction** Note read-only and Attachment read-only; **Vault** only your vault; optionally restrict the IP to the container's address. FNS answers `code 315 "Scope restricted"` when the protocol, function, vault or client doesn't match, and `code 307` when the token isn't accepted.

> Built from FNS's published REST documentation and tested against a mock of that API (`scripts/mock-fns.mjs`: full sync, incremental update, client/scope errors, outage handling, history) and against a real FNS instance (initial sync of notes and attachments). Per-note history and change-detection on later syncs have only been exercised against the mock so far. If a sync fails, check `/api/sync/status` and the container log; the error text includes FNS's own code (307 not logged in, 314/315 client or scope restricted).

### Deploying with Komodo
`komodo.compose.yml` runs ObsidianWeb by itself, using a Fast Note Sync service you already have, and it **requires** OIDC sign-in (the container refuses to start if the settings are missing, so a blank issuer can never leave a vault open).

**Create the stack**
1. In Komodo, create a stack on the server you want. Source: **Git repo** `dcherry88/ObsidianWeb` (or your fork), branch `main`, compose file path `komodo.compose.yml`.
2. Turn on **Run build** (the image is built from this repo on the host) and leave **Auto pull** off (there is no registry image to pull).
3. Fill in the stack's **Environment** (Komodo writes it to `.env`, which the compose file reads):

| Variable | Meaning |
|---|---|
| `FNS_URL` | Address of your FNS service reachable from the container, for example `http://10.0.0.22:9000`. The internal address is preferable to a public one |
| `FNS_TOKEN` | FNS token (see [Vault from Fast Note Sync](#vault-from-fast-note-sync) for the settings to give it) |
| `FNS_VAULT` | Vault name exactly as FNS shows it |
| `FNS_CLIENT` | Optional, default `ObsidianWeb`. Must match the token's Client restriction |
| `FNS_SYNC_INTERVAL` | Optional, seconds between syncs (default 60) |
| `ATTACHMENT_FOLDER` | Your vault's attachment folder (FNS doesn't sync `.obsidian` settings) |
| `PUBLIC_URL` | The **https** address people open, for example `https://notes.example.com` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | From your identity provider client (callback `PUBLIC_URL` + `/auth/callback`) |
| `OBSIDIANWEB_IP` | A free address on the compose file's network (see below) |
| `DEFAULT_LAYOUT` | Optional: `doc` (Web) or `vault` (Obsidian) for first-time visitors |

Komodo variables work too: put the client ID or secret in Komodo Variables and reference them as `[[VARIABLE_NAME]]` in the Environment.

4. **Deploy.** Check the container log for `Source: fast-note-sync ...` and `Auth: OIDC (...)`, and open `/healthz` (returns `ok`). The first sync line (`[fns] sync: N change(s), ...`) confirms the connection to FNS.

**Network.** The compose file joins an external network named `vlan103_ipvlan` and gives the container a fixed IP (`OBSIDIANWEB_IP`), so nothing needs a published port and the container answers on its own address at port 8787 (plain HTTP). Edit the `networks:` section for your own setup, for example to use a normal bridge network with `ports: ["8787:8787"]`.

**Public access.** Put a TLS terminator in front, such as a Cloudflare tunnel or reverse proxy, pointing at `http://<OBSIDIANWEB_IP>:8787`. `PUBLIC_URL` must be that public `https://` address, and the same URL plus `/auth/callback` must be registered with your identity provider. Session cookies are marked `Secure`, so sign-in only sticks over HTTPS; the plain internal address is only good for `/healthz` checks.

**Data.** The synced copy of the vault lives in `/opt/docker/appdata/obsidianweb/data` (mounted at `/data`). It is safe to delete: the next sync rebuilds it.

**Updating.** Push to `main`, then **Deploy** the stack again. Komodo pulls the repo and rebuilds the image.

**Notes.**
- Don't edit the stack's Environment through an API or MCP tool that returns masked secrets: writing the text back would replace your real token and secret with the masked placeholders. Use the Komodo UI.
- With `docker compose` directly: `docker compose -f komodo.compose.yml --env-file .env up -d --build`.

### Editing on the hosted site
Set `ALLOW_WRITE=1` on the server (it is off by default; the static Pages site is always read-only). In **Web** mode on a desktop browser you then get:
- **Edit** on any page: a markdown editor with live preview, **Save** (or Ctrl/Cmd+S), **Discard**, and a warning before you leave with unsaved changes.
- **Attachments:** paste or drop an image (or PDF, mp3, mp4, webm) into the editor, or use **Attach**. It is uploaded to your vault's attachment folder (the `attachmentFolderPath` from `.obsidian/app.json`, or `ATTACHMENT_FOLDER`), named like Obsidian does (`Pasted image 20260926143553.png` for clipboard images, a numeric suffix if the name is taken), and an `![[embed]]` is inserted at the cursor. 10 MB per file; other file types are refused.
- **Page** and **Folder** buttons at the top of the navigation to create pages and folders (new folders are created as needed; a new page opens straight in the editor).
- **Rename** (also moves a page to another folder) and **Delete** on the page toolbar. Hovering a folder in the navigation (either mode) shows **rename or move** and, for empty folders, **delete**. Renaming a folder moves everything inside it.
- **Phones can edit too**: the editor takes the full width (use **Preview** to see the result) and Attach works with the camera roll.

**Conflicts.** When you save, the server first checks the stored version of the note. If it changed since you opened it (for example you edited it in Obsidian meanwhile), nothing is saved and you get a warning with **Show differences**, **Overwrite with my version**, **Load their version**, **Copy my text** and **Keep editing**.

**With Fast Note Sync**, changes are written to FNS through its REST API, so your Obsidian apps receive them through their normal sync, and every save shows up in FNS's own history. **Who made the edit:** each request carries the signed-in person's name and email in the client *name* (for example `ObsidianWeb (Ada Lovelace (ada@example.com))`), so FNS's access log and the note's history show the individual, not just "ObsidianWeb". The client *type* stays `ObsidianWeb` because the token is restricted to it, unless you turn on `FNS_CLIENT_PER_USER=1`: the type then becomes `ObsidianWeb-<person>` (give the token the Client restriction `ObsidianWeb*` first). The name comes from your identity provider's `name` and `email` claims (request the `profile email` scopes, which is the default), so it is only as trustworthy as this server: FNS itself only sees one token. The FNS token must allow writes: in the FNS admin panel give it **Note: Read/Write** (Attachment can stay read-only; folder creation uses the same permission), with the REST protocol, your vault, and a Client restriction of `ObsidianWeb` (or `*`). Deleted pages go to FNS's recycle bin. If FNS refuses a write you will see its error (code 315 means the token isn't allowed to write).

**With git**, each change is a commit in your vault repository, authored by the signed-in person (`Name <email>`) with the server's own git identity as committer (pushing is up to you). Empty folders exist only on disk until a page is added.

**Safety.** Every signed-in user can edit (roles are on the roadmap). Writes only touch `.md` files, refuse odd paths, are limited to 2 MB per note, and refuse requests that come from another website. Not covered yet: replacing or deleting attachments, and editing on the static GitHub Pages site.

**Folder rename with FNS** has no single FNS call, so the server moves each note and attachment one at a time and then removes the old folder. If FNS refuses part-way, you get an error saying how many items moved and the rest stay where they were.

> Verified against the mock FNS (`scripts/mock-fns.mjs` with `MOCK_WRITE=1`: create, edit, conflict, overwrite, rename, delete, folders, uploads, folder rename, permission errors) and against a git repository. Try it first on a scratch page in your real vault.

---

## Using the UI
- **Web / Obsidian** toggle: top right. Your choice is remembered in the browser; the default for new visitors comes from `DEFAULT_LAYOUT`.
- **Search**: top bar, `/` or `Ctrl/Cmd+K`. Matches note names and text.
- **Show raw**: toolbar button, shows the markdown source (including frontmatter).
- **History**: right panel. Click a commit to view that version and see a diff against the current one.
- **Navigation (Web mode)**: compact folder menu; opening a page expands only the folders that hold it and collapses the rest, and you can open or close any section by clicking its heading until the next page change.
- **Phones (under 800px wide)**: always the Web layout, with a bottom bar (Pages, Search, Home, Contents, More), a slide-out page menu, and a bottom sheet for outline, backlinks, tags and history. Sync now, Settings and Sign out are under **More**.
- **Split** (Obsidian mode): open a second note beside the current one, or use the ⧉ icon on a tab.
- **Edit** (Obsidian mode, server with `ALLOW_WRITE=1`): editor with live preview; `Ctrl/Cmd+S` saves and commits. In static mode the editor is view-only and nothing is saved.
- **Settings**: theme, accent color, default view, and reading options for readability: text font (system, serif, humanist, high-legibility, dyslexia-friendly, monospace, or any font installed on your device by name), text size, line spacing, letter spacing, text width, code font, and an optional "use this font for menus too" switch. A live preview shows the result. Only fonts already installed on the device are used, nothing is downloaded. Stored in the browser only.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Pages site is a 404 | Pages source is not **GitHub Actions**, or the first run predates that setting. Change it and re-run the workflow. |
| Old version still showing after a deploy | Browser cache (GitHub Pages caches for 10 minutes); hard refresh or use a private window. |
| Pages site shows the README instead of the app, and `config.json` on the site is a 404 | The Pages source is **Deploy from a branch**, so GitHub's built-in Jekyll job (`pages build and deployment`) races the workflow. Set Settings → Pages → Source to **GitHub Actions**, then re-run **Deploy to Pages** (not the Jekyll job) |
| FNS sync error `code 307` | Token not accepted: wrong token or header (the server sends `Authorization: Bearer`). Make a new token in the FNS admin panel |
| FNS sync error `code 314` or `315` | The token's Client, protocol, function or vault restriction doesn't allow the request. Client restriction must equal `FNS_CLIENT` (default `ObsidianWeb`) or `*`; allow REST, note and attachment read, and the vault. FNS returns these in an HTTP 200 body |
| Sign-in loop or `Sign-in expired` | `PUBLIC_URL` doesn't match the address you use (scheme, host or port), or you opened the plain `http://` address so the Secure cookie was dropped |
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
- **Editing on the hosted site.** Done: edit, new page and folder, rename, delete, conflict warning, attachment upload, folder rename and delete, editing on phones (see [Editing on the hosted site](#editing-on-the-hosted-site)). Still to do:
  - Replacing and deleting attachments.
  - Editing on the static GitHub Pages site through the GitHub API (needs a personal access token in the browser).
  - Editing permission by role (needs the roles work below).

### Both modes
- **Mobile-friendly view.** First version done: phones (under 800px) get the Web layout with a bottom navigation bar, a slide-out page menu, a bottom sheet for outline, backlinks, tags and history, larger touch targets, and grids and tables that stack or scroll. Ideas still open:
  - Swipe gestures to open and close the drawers.
  - A tablet layout between phone and desktop.
  - An option to use the Obsidian layout on a phone (today phones always get the Web layout).
  - Installable web app (home-screen icon, offline reading).
  - PDFs on iOS only show the first page inside a frame, so open them in a new tab or a dedicated viewer.

## Contributing
Issues and PRs are welcome. `npm run typecheck` checks the app and server. GitHub Actions runs the typecheck and build on pull requests (`ci.yml`), and the Pages workflow typechecks before it deploys `main`, so a type error fails the build instead of shipping.

## License
[MIT](LICENSE) © 2026 Danny Cherry. Fork and modify freely. Third-party dependencies keep their own licenses (MIT, BSD, Apache-2.0, MPL-2.0).

The sample notes in `vault/` are test content and are covered by the same license.
