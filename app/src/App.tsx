import { useEffect, useMemo, useState } from "preact/hooks";
import { diffLines } from "diff";
import type { AppConfig, Commit, VaultProvider } from "../../shared/types";
import { loadProvider, syncNow } from "./providers";
import { outline, renderMarkdown, slug, splitFrontmatter, type RenderCtx } from "./md";
import { Editor } from "./Editor";
import { NavMenu, Tree } from "./Tree";
import { Search } from "./Search";
import { useNoteIndex, useNoteTexts, frontmatterTags, inlineTags } from "./notes";

const store = {
  get: <T,>(k: string, d: T): T => {
    try {
      const v = localStorage.getItem("ow:" + k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: unknown) => {
    try {
      localStorage.setItem("ow:" + k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

const pathFromHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));
const isPdf = (p: string) => /\.pdf$/i.test(p);
const ancestorsOf = (p: string) => {
  const parts = p.split("/").slice(0, -1);
  return new Set(parts.map((_, i) => parts.slice(0, i + 1).join("/")));
};
const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

function RibbonBtn(p: { icon: string; label: string; tip: string; on?: boolean; onClick: () => void }) {
  return (
    <button class={"rbtn" + (p.on ? " on" : "")} title={p.tip} aria-label={p.tip} onClick={p.onClick}>
      <span class="ico">{p.icon}</span>
      <span class="lbl">{p.label}</span>
    </button>
  );
}

const MOBILE_Q = "(max-width: 800px)";
function useMobile() {
  const [m, setM] = useState(() => typeof matchMedia !== "undefined" && matchMedia(MOBILE_Q).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_Q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function App() {
  const [boot, setBoot] = useState<{ cfg: AppConfig; provider: VaultProvider } | null>(null);
  const [allFiles, setFiles] = useState<string[]>([]);
  const files = useMemo(() => allFiles.filter((f) => f.endsWith(".md")), [allFiles]);
  // notes and PDFs are browsable pages; other attachments are only referenced from notes
  const navFiles = useMemo(() => allFiles.filter((f) => f.endsWith(".md") || isPdf(f)), [allFiles]);
  const [theme, setTheme] = useState<string>(store.get("theme", "system"));
  const [accent, setAccent] = useState<string>(store.get("accent", ""));
  const [showSettings, setShowSettings] = useState(false);
  const [err, setErr] = useState("");

  const [current, setCurrent] = useState(pathFromHash());
  const [tabs, setTabs] = useState<string[]>(store.get("tabs", []));
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit" | "raw">("preview");
  const [layoutPref, setLayout] = useState<"doc" | "vault">(store.get("layout", "doc"));
  // phones always get the Web layout (tabs, split panes and the editor need a wide screen); the saved choice still applies on desktop
  const mobile = useMobile();
  const layout = mobile ? "doc" : layoutPref;
  const [moreOpen, setMoreOpen] = useState(false);
  // Web-mode nav: only the folders holding the current page are open; clicking a heading opens/closes it until the next page change
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [openNav, setOpenNav] = useState<Set<string>>(new Set());
  const [sideView, setSideView] = useState<"tree" | "nav">(store.get("sideView", "tree"));
  // on phones the side and right panels are drawers, closed by default
  const [showSide, setShowSide] = useState(() => !(typeof matchMedia !== "undefined" && matchMedia(MOBILE_Q).matches));
  const [showRight, setShowRight] = useState(() => !(typeof matchMedia !== "undefined" && matchMedia(MOBILE_Q).matches));
  const [rightTab, setRightTab] = useState<"outline" | "backlinks" | "tags" | "history">("outline");
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set(store.get<string[]>("open", [])));
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [oldContent, setOldContent] = useState("");
  const [status, setStatus] = useState("");
  const [split, setSplit] = useState<string | null>(null);
  const [splitContent, setSplitContent] = useState("");

  useEffect(() => {
    loadProvider()
      .then(async (b) => {
        setBoot(b);
        const t = await b.provider.tree();
        setFiles(t);
        if (!localStorage.getItem("ow:layout") && b.cfg.defaultLayout) setLayout(b.cfg.defaultLayout);
        if (!pathFromHash()) {
          const home = ["index.md", "README.md", "Home.md", "Welcome.md"].find((h) => t.includes(h)) ?? t.find((f) => f.endsWith(".md"));
          if (home) location.replace("#/" + home.split("/").map(encodeURIComponent).join("/"));
        }
      })
      .catch((e) => setErr(String(e)));
    const onHash = () => setCurrent(pathFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const provider = boot?.provider;

  // load file + history when path changes
  useEffect(() => {
    if (!provider || !current) return;
    setSelected(null);
    setDraft(null);
    setMode("preview");
    if (isPdf(current)) {
      setContent("");
      setCommits([]);
      return;
    }
    provider.read(current).then(setContent).catch((e) => setContent(`*Could not load: ${e}*`));
    provider.history(current).then(setCommits).catch(() => setCommits([]));
  }, [provider, current]);

  useEffect(() => setOpenNav(ancestorsOf(current)), [current]);

  // switching between phone and desktop sizes: drawers closed on phones, panels open on desktop
  useEffect(() => {
    setShowSide(!mobile);
    setShowRight(!mobile);
    setMoreOpen(false);
  }, [mobile]);
  // opening a page closes the drawers
  useEffect(() => {
    if (mobile) {
      setShowSide(false);
      setShowRight(false);
    }
  }, [current]);

  // <div class="pdf-embed" data-src> placeholders (produced by the markdown renderer) become real PDF viewers
  const pdfKey = current + "|" + mode + "|" + (selected?.sha ?? "");

  useEffect(() => {
    if (!provider || !selected) return;
    provider.read(current, selected.sha).then(setOldContent).catch((e) => setOldContent(String(e)));
  }, [selected]);

  // tabs exist only in Obsidian mode; make sure the open page has one
  useEffect(() => {
    if (layout !== "vault" || !current) return;
    setTabs((t) => {
      if (t.includes(current)) return t;
      const n = [...t, current];
      store.set("tabs", n);
      return n;
    });
  }, [layout, current]);

  useEffect(() => {
    if (!provider || !split) return;
    provider.read(split).then(setSplitContent).catch((e) => setSplitContent(`*Could not load: ${e}*`));
  }, [provider, split]);

  const text = draft ?? content;
  const shownRaw = selected ? oldContent : text;
  const setLayoutPersist = (l: "doc" | "vault") => {
    setLayout(l);
    store.set("layout", l);
    if (l === "doc") {
      setSplit(null);
      if (mode === "edit") setMode("preview");
    }
  };
  const toggleNav = (p: string) =>
    setOpenNav((o) => {
      const n = new Set(o);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const ctxFor = (p: string): RenderCtx | undefined =>
    provider && { all: allFiles, current: p, attachmentFolder: boot?.cfg.obsidian?.attachmentFolderPath, assetUrl: provider.assetUrl };
  const html = useMemo(() => renderMarkdown(selected ? oldContent : text, files, ctxFor(current)), [text, files, allFiles, selected, oldContent, current, boot]);
  const splitHtml = useMemo(() => (split ? renderMarkdown(splitContent, files, ctxFor(split)) : ""), [split, splitContent, files, allFiles, boot]);

  useEffect(() => {
    const root = document.documentElement;
    theme === "system" ? root.removeAttribute("data-theme") : root.setAttribute("data-theme", theme);
    accent ? root.style.setProperty("--accent", accent) : root.style.removeProperty("--accent");
    store.set("theme", theme);
    store.set("accent", accent);
  }, [theme, accent]);
  useEffect(() => {
    document.querySelectorAll<HTMLElement>(".pdf-embed[data-src]").forEach((el) => {
      if (el.querySelector("iframe")) return;
      const f = document.createElement("iframe");
      f.src = el.dataset.src!;
      f.title = el.dataset.title || "PDF";
      f.loading = "lazy";
      el.appendChild(f);
    });
  }, [html, splitHtml, pdfKey]);

  const { texts, update: updateText } = useNoteTexts(provider, files);
  const index = useNoteIndex(texts, files);
  const myBacklinks = index.backlinks.get(current) ?? [];
  const myTags = useMemo(() => [...new Set([...frontmatterTags(text), ...inlineTags(text)])], [text]);
  const allTags = useMemo(() => [...index.tags.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])), [index]);
  const heads = useMemo(() => outline(splitFrontmatter(text).body), [text]);
  const fm = splitFrontmatter(text).fm;

  const go = (p: string) => (location.hash = "#/" + p.split("/").map(encodeURIComponent).join("/"));
  const toggle = (p: string) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(p) ? n.delete(p) : n.add(p);
      store.set("open", [...n]);
      return n;
    });
  const closeTab = (p: string) => {
    const n = tabs.filter((t) => t !== p);
    setTabs(n);
    store.set("tabs", n);
    if (p === current) n.length ? go(n[n.length - 1]) : (location.hash = "");
  };

  const forceSync = async () => {
    if (!provider || syncing) return;
    setSyncing(true);
    setSyncMsg("");
    try {
      const r = await syncNow();
      if (!r.ok) throw new Error(r.error || "sync failed");
      setFiles(await provider.tree());
      if (current && !isPdf(current) && draft === null) provider.read(current).then(setContent).catch(() => {});
      if (current && !isPdf(current)) provider.history(current).then(setCommits).catch(() => {});
      setSyncMsg(r.changed ? `Synced: ${r.changed} change${r.changed === 1 ? "" : "s"}` : "Already up to date");
    } catch (e) {
      setSyncMsg("Sync failed: " + String((e as Error).message ?? e).slice(0, 120));
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 8000);
    }
  };

  const dirty = draft !== null && draft !== content;
  const save = async () => {
    if (!provider || !dirty) return;
    try {
      await provider.write(current, draft!);
      setContent(draft!);
      updateText(current, draft!);
      setDraft(null);
      setStatus("Saved & committed");
      provider.history(current).then(setCommits);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const shown = navFiles.filter((f) => f.toLowerCase().includes(search.toLowerCase()));

  if (err) return <div class="center">Failed to load vault: {err}</div>;
  if (!boot) return <div class="center">Loading…</div>;

  const diff = selected ? diffLines(oldContent, text) : null;

  return (
    <div class={"app " + (layout === "doc" ? "web" : "obs") + (mobile ? " mobile" : "")}>
      <header class="topbar">
        {layout === "doc" && (
          <button class="tb-btn menu-btn" title="Show or hide the navigation menu" aria-label="Navigation menu" onClick={() => (setShowSide(!showSide), setShowRight(false), setMoreOpen(false))}>{mobile ? "☰" : "☰ Menu"}</button>
        )}
        <span class="brand" title="Home" onClick={() => location.assign("#/")}>ObsidianWeb</span>
        {!mobile && (
          <div class="seg" role="group" aria-label="View mode">
            <button class={layout === "doc" ? "on" : ""} title="Web mode: a wiki-style site, one page at a time" onClick={() => setLayoutPersist("doc")}>Web</button>
            <button class={layout === "vault" ? "on" : ""} title="Obsidian mode: tabs, split view and editor" onClick={() => setLayoutPersist("vault")}>Obsidian</button>
          </div>
        )}
        <Search notes={navFiles} indexTotal={files.length} texts={texts} noteTags={index.noteTags} allTags={allTags} onOpen={go} />
        <span class="grow" />
        {syncMsg && <span class="sync-msg">{syncMsg}</span>}
        {mobile ? (
          <div class="more">
            <button class="tb-btn" title="More: page outline, sync, settings" aria-label="More" onClick={() => setMoreOpen(!moreOpen)}>⋯</button>
            {moreOpen && (
              <div class="more-menu" onClick={() => setMoreOpen(false)}>
                <button onClick={() => (setShowRight(true), setShowSide(false))}>On this page</button>
                {boot.cfg.canSync && (
                  <button disabled={syncing} onClick={forceSync}>{syncing ? "Syncing…" : "↻ Sync now"}</button>
                )}
                <button onClick={() => setShowSettings(true)}>⚙ Settings</button>
              </div>
            )}
          </div>
        ) : (
          <>
            {boot.cfg.canSync && (
              <button class="tb-btn" disabled={syncing} title="Pull the latest changes from Fast Note Sync now (it also syncs automatically every minute)" onClick={forceSync}>
                {syncing ? "Syncing…" : "↻ Sync now"}
              </button>
            )}
            {layout === "doc" && (
              <>
                <button class="tb-btn" title="Show or hide the 'On this page' and History panel" onClick={() => setShowRight(!showRight)}>On this page</button>
                <button class="tb-btn" title="Theme, colors and default view" onClick={() => setShowSettings(true)}>⚙ Settings</button>
              </>
            )}
          </>
        )}
      </header>
      {mobile && (showSide || showRight) && <div class="backdrop" onClick={() => (setShowSide(false), setShowRight(false))} />}
    <div class={"shell " + (layout === "doc" ? "doc-mode" : "vault-mode")}>
      {layout === "vault" && <div class="ribbon">
        <RibbonBtn icon="☰" label="Sidebar" tip="Show or hide the left sidebar" onClick={() => setShowSide(!showSide)} />
        {layout === "vault" && (
          <>
            <RibbonBtn icon="🗂" label="Files" tip="File tree view of the vault folders" on={sideView === "tree"} onClick={() => (setSideView("tree"), store.set("sideView", "tree"))} />
            <RibbonBtn icon="🔎" label="List" tip="Flat list of all notes, filterable" on={sideView === "nav"} onClick={() => (setSideView("nav"), store.set("sideView", "nav"))} />
          </>
        )}
        <span class="grow" />
        <RibbonBtn icon="▤" label="Panel" tip="Show or hide the right panel (outline and history)" onClick={() => setShowRight(!showRight)} />
        <RibbonBtn icon="⚙" label="Settings" tip="Theme, colors and default view" on={showSettings} onClick={() => setShowSettings(true)} />
      </div>}

      {showSettings && (
        <div class="overlay" onClick={() => setShowSettings(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-head">
              <b>Settings</b>
              <span class="grow" />
              <button title="Close settings" onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <label title="Color scheme for the whole site">
              Theme
              <select value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)}>
                <option value="system">System (follow OS)</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="nord">Nord</option>
                <option value="solarized">Solarized Dark</option>
                <option value="sepia">Sepia</option>
              </select>
            </label>
            <label title="Highlight color for links, tags and the active page">
              Accent color
              <span>
                <input type="color" value={accent || "#a78bfa"} onInput={(e) => setAccent((e.target as HTMLInputElement).value)} />
                {accent && <button title="Use the theme's accent color" onClick={() => setAccent("")}>Reset</button>}
              </span>
            </label>
            <label title="Which layout opens by default on this device">
              Default view
              <select value={layout} onChange={(e) => setLayoutPersist((e.target as HTMLSelectElement).value as "doc" | "vault")}>
                <option value="doc">Web mode (Doc Site)</option>
                <option value="vault">Obsidian mode</option>
              </select>
            </label>
            <div class="muted small">
              Vault attachment folder (from .obsidian/app.json): <code>{boot.cfg.obsidian?.attachmentFolderPath ?? "not set"}</code>
            </div>
            {boot.cfg.user && (
              <div class="small">
                Signed in as <b>{boot.cfg.user.name || boot.cfg.user.email || "user"}</b>
                {boot.cfg.signOutUrl && <> · <a href={boot.cfg.signOutUrl}>Sign out</a></>}
              </div>
            )}
            <div class="muted small">Theme and view settings are saved in this browser only.</div>
          </div>
        </div>
      )}

      {showSide && (
        <aside class="side">
          {mobile && <div class="drawer-head"><b>Pages</b><button title="Close" onClick={() => setShowSide(false)}>✕</button></div>}
          {layout === "doc" && <div class="site-title">Docs</div>}
          {layout === "vault" && sideView === "nav" && (
            <input class="search" placeholder="Search files…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          )}
          <div class="scroll">
            {layout === "doc" ? (
              <NavMenu files={navFiles} open={openNav} toggle={toggleNav} current={current} onOpen={go} />
            ) : sideView === "tree" ? (
              <Tree files={navFiles} open={open} toggle={toggle} current={current} onOpen={go} />
            ) : (
              shown.map((f) => (
                <div class={"row file nav" + (f === current ? " active" : "")} onClick={() => go(f)}>
                  <div>{title(f)}</div>
                  <small>{f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""}</small>
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <main class="main">
        {layout === "vault" && <div class="tabs">
          {tabs.map((t) => (
            <div class={"tab" + (t === current ? " active" : "")} onClick={() => go(t)}>
              {title(t)}
              <span class="x" title="Open in split pane" onClick={(e) => (e.stopPropagation(), setSplit(t))}>⧉</span>
              <span class="x" title="Close tab" onClick={(e) => (e.stopPropagation(), closeTab(t))}>×</span>
            </div>
          ))}
        </div>}

        {current ? (
          <>
            <div class="toolbar">
              <span class="crumb">{layout === "doc" ? current.replace(/\.md$/, "").split("/").join(" › ") : current}</span>
              <span class="grow" />
              {isPdf(current) ? (
                <a class="tb-link" href={boot.provider.assetUrl(current)} target="_blank" rel="noopener" title="Open this PDF in its own browser tab">Open in new tab</a>
              ) : (
                <>
              {status && <span class="status">{status}</span>}
              {mode === "edit" && boot.provider.canWrite && (
                <button disabled={!dirty} title="Save and commit this note (Ctrl/Cmd+S)" onClick={save}>Save</button>
              )}
              <button class={mode === "raw" ? "on" : ""} title="Toggle between the rendered page and the raw markdown source" onClick={() => (setStatus(""), setMode(mode === "raw" ? "preview" : "raw"))}>
                {mode === "raw" ? "Rendered" : "Show raw"}
              </button>
              {layout === "vault" && (
                <button class={split ? "on" : ""} title="Split view: show a second note side by side" onClick={() => setSplit(split ? null : tabs.find((t) => t !== current) ?? current)}>
                  {split ? "Close split" : "Split"}
                </button>
              )}
              {layout === "vault" && (
                <button
                  title="Edit this note in a markdown editor with live preview"
                  onClick={() => {
                    setSelected(null);
                    setMode(mode === "edit" ? "preview" : "edit");
                    setStatus(mode !== "edit" && !boot.provider.canWrite ? "Read-only in this mode (edits not saved)" : "");
                  }}
                >
                  {mode === "edit" ? "Preview" : "Edit"}
                </button>
              )}
                </>
              )}
            </div>
            <div class="panes">
            <div class="pane scroll doc">
              {selected && (
                <div class="banner">
                  Viewing {selected.sha.slice(0, 7)} ({new Date(selected.date).toLocaleString()}) · <a onClick={() => setSelected(null)}>back to current</a>
                </div>
              )}
              {isPdf(current) ? (
                <iframe class="pdf-page" src={boot.provider.assetUrl(current)} title={current} />
              ) : mode === "raw" ? (
                <pre class="raw">{shownRaw}</pre>
              ) : mode === "edit" && !selected ? (
                <div class="edit-split">
                  <Editor key={current} value={text} onChange={setDraft} onSave={save} />
                  <article class="md live" dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              ) : (
                <article class="md" onClick={(e) => {
                  const t = (e.target as HTMLElement).closest?.(".tag[data-tag]") as HTMLElement | null;
                  if (t) (setOpenTag(t.dataset.tag!), setRightTab("tags"), setShowRight(true));
                }}>
                  {fm && !selected && <pre class="fm">{fm}</pre>}
                  <div dangerouslySetInnerHTML={{ __html: html }} />
                </article>
              )}
            </div>
            {split && layout === "vault" && (
              <div class="pane split-pane">
                <div class="split-head">
                  <span class="crumb">{split}</span>
                  <span class="grow" />
                  <select value={split} onChange={(e) => setSplit((e.target as HTMLSelectElement).value)}>
                    {navFiles.filter((f) => !isPdf(f)).map((f) => <option value={f}>{f}</option>)}
                  </select>
                  <button onClick={() => go(split)} title="Open in main pane">↤</button>
                  <button onClick={() => setSplit(null)} title="Close split">×</button>
                </div>
                <div class="scroll">
                  <article class="md" dangerouslySetInnerHTML={{ __html: splitHtml }} />
                </div>
              </div>
            )}
            </div>
          </>
        ) : (
          <div class="center">Pick a note from the sidebar.</div>
        )}
      </main>

      {showRight && (
        <aside class="right">
          {mobile && <div class="drawer-head"><b>This page</b><button title="Close" onClick={() => setShowRight(false)}>✕</button></div>}
          <div class="tabs small">
            <div class={"tab" + (rightTab === "outline" ? " active" : "")} onClick={() => setRightTab("outline")}>{layout === "doc" ? "On this page" : "Outline"}</div>
            <div class={"tab" + (rightTab === "backlinks" ? " active" : "")} title="Notes that link to this one" onClick={() => setRightTab("backlinks")}>Backlinks{myBacklinks.length ? ` (${myBacklinks.length})` : ""}</div>
            <div class={"tab" + (rightTab === "tags" ? " active" : "")} title="Tags in this note and across the vault" onClick={() => setRightTab("tags")}>Tags</div>
            <div class={"tab" + (rightTab === "history" ? " active" : "")} title="Git history of this note" onClick={() => setRightTab("history")}>History</div>
          </div>
          <div class="scroll">
            {rightTab === "outline" &&
              heads.map((h) => (
                <div class="row" style={{ paddingLeft: 8 + (h.level - 1) * 12 }} onClick={() => (mobile && setShowRight(false), document.getElementById(slug(h.text))?.scrollIntoView({ behavior: "smooth" }))}>
                  {h.text}
                </div>
              ))}
            {rightTab === "backlinks" && (
              <>
                {!myBacklinks.length && <div class="muted pad">{texts.size < files.length ? "Indexing links…" : "No notes link here."}</div>}
                {myBacklinks.map((b) => (
                  <div class="row commit" title={b.from} onClick={() => go(b.from)}>
                    <div>{title(b.from)} <small>{b.from.includes("/") ? b.from.slice(0, b.from.lastIndexOf("/")) : ""}</small></div>
                    {b.snippet && <small>{b.snippet}</small>}
                  </div>
                ))}
              </>
            )}
            {rightTab === "tags" && (
              <>
                <div class="muted pad small">This note</div>
                <div class="pad tagcloud">
                  {!myTags.length && <span class="muted">No tags</span>}
                  {myTags.map((t) => <span class="tag click" onClick={() => (setOpenTag(t), setRightTab("tags"))}>#{t}</span>)}
                </div>
                <div class="muted pad small">All tags</div>
                {allTags.map(([t, paths]) => (
                  <div>
                    <div class={"row" + (openTag === t ? " active" : "")} onClick={() => setOpenTag(openTag === t ? null : t)}>
                      #{t} <small class="cnt">{paths.length}</small>
                    </div>
                    {openTag === t && paths.map((p) => <div class="row nav-sub" onClick={() => go(p)}>{title(p)}</div>)}
                  </div>
                ))}
              </>
            )}
            {rightTab === "history" && (
              <>
                {!commits.length && <div class="muted pad">No history for this file.</div>}
                {commits.map((c) => (
                  <div class={"row commit" + (selected?.sha === c.sha ? " active" : "")} onClick={() => (setMode("preview"), setSelected(c))}>
                    <div>{c.message}</div>
                    <small>{c.author} · {new Date(c.date).toLocaleDateString()} · {c.sha.slice(0, 7)}</small>
                  </div>
                ))}
                {diff && (
                  <div class="diff">
                    <div class="muted pad">Diff: {selected!.sha.slice(0, 7)} → current</div>
                    {diff.map((p) => (
                      <pre class={p.added ? "add" : p.removed ? "del" : "same"}>{p.value}</pre>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      )}
    </div>
    </div>
  );
}
