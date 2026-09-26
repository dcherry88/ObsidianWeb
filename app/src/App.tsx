import { useEffect, useMemo, useState } from "preact/hooks";
import { diffLines } from "diff";
import type { AppConfig, Commit, VaultProvider } from "../../shared/types";
import { loadProvider } from "./providers";
import { outline, renderMarkdown, slug, splitFrontmatter } from "./md";
import { Editor } from "./Editor";
import { NavMenu, Tree } from "./Tree";

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
const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

export function App() {
  const [boot, setBoot] = useState<{ cfg: AppConfig; provider: VaultProvider } | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [err, setErr] = useState("");

  const [current, setCurrent] = useState(pathFromHash());
  const [tabs, setTabs] = useState<string[]>(store.get("tabs", []));
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit" | "raw">("preview");
  const [layout, setLayout] = useState<"doc" | "vault">(store.get("layout", "doc"));
  const [closedNav, setClosedNav] = useState<Set<string>>(new Set(store.get<string[]>("closedNav", [])));
  const [sideView, setSideView] = useState<"tree" | "nav">(store.get("sideView", "tree"));
  const [showSide, setShowSide] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [rightTab, setRightTab] = useState<"outline" | "history">("outline");
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
          const home = ["index.md", "README.md", "Home.md", "Welcome.md"].find((h) => t.includes(h)) ?? t[0];
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
    provider.read(current).then(setContent).catch((e) => setContent(`*Could not load: ${e}*`));
    provider.history(current).then(setCommits).catch(() => setCommits([]));
  }, [provider, current]);

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
    setClosedNav((o) => {
      const n = new Set(o);
      n.has(p) ? n.delete(p) : n.add(p);
      store.set("closedNav", [...n]);
      return n;
    });
  const html = useMemo(() => renderMarkdown(selected ? oldContent : text, files), [text, files, selected, oldContent]);
  const splitHtml = useMemo(() => (split ? renderMarkdown(splitContent, files) : ""), [split, splitContent, files]);
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

  const dirty = draft !== null && draft !== content;
  const save = async () => {
    if (!provider || !dirty) return;
    try {
      await provider.write(current, draft!);
      setContent(draft!);
      setDraft(null);
      setStatus("Saved & committed");
      provider.history(current).then(setCommits);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const shown = files.filter((f) => f.toLowerCase().includes(search.toLowerCase()));

  if (err) return <div class="center">Failed to load vault: {err}</div>;
  if (!boot) return <div class="center">Loading…</div>;

  const diff = selected ? diffLines(oldContent, text) : null;

  return (
    <div class={"shell " + (layout === "doc" ? "doc-mode" : "vault-mode")}>
      <div class="ribbon">
        <button title="Toggle sidebar" onClick={() => setShowSide(!showSide)}>☰</button>
        {layout === "vault" && (
          <>
            <button title="File tree" class={sideView === "tree" ? "on" : ""} onClick={() => (setSideView("tree"), store.set("sideView", "tree"))}>🗂</button>
            <button title="Navbar (flat list + search)" class={sideView === "nav" ? "on" : ""} onClick={() => (setSideView("nav"), store.set("sideView", "nav"))}>🔎</button>
          </>
        )}
        <button title={layout === "doc" ? "Switch to Obsidian mode (tabs, split, editor)" : "Switch to Doc Site mode"} onClick={() => setLayoutPersist(layout === "doc" ? "vault" : "doc")}>
          {layout === "doc" ? "📖" : "🗃"}
        </button>
        <span class="grow" />
        <button title="Toggle right panel" onClick={() => setShowRight(!showRight)}>▤</button>
      </div>

      {showSide && (
        <aside class="side">
          {layout === "doc" && <div class="site-title">Docs</div>}
          {layout === "vault" && sideView === "nav" && (
            <input class="search" placeholder="Search files…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          )}
          <div class="scroll">
            {layout === "doc" ? (
              <NavMenu files={files} closed={closedNav} toggle={toggleNav} current={current} onOpen={go} />
            ) : sideView === "tree" ? (
              <Tree files={files} open={open} toggle={toggle} current={current} onOpen={go} />
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
              <span class="x" onClick={(e) => (e.stopPropagation(), closeTab(t))}>×</span>
            </div>
          ))}
        </div>}

        {current ? (
          <>
            <div class="toolbar">
              <span class="crumb">{layout === "doc" ? current.replace(/\.md$/, "").split("/").join(" › ") : current}</span>
              <span class="grow" />
              {status && <span class="status">{status}</span>}
              {mode === "edit" && boot.provider.canWrite && (
                <button disabled={!dirty} onClick={save}>Save</button>
              )}
              <button class={mode === "raw" ? "on" : ""} onClick={() => (setStatus(""), setMode(mode === "raw" ? "preview" : "raw"))}>
                {mode === "raw" ? "Rendered" : "Show raw"}
              </button>
              {layout === "vault" && (
                <button class={split ? "on" : ""} title="Split view: show a second note side by side" onClick={() => setSplit(split ? null : tabs.find((t) => t !== current) ?? current)}>
                  {split ? "Close split" : "Split"}
                </button>
              )}
              {layout === "vault" && (
                <button
                  onClick={() => {
                    setSelected(null);
                    setMode(mode === "edit" ? "preview" : "edit");
                    setStatus(mode !== "edit" && !boot.provider.canWrite ? "Read-only in this mode (edits not saved)" : "");
                  }}
                >
                  {mode === "edit" ? "Preview" : "Edit"}
                </button>
              )}
            </div>
            <div class="panes">
            <div class="pane scroll doc">
              {selected && (
                <div class="banner">
                  Viewing {selected.sha.slice(0, 7)} ({new Date(selected.date).toLocaleString()}) · <a onClick={() => setSelected(null)}>back to current</a>
                </div>
              )}
              {mode === "raw" ? (
                <pre class="raw">{shownRaw}</pre>
              ) : mode === "edit" && !selected ? (
                <div class="edit-split">
                  <Editor key={current} value={text} onChange={setDraft} onSave={save} />
                  <article class="md live" dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              ) : (
                <article class="md">
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
                    {files.map((f) => <option value={f}>{f}</option>)}
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
          <div class="tabs small">
            <div class={"tab" + (rightTab === "outline" ? " active" : "")} onClick={() => setRightTab("outline")}>{layout === "doc" ? "On this page" : "Outline"}</div>
            <div class={"tab" + (rightTab === "history" ? " active" : "")} onClick={() => setRightTab("history")}>History</div>
          </div>
          <div class="scroll">
            {rightTab === "outline" &&
              heads.map((h) => (
                <div class="row" style={{ paddingLeft: 8 + (h.level - 1) * 12 }} onClick={() => document.getElementById(slug(h.text))?.scrollIntoView({ behavior: "smooth" })}>
                  {h.text}
                </div>
              ))}
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
  );
}
