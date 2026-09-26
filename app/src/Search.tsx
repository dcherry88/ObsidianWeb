import { useEffect, useRef, useState } from "preact/hooks";
import { splitFrontmatter } from "./md";

interface Hit {
  path: string;
  snippet: string;
  score: number;
}

const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

/** Global search: matches note names and note text. Note bodies are fetched once (on first focus) and cached. */
export function Search({ notes, texts, onOpen }: { notes: string[]; texts: Map<string, string>; onOpen: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ready = texts.size;
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA/.test(t.tagName) || t.isContentEditable || !!t.closest?.(".cm-editor");
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const term = q.trim().toLowerCase();
  const hits: Hit[] = [];
  if (term) {
    for (const n of notes) {
      const name = title(n).toLowerCase();
      const body = splitFrontmatter(texts.get(n) ?? "").body;
      const at = body.toLowerCase().indexOf(term);
      const nameHit = name.includes(term) || n.toLowerCase().includes(term);
      if (!nameHit && at < 0) continue;
      const snippet = at >= 0 ? (at > 40 ? "…" : "") + body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ") : "";
      hits.push({ path: n, snippet, score: (name === term ? 0 : name.startsWith(term) ? 1 : nameHit ? 2 : 3) });
    }
    hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  }
  const shown = hits.slice(0, 12);

  const pick = (p: string) => {
    onOpen(p);
    setOpen(false);
    setQ("");
    input.current?.blur();
  };

  return (
    <div class="search-box">
      <input
        ref={input}
        type="search"
        placeholder="Search notes…  (/ or Ctrl+K)"
        title="Search note titles and text. Shortcut: / or Ctrl/Cmd+K"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onInput={(e) => (setQ((e.target as HTMLInputElement).value), setSel(0), setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(sel + 1, shown.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(sel - 1, 0)));
          else if (e.key === "Enter" && shown[sel]) pick(shown[sel].path);
          else if (e.key === "Escape") (setOpen(false), input.current?.blur());
        }}
      />
      {open && term && (
        <div class="search-results">
          {!shown.length && <div class="muted pad">No matches{ready < notes.length ? " (still indexing…)" : ""}</div>}
          {shown.map((h, i) => (
            <div class={"hit" + (i === sel ? " active" : "")} onMouseDown={() => pick(h.path)} onMouseEnter={() => setSel(i)}>
              <div>{title(h.path)} <small>{h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : ""}</small></div>
              {h.snippet && <small class="snip">{h.snippet}</small>}
            </div>
          ))}
          {ready < notes.length && <div class="muted pad small">Indexing note text… {ready}/{notes.length}</div>}
        </div>
      )}
    </div>
  );
}
