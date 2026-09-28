import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { diffLines } from "diff";
import type { AppConfig, Commit, VaultProvider } from "../../shared/types";
import { ConflictError, ExistsError, NotEmptyError, loadProvider, syncNow } from "./providers";
import { textHash } from "../../shared/hash";
import { outline, renderMarkdown, slug, splitFrontmatter, type RenderCtx } from "./md";
import { Editor } from "./Editor";
import { NavMenu, Tree } from "./Tree";
import { Search } from "./Search";
import { Icon } from "./Icon";
import type { EditorApi } from "./Editor";
import { CODE_OPTIONS, DEFAULT_FONT, FONT_OPTIONS, LINE_HEIGHTS, SPACINGS, WIDTHS, fontVars, type FontPrefs } from "./fonts";
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
      <span class="ico"><Icon name={p.icon} size={20} /></span>
      <span class="lbl">{p.label}</span>
    </button>
  );
}

/** Preact ignores the autofocus attribute on elements added after page load, so focus explicitly on mount. */
const focusOnMount = (el: HTMLInputElement | null) => el?.focus();
const focusAndSelect = (el: HTMLInputElement | null) => (el?.focus(), el?.select());
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
  // same, plus empty folders ("folder/" entries) so the navigation can show and delete them
  const navEntries = useMemo(() => allFiles.filter((f) => f.endsWith(".md") || isPdf(f) || f.endsWith("/")), [allFiles]);
  const [theme, setTheme] = useState<string>(store.get("theme", "system"));
  const [accent, setAccent] = useState<string>(store.get("accent", ""));
  const [showSettings, setShowSettings] = useState(false);
  const [font, setFont] = useState<FontPrefs>({ ...DEFAULT_FONT, ...store.get<Partial<FontPrefs>>("font", {}) });
  const setFontPref = (patch: Partial<FontPrefs>) => setFont((f) => ({ ...f, ...patch }));
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
  const [searchOpen, setSearchOpen] = useState(false);
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
  // editing
  const [conflict, setConflict] = useState<string | null>(null); // what is stored now, when a save found the note changed elsewhere
  const [showDiff, setShowDiff] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loadedFor, setLoadedFor] = useState(""); // the page whose text is in `content` (the editor waits for this)
  type Dlg = { kind: "newPage" | "newFolder" | "rename" | "delete" | "deleteFolder" | "renameFolder"; folder?: string; name?: string; value?: string; target?: string };
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [dlgBusy, setDlgBusy] = useState(false);
  const [dlgErr, setDlgErr] = useState("");
  const currentRef = useRef("");
  const dirtyRef = useRef(false);
  const skipHash = useRef(false);
  const startEdit = useRef<string | null>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
    const onHash = () => {
      if (skipHash.current) {
        skipHash.current = false;
        return;
      }
      const next = pathFromHash();
      if (dirtyRef.current && next !== currentRef.current && !confirm("You have unsaved changes to this note. Leave without saving?")) {
        skipHash.current = true; // put the address back without reloading
        location.hash = "#/" + currentRef.current.split("/").map(encodeURIComponent).join("/");
        return;
      }
      setCurrent(next);
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    addEventListener("hashchange", onHash);
    addEventListener("beforeunload", beforeUnload);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  const provider = boot?.provider;
  const canEdit = !!provider?.canWrite;
  currentRef.current = current;

  // load file + history when path changes
  useEffect(() => {
    if (!provider || !current) return;
    setSelected(null);
    setDraft(null);
    setConflict(null);
    setMode(startEdit.current === current ? "edit" : "preview");
    if (startEdit.current === current) startEdit.current = null;
    if (isPdf(current)) {
      setContent("");
      setLoadedFor(current);
      setCommits([]);
      return;
    }
    let alive = true;
    provider
      .read(current)
      .then((c) => alive && (setContent(c), setLoadedFor(current)))
      .catch((e) => alive && (setContent(`*Could not load: ${e}*`), setLoadedFor(current)));
    provider.history(current).then((h) => alive && setCommits(h)).catch(() => alive && setCommits([]));
    return () => {
      alive = false;
    };
  }, [provider, current]);

  useEffect(() => setOpenNav(ancestorsOf(current)), [current]);

  // switching between phone and desktop sizes: drawers closed on phones, panels open on desktop
  useEffect(() => {
    setShowSide(!mobile);
    setShowRight(!mobile);
    setMoreOpen(false);
    setSearchOpen(false);
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
    const root = document.documentElement;
    for (const [k, v] of Object.entries(fontVars(font))) (v ? root.style.setProperty(k, v) : root.style.removeProperty(k));
    store.set("font", font);
  }, [font]);
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

  const homePath = useMemo(() => ["index.md", "README.md", "Home.md", "Welcome.md"].find((h) => files.includes(h)) ?? files[0] ?? "", [files]);
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
  dirtyRef.current = dirty && mode === "edit";
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const refreshTree = async () => {
    if (provider) setFiles(await provider.tree());
  };

  const save = async (baseText?: string) => {
    if (!provider || !dirty || saving) return;
    setSaving(true);
    try {
      await provider.write(current, draft!, { baseHash: textHash(baseText ?? content) });
      setContent(draft!);
      updateText(current, draft!);
      setDraft(null);
      setConflict(null);
      setShowDiff(false);
      setStatus("Saved");
      provider.history(current).then(setCommits).catch(() => {});
    } catch (e) {
      if (e instanceof ConflictError) {
        setConflict(e.current);
        setStatus("Not saved: the note changed elsewhere");
      } else setStatus("Not saved: " + String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    if (dirty && !confirm("Discard your unsaved changes?")) return;
    setDraft(null);
    setConflict(null);
    setEditorKey((k) => k + 1);
    setMode("preview");
  };
  const loadTheirs = () => {
    setContent(conflict ?? "");
    setDraft(null);
    setConflict(null);
    setShowDiff(false);
    setEditorKey((k) => k + 1);
  };
  const uploadFiles = async (fs: File[]) => {
    if (!provider?.upload || !fs.length) return;
    setStatus(`Uploading ${fs.length} file${fs.length === 1 ? "" : "s"}…`);
    try {
      const links: string[] = [];
      for (const f of fs) links.push(`![[${(await provider.upload(current, f)).name}]]`);
      await refreshTree(); // so the live preview can find the new attachments
      editorApi.current?.insert(links.join("\n") + "\n");
      setStatus(`Uploaded ${links.length} file${links.length === 1 ? "" : "s"}`);
    } catch (e) {
      setStatus("Upload failed: " + String((e as Error).message ?? e));
    }
  };
  const copyMine = () => navigator.clipboard?.writeText(draft ?? content).then(() => setStatus("Your text was copied"), () => setStatus("Could not copy"));

  // folders that exist (from files and empty-folder entries) for the "new page" dialog
  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of allFiles) {
      const parts = f.replace(/\/$/, "").split("/");
      if (!f.endsWith("/")) parts.pop();
      parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join("/")));
    }
    return [...set].sort((x, y) => x.localeCompare(y));
  }, [allFiles]);

  const openDlg = (d: Dlg) => (setDlgErr(""), setDlgBusy(false), setDlg(d));
  const runDlg = async (fn: () => Promise<void>) => {
    setDlgBusy(true);
    setDlgErr("");
    try {
      await fn();
      setDlg(null);
    } catch (e) {
      setDlgErr(e instanceof ExistsError || e instanceof NotEmptyError ? e.message : String((e as Error).message ?? e));
    } finally {
      setDlgBusy(false);
    }
  };
  const mdName = (n: string) => (n.toLowerCase().endsWith(".md") ? n : n + ".md");
  const submitDlg = () => {
    if (!dlg || !provider) return;
    if (dlg.kind === "newPage")
      return runDlg(async () => {
        const name = (dlg.name ?? "").trim();
        if (!name || /[\/\\]/.test(name) || name.startsWith(".")) throw new Error("Enter a page name without slashes.");
        const folder = (dlg.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
        const path = [folder, mdName(name)].filter(Boolean).join("/");
        await provider.write(path, `# ${name.replace(/\.md$/i, "")}\n\n`, { createOnly: true });
        await refreshTree();
        startEdit.current = path;
        go(path);
      });
    if (dlg.kind === "newFolder")
      return runDlg(async () => {
        const path = (dlg.value ?? "").trim().replace(/^\/+|\/+$/g, "");
        if (!path) throw new Error("Enter a folder name.");
        await provider.mkdir!(path);
        await refreshTree();
        const parts = path.split("/");
        setOpenNav((o) => new Set([...o, ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))]));
      });
    if (dlg.kind === "rename")
      return runDlg(async () => {
        const to = mdName((dlg.value ?? "").trim().replace(/^\/+/, ""));
        if (!to || to === current) throw new Error("Enter a different path.");
        await provider.rename!(current, to);
        await refreshTree();
        setTabs((t) => {
          const n = t.map((x) => (x === current ? to : x));
          store.set("tabs", n);
          return n;
        });
        dirtyRef.current = false;
        go(to);
      });
    if (dlg.kind === "delete")
      return runDlg(async () => {
        const gone = current;
        await provider.remove!(gone);
        await refreshTree();
        setTabs((t) => {
          const n = t.filter((x) => x !== gone);
          store.set("tabs", n);
          return n;
        });
        dirtyRef.current = false;
        setDraft(null);
        const next = ["index.md", "README.md", "Home.md", "Welcome.md"].find((h) => h !== gone && files.includes(h)) ?? files.find((f) => f !== gone);
        if (next) go(next);
        else location.hash = "";
      });
    if (dlg.kind === "renameFolder")
      return runDlg(async () => {
        const from = dlg.target!;
        const to = (dlg.value ?? "").trim().replace(/^\/+|\/+$/g, "");
        if (!to || to === from) throw new Error("Enter a different folder path.");
        await provider.renameDir!(from, to);
        await refreshTree();
        const re = (p: string) => (p.startsWith(from + "/") ? to + p.slice(from.length) : p);
        setTabs((t) => {
          const n = t.map(re);
          store.set("tabs", n);
          return n;
        });
        const parts = to.split("/");
        setOpenNav((o) => new Set([...o, ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))]));
        if (current.startsWith(from + "/")) {
          dirtyRef.current = false;
          go(re(current));
        }
      });
    if (dlg.kind === "deleteFolder")
      return runDlg(async () => {
        await provider.removeDir!(dlg.target!);
        await refreshTree();
      });
  };

  const shown = navFiles.filter((f) => f.toLowerCase().includes(search.toLowerCase()));

  if (err) return <div class="center">Failed to load vault: {err}</div>;
  if (!boot) return <div class="center">Loading…</div>;

  const diff = selected ? diffLines(oldContent, text) : null;

  return (
    <div class={"app " + (layout === "doc" ? "web" : "obs") + (mobile ? " mobile" : "")}>
      {!mobile && (
        <header class="topbar">
          {layout === "doc" && (
            <button class="tb-btn menu-btn" title="Show or hide the navigation menu" aria-label="Navigation menu" onClick={() => setShowSide(!showSide)}><Icon name="menu" /> Menu</button>
          )}
          <span class="brand" title="Home" onClick={() => location.assign("#/")}>ObsidianWeb</span>
          <div class="seg" role="group" aria-label="View mode">
            <button class={layout === "doc" ? "on" : ""} title="Web mode: a wiki-style site, one page at a time" onClick={() => setLayoutPersist("doc")}>Web</button>
            <button class={layout === "vault" ? "on" : ""} title="Obsidian mode: tabs, split view and editor" onClick={() => setLayoutPersist("vault")}>Obsidian</button>
          </div>
          <Search notes={navFiles} indexTotal={files.length} texts={texts} noteTags={index.noteTags} allTags={allTags} onOpen={go} />
          <span class="grow" />
          {syncMsg && <span class="sync-msg">{syncMsg}</span>}
          {boot.cfg.canSync && (
            <button class="tb-btn" disabled={syncing} title="Pull the latest changes from Fast Note Sync now (it also syncs automatically every minute)" onClick={forceSync}>
              <Icon name="sync" spin={syncing} /> {syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
          {layout === "doc" && (
            <>
              <button class="tb-btn" title="Show or hide the 'On this page' and History panel" onClick={() => setShowRight(!showRight)}>On this page</button>
              <button class="tb-btn" title="Theme, colors and default view" onClick={() => setShowSettings(true)}><Icon name="settings" /> Settings</button>
            </>
          )}
        </header>
      )}
      {mobile && (showSide || showRight || searchOpen || moreOpen) && (
        <div class="backdrop" onClick={() => (setShowSide(false), setShowRight(false), setSearchOpen(false), setMoreOpen(false))} />
      )}
    <div class={"shell " + (layout === "doc" ? "doc-mode" : "vault-mode")}>
      {layout === "vault" && <div class="ribbon">
        <RibbonBtn icon="menu" label="Sidebar" tip="Show or hide the left sidebar" onClick={() => setShowSide(!showSide)} />
        {layout === "vault" && (
          <>
            <RibbonBtn icon="folder" label="Files" tip="File tree view of the vault folders" on={sideView === "tree"} onClick={() => (setSideView("tree"), store.set("sideView", "tree"))} />
            <RibbonBtn icon="list" label="List" tip="Flat list of all notes, filterable" on={sideView === "nav"} onClick={() => (setSideView("nav"), store.set("sideView", "nav"))} />
          </>
        )}
        <span class="grow" />
        <RibbonBtn icon="panel" label="Panel" tip="Show or hide the right panel (outline and history)" onClick={() => setShowRight(!showRight)} />
        <RibbonBtn icon="settings" label="Settings" tip="Theme, colors and default view" on={showSettings} onClick={() => setShowSettings(true)} />
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
            <div class="settings-group">Reading and fonts</div>
            <label title="Typeface for note text. Only fonts already installed on your device are used">
              Font
              <select value={font.family} onChange={(e) => setFontPref({ family: (e.target as HTMLSelectElement).value })}>
                {FONT_OPTIONS.map((o) => <option value={o.id}>{o.label}</option>)}
              </select>
            </label>
            {font.family === "custom" && (
              <label>
                Font name
                <input type="text" placeholder="e.g. Atkinson Hyperlegible" value={font.custom} onInput={(e) => setFontPref({ custom: (e.target as HTMLInputElement).value })} />
              </label>
            )}
            <label title="Text size for notes">
              Text size {font.size ? `(${font.size}px)` : "(default)"}
              <input type="range" min="13" max="26" step="1" value={font.size || 16} onInput={(e) => setFontPref({ size: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label title="Space between lines of text">
              Line spacing
              <select value={String(font.lh)} onChange={(e) => setFontPref({ lh: Number((e.target as HTMLSelectElement).value) })}>
                {LINE_HEIGHTS.map((o) => <option value={String(o.v)}>{o.label}</option>)}
              </select>
            </label>
            <label title="Space between letters. Slightly wider spacing can help some readers">
              Letter spacing
              <select value={font.spacing} onChange={(e) => setFontPref({ spacing: (e.target as HTMLSelectElement).value })}>
                {SPACINGS.map((o) => <option value={o.v}>{o.label}</option>)}
              </select>
            </label>
            {!mobile && (
              <label title="Maximum width of the text column">
                Text width
                <select value={font.width} onChange={(e) => setFontPref({ width: (e.target as HTMLSelectElement).value })}>
                  {WIDTHS.map((o) => <option value={o.v}>{o.label}</option>)}
                </select>
              </label>
            )}
            <label title="Typeface for code blocks and raw markdown">
              Code font
              <select value={font.code} onChange={(e) => setFontPref({ code: (e.target as HTMLSelectElement).value })}>
                {CODE_OPTIONS.map((o) => <option value={o.id}>{o.label}</option>)}
              </select>
            </label>
            {font.code === "custom" && (
              <label>
                Code font name
                <input type="text" placeholder="e.g. JetBrains Mono" value={font.codeCustom} onInput={(e) => setFontPref({ codeCustom: (e.target as HTMLInputElement).value })} />
              </label>
            )}
            <label class="check" title="Use the chosen font for menus, buttons and navigation too">
              <input type="checkbox" checked={font.ui} onChange={(e) => setFontPref({ ui: (e.target as HTMLInputElement).checked })} />
              Also use this font for menus and controls
            </label>
            <div class="font-preview md">
              <b>Preview.</b> The quick brown fox jumps over the lazy dog. Il1 O0 rn m. <code>const x = 42;</code>
            </div>
            <button class="reset-font" onClick={() => setFont({ ...DEFAULT_FONT })}>Reset fonts</button>
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
          {mobile && <div class="drawer-head"><b>Pages</b><button title="Close" aria-label="Close" onClick={() => setShowSide(false)}><Icon name="close" /></button></div>}
          {layout === "doc" && <div class="site-title">Docs</div>}
          {layout === "vault" && sideView === "nav" && (
            <input class="search" placeholder="Search files…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          )}
          {canEdit && (
            <div class="side-actions">
              <button title="Create a new page" onClick={() => openDlg({ kind: "newPage", folder: current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "", name: "" })}>
                <Icon name="file-plus" size={16} /> Page
              </button>
              <button title="Create a new folder" onClick={() => openDlg({ kind: "newFolder", value: "" })}>
                <Icon name="folder-plus" size={16} /> Folder
              </button>
            </div>
          )}
          <div class="scroll">
            {layout === "doc" ? (
              <NavMenu files={navEntries} open={openNav} toggle={toggleNav} current={current} onOpen={go} onRenameFolder={canEdit ? (p) => openDlg({ kind: "renameFolder", target: p, value: p }) : undefined} onDeleteFolder={canEdit ? (p) => openDlg({ kind: "deleteFolder", target: p }) : undefined} />
            ) : sideView === "tree" ? (
              <Tree files={navEntries} open={open} toggle={toggle} current={current} onOpen={go} onRenameFolder={canEdit ? (p) => openDlg({ kind: "renameFolder", target: p, value: p }) : undefined} onDeleteFolder={canEdit ? (p) => openDlg({ kind: "deleteFolder", target: p }) : undefined} />
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
              <span class="x" title="Open in split pane" onClick={(e) => (e.stopPropagation(), setSplit(t))}><Icon name="split" size={14} /></span>
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
                <>
                  <button class="primary" disabled={!dirty || saving} title="Save this note (Ctrl/Cmd+S)" onClick={() => save()}>
                    <Icon name="save" size={15} /> {saving ? "Saving…" : "Save"}
                  </button>
                  {provider?.upload && (
                    <>
                      <button title="Attach an image, PDF, audio or video file (you can also paste or drop files into the editor)" aria-label="Attach file" onClick={() => fileInput.current?.click()}>
                        <Icon name="attach" size={15} /> Attach
                      </button>
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        accept="image/*,.pdf,.mp3,.mp4,.webm"
                        onChange={(e) => {
                          const el = e.target as HTMLInputElement;
                          void uploadFiles([...(el.files ?? [])]);
                          el.value = "";
                        }}
                      />
                    </>
                  )}
                  <button title="Throw away unsaved changes and stop editing" onClick={discard}>Discard</button>
                </>
              )}
              <button class={mode === "raw" ? "on" : ""} title="Toggle between the rendered page and the raw markdown source" onClick={() => (setStatus(""), setMode(mode === "raw" ? "preview" : "raw"))}>
                {mode === "raw" ? "Rendered" : "Show raw"}
              </button>
              {layout === "vault" && (
                <button class={split ? "on" : ""} title="Split view: show a second note side by side" onClick={() => setSplit(split ? null : tabs.find((t) => t !== current) ?? current)}>
                  {split ? "Close split" : "Split"}
                </button>
              )}
              {(layout === "vault" || canEdit) && (
                <button
                  title="Edit this note in a markdown editor with live preview"
                  onClick={() => {
                    setSelected(null);
                    setMode(mode === "edit" ? "preview" : "edit");
                    setStatus(mode !== "edit" && !boot.provider.canWrite ? "Read-only in this mode (edits not saved)" : "");
                  }}
                >
                  {mode === "edit" ? "Preview" : <><Icon name="edit" size={15} /> Edit</>}
                </button>
              )}
              {canEdit && !selected && (
                <>
                  <button title="Rename or move this page" aria-label="Rename" onClick={() => openDlg({ kind: "rename", value: current })}><Icon name="rename" size={15} /></button>
                  <button title="Delete this page" aria-label="Delete" onClick={() => openDlg({ kind: "delete" })}><Icon name="trash" size={15} /></button>
                </>
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
              {conflict !== null && (
                <div class="conflict">
                  <b>This note changed elsewhere while you were editing it.</b> Nothing was saved.
                  <div class="conflict-actions">
                    <button onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide differences" : "Show differences"}</button>
                    <button class="primary" title="Save your version over the one that is stored now" onClick={() => save(conflict)}>Overwrite with my version</button>
                    <button title="Discard your edits and load the stored version" onClick={loadTheirs}>Load their version</button>
                    <button onClick={copyMine}>Copy my text</button>
                    <button onClick={() => setConflict(null)}>Keep editing</button>
                  </div>
                  {showDiff && (
                    <div class="diff">
                      <div class="muted pad small">Stored version → your version</div>
                      {diffLines(conflict, draft ?? content).map((p) => (
                        <pre class={p.added ? "add" : p.removed ? "del" : "same"}>{p.value}</pre>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {isPdf(current) ? (
                <iframe class="pdf-page" src={boot.provider.assetUrl(current)} title={current} />
              ) : mode === "raw" ? (
                <pre class="raw">{shownRaw}</pre>
              ) : mode === "edit" && !selected && loadedFor !== current ? (
                <div class="center muted">Loading…</div>
              ) : mode === "edit" && !selected ? (
                <div class="edit-split">
                  <Editor key={current + ":" + editorKey} value={text} onChange={setDraft} onSave={() => save()} onFiles={provider?.upload ? uploadFiles : undefined} apiRef={editorApi} />
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
          {mobile && <div class="drawer-head"><b>This page</b><button title="Close" aria-label="Close" onClick={() => setShowRight(false)}><Icon name="close" /></button></div>}
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
    {dlg && (
      <div class="overlay" onClick={() => !dlgBusy && setDlg(null)}>
        <form class="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => (e.preventDefault(), submitDlg())}>
          <div class="modal-head">
            <b>
              {dlg.kind === "newPage" ? "New page" : dlg.kind === "newFolder" ? "New folder" : dlg.kind === "rename" ? "Rename or move page" : dlg.kind === "renameFolder" ? "Rename or move folder" : dlg.kind === "delete" ? "Delete page" : "Delete folder"}
            </b>
          </div>
          {dlg.kind === "newPage" && (
            <>
              <label class="dlg-field">Folder (leave empty for the top level; new folders are created)
                <input type="text" list="folder-list" value={dlg.folder ?? ""} onInput={(e) => setDlg({ ...dlg, folder: (e.target as HTMLInputElement).value })} />
                <datalist id="folder-list">{folders.map((f) => <option value={f} />)}</datalist>
              </label>
              <label class="dlg-field">Page name
                <input type="text" ref={focusOnMount} placeholder="My new page" value={dlg.name ?? ""} onInput={(e) => setDlg({ ...dlg, name: (e.target as HTMLInputElement).value })} />
              </label>
              <div class="muted small">Creates <code>{[(dlg.folder ?? "").trim().replace(/^\/+|\/+$/g, ""), mdName((dlg.name ?? "").trim() || "…")].filter(Boolean).join("/")}</code> and opens it for editing.</div>
            </>
          )}
          {dlg.kind === "newFolder" && (
            <label class="dlg-field">Folder path (use / for nested folders)
              <input type="text" ref={focusOnMount} placeholder="Projects/New folder" value={dlg.value ?? ""} onInput={(e) => setDlg({ ...dlg, value: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          {dlg.kind === "rename" && (
            <label class="dlg-field">New path (change the folder to move the page)
              <input type="text" ref={focusAndSelect} value={dlg.value ?? ""} onInput={(e) => setDlg({ ...dlg, value: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          {dlg.kind === "renameFolder" && (
            <>
              <label class="dlg-field">New path for <b>{dlg.target}</b> (change the parent to move it)
                <input type="text" ref={focusAndSelect} value={dlg.value ?? ""} onInput={(e) => setDlg({ ...dlg, value: (e.target as HTMLInputElement).value })} />
              </label>
              <div class="muted small">Every page and attachment inside moves with it. Links by page name keep working; links written with a full path do not. On synced vaults the move is applied item by item, so an interruption can leave part of the folder moved.</div>
            </>
          )}
          {dlg.kind === "delete" && (
            <div>Delete <b>{current}</b>? It can be recovered from the version history or the recycle bin of your sync service, but links to it will break.</div>
          )}
          {dlg.kind === "deleteFolder" && <div>Delete the empty folder <b>{dlg.target}</b>?</div>}
          {dlgErr && <div class="dlg-err">{dlgErr}</div>}
          <div class="dlg-actions">
            <button type="button" disabled={dlgBusy} onClick={() => setDlg(null)}>Cancel</button>
            <button type="submit" class={dlg.kind === "delete" || dlg.kind === "deleteFolder" ? "danger" : "primary"} disabled={dlgBusy}>
              {dlgBusy ? "Working…" : dlg.kind === "newPage" || dlg.kind === "newFolder" ? "Create" : dlg.kind === "rename" || dlg.kind === "renameFolder" ? "Rename" : "Delete"}
            </button>
          </div>
        </form>
      </div>
    )}
    {mobile && searchOpen && (
      <div class="search-sheet">
        <Search notes={navFiles} indexTotal={files.length} texts={texts} noteTags={index.noteTags} allTags={allTags} onOpen={go} autoFocus onClose={() => setSearchOpen(false)} />
        <button class="tb-btn" onClick={() => setSearchOpen(false)}>Cancel</button>
      </div>
    )}
    {mobile && moreOpen && (
      <div class="more-menu" onClick={() => setMoreOpen(false)}>
        {boot.cfg.canSync && <button disabled={syncing} onClick={forceSync}><Icon name="sync" spin={syncing} /> {syncing ? "Syncing…" : "Sync now"}</button>}
        <button onClick={() => setShowSettings(true)}><Icon name="settings" /> Settings</button>
        {boot.cfg.signOutUrl && <a class="menu-link" href={boot.cfg.signOutUrl}>Sign out</a>}
      </div>
    )}
    {mobile && syncMsg && <div class="toast">{syncMsg}</div>}
    {mobile && (
      <nav class="bottombar" aria-label="Main navigation">
        <button class={showSide ? "on" : ""} aria-label="Pages" onClick={() => (setShowSide(!showSide), setShowRight(false), setSearchOpen(false), setMoreOpen(false))}>
          <span class="ico"><Icon name="folder" size={22} /></span><span class="lbl">Pages</span>
        </button>
        <button class={searchOpen ? "on" : ""} aria-label="Search" onClick={() => (setSearchOpen(true), setShowSide(false), setShowRight(false), setMoreOpen(false))}>
          <span class="ico"><Icon name="search" size={22} /></span><span class="lbl">Search</span>
        </button>
        <button aria-label="Home" onClick={() => (setShowSide(false), setShowRight(false), setSearchOpen(false), setMoreOpen(false), homePath && go(homePath))}>
          <span class="ico"><Icon name="home" size={22} /></span><span class="lbl">Home</span>
        </button>
        <button class={showRight ? "on" : ""} aria-label="On this page" onClick={() => (setShowRight(!showRight), setShowSide(false), setSearchOpen(false), setMoreOpen(false))}>
          <span class="ico"><Icon name="contents" size={22} /></span><span class="lbl">Contents</span>
        </button>
        <button class={moreOpen ? "on" : ""} aria-label="More" onClick={() => (setMoreOpen(!moreOpen), setShowSide(false), setShowRight(false), setSearchOpen(false))}>
          <span class="ico"><Icon name="more" size={22} /></span><span class="lbl">More</span>
        </button>
      </nav>
    )}
    </div>
  );
}
