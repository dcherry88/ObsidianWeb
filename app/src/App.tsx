import { useEffect, useMemo, useState } from "preact/hooks";
import { diffLines } from "diff";
import type { AppConfig, Commit, VaultProvider } from "../../shared/types";
import { loadProvider } from "./providers";
import { outline, renderMarkdown, slug, splitFrontmatter } from "./md";
import { Editor } from "./Editor";
import { Tree } from "./Tree";

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
  const [mode, setMode] = useState<"preview" | "edit">("preview");
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

  useEffect(() => {
    loadProvider()
      .then(async (b) => {
        setBoot(b);
        setFiles(await b.provider.tree());
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
    setTabs((t) => {
      const n = t.includes(current) ? t : [...t, current];
      store.set("tabs", n);
      return n;
    });
    provider.read(current).then(setContent).catch((e) => setContent(`*Could not load: ${e}*`));
    provider.history(current).then(setCommits).catch(() => setCommits([]));
  }, [provider, current]);

  useEffect(() => {
    if (!provider || !selected) return;
    provider.read(current, selected.sha).then(setOldContent).catch((e) => setOldContent(String(e)));
  }, [selected]);

  const text = draft ?? content;
  const html = useMemo(() => renderMarkdown(selected ? oldContent : text, files), [text, files, selected, oldContent]);
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
    <div class="shell">
      <div class="ribbon">
        <button title="Toggle sidebar" onClick={() => setShowSide(!showSide)}>☰</button>
        <button title="File tree" class={sideView === "tree" ? "on" : ""} onClick={() => (setSideView("tree"), store.set("sideView", "tree"))}>🗂</button>
        <button title="Navbar (flat list + search)" class={sideView === "nav" ? "on" : ""} onClick={() => (setSideView("nav"), store.set("sideView", "nav"))}>🔎</button>
        <span class="grow" />
        <button title="Toggle right panel" onClick={() => setShowRight(!showRight)}>▤</button>
      </div>

      {showSide && (
        <aside class="side">
          {sideView === "nav" && (
            <input class="search" placeholder="Search files…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          )}
          <div class="scroll">
            {sideView === "tree" ? (
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
        <div class="tabs">
          {tabs.map((t) => (
            <div class={"tab" + (t === current ? " active" : "")} onClick={() => go(t)}>
              {title(t)}
              <span class="x" onClick={(e) => (e.stopPropagation(), closeTab(t))}>×</span>
            </div>
          ))}
        </div>

        {current ? (
          <>
            <div class="toolbar">
              <span class="crumb">{current}</span>
              <span class="grow" />
              {status && <span class="status">{status}</span>}
              {mode === "edit" && boot.provider.canWrite && (
                <button disabled={!dirty} onClick={save}>Save</button>
              )}
              <button
                onClick={() => {
                  setSelected(null);
                  setMode(mode === "preview" ? "edit" : "preview");
                  setStatus(mode === "preview" && !boot.provider.canWrite ? "Read-only in this mode (edits not saved)" : "");
                }}
              >
                {mode === "preview" ? "Edit" : "Preview"}
              </button>
            </div>
            <div class="scroll doc">
              {selected && (
                <div class="banner">
                  Viewing {selected.sha.slice(0, 7)} ({new Date(selected.date).toLocaleString()}) · <a onClick={() => setSelected(null)}>back to current</a>
                </div>
              )}
              {mode === "edit" && !selected ? (
                <Editor key={current} value={text} onChange={setDraft} onSave={save} />
              ) : (
                <article class="md">
                  {fm && !selected && <pre class="fm">{fm}</pre>}
                  <div dangerouslySetInnerHTML={{ __html: html }} />
                </article>
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
            <div class={"tab" + (rightTab === "outline" ? " active" : "")} onClick={() => setRightTab("outline")}>Outline</div>
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
