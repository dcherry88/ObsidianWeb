import { useEffect, useRef, useState } from "preact/hooks";
import { splitFrontmatter } from "./md";

interface Hit {
  path: string;
  snippet: string;
  score: number;
}

const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

/** A note's tag matches a search tag when equal, or when it is a child (`project/alpha` matches `#project`). */
const tagMatches = (tag: string, term: string) => tag === term || tag.startsWith(term + "/");

/**
 * Global search over note names, note text and tags.
 *   alpha            -> names/text containing "alpha"
 *   #project         -> notes tagged project (or project/anything)
 *   #alpha roadmap   -> tagged alpha AND containing "roadmap"
 */
export function Search({
  notes,
  texts,
  noteTags,
  allTags,
  onOpen,
}: {
  notes: string[];
  texts: Map<string, string>;
  noteTags: Map<string, string[]>;
  allTags: [string, string[]][];
  onOpen: (p: string) => void;
}) {
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

  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tagTerms = tokens.filter((t) => t.startsWith("#") && t.length > 1).map((t) => t.slice(1));
  const textTerm = tokens.filter((t) => !t.startsWith("#")).join(" ");
  const active = tagTerms.length > 0 || textTerm.length > 0;

  // tag suggestions while typing the last token as "#par..."
  const last = tokens[tokens.length - 1] ?? "";
  const partial = q.endsWith(" ") ? "" : last.startsWith("#") ? last.slice(1) : null;
  const suggestions = partial === null ? [] : allTags.filter(([t]) => t.toLowerCase().includes(partial) && !tagTerms.slice(0, -1).includes(t.toLowerCase())).slice(0, 6);
  const applyTag = (t: string) => {
    const parts = q.trimEnd().split(/\s+/);
    parts[parts.length - 1] = "#" + t;
    setQ(parts.join(" ") + " ");
    setSel(0);
    input.current?.focus();
  };

  const hits: Hit[] = [];
  if (active) {
    for (const n of notes) {
      const tags = (noteTags.get(n) ?? []).map((t) => t.toLowerCase());
      // the tag still being typed matches loosely; completed tags match exactly (or as a parent of a nested tag)
      if (!tagTerms.every((term, i) => tags.some((t) => (partial && i === tagTerms.length - 1 ? t.includes(term) : tagMatches(t, term))))) continue;
      let score = 0;
      let snippet = "";
      if (textTerm) {
        const name = title(n).toLowerCase();
        const body = splitFrontmatter(texts.get(n) ?? "").body;
        const at = body.toLowerCase().indexOf(textTerm);
        const nameHit = name.includes(textTerm) || n.toLowerCase().includes(textTerm);
        const tagHit = tags.some((t) => t.includes(textTerm));
        if (!nameHit && at < 0 && !tagHit) continue;
        score = name === textTerm ? 0 : name.startsWith(textTerm) ? 1 : nameHit ? 2 : tagHit ? 3 : 4;
        if (at >= 0) snippet = (at > 40 ? "…" : "") + body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ");
      }
      hits.push({ path: n, snippet, score });
    }
    hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  }
  const shown = hits.slice(0, 15);

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
        placeholder="Search notes or #tags…  (/ or Ctrl+K)"
        title="Search note titles and text. Start a word with # to search by tag, e.g. #project/alpha. Shortcut: / or Ctrl/Cmd+K"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onInput={(e) => (setQ((e.target as HTMLInputElement).value), setSel(0), setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(sel + 1, shown.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(sel - 1, 0)));
          else if (e.key === "Enter" && shown[sel]) pick(shown[sel].path);
          else if (e.key === "Tab" && suggestions[0] && partial) (e.preventDefault(), applyTag(suggestions[0][0]));
          else if (e.key === "Escape") (setOpen(false), input.current?.blur());
        }}
      />
      {open && active && (
        <div class="search-results">
          {suggestions.length > 0 && (
            <div class="tag-suggest">
              {suggestions.map(([t, ps]) => (
                <span class="tag click" title={`${ps.length} note(s). Tab completes the first`} onMouseDown={(e) => (e.preventDefault(), applyTag(t))}>
                  #{t} <small>{ps.length}</small>
                </span>
              ))}
            </div>
          )}
          {!shown.length && <div class="muted pad">No matches{ready < notes.length ? " (still indexing…)" : ""}</div>}
          {shown.map((h, i) => (
            <div class={"hit" + (i === sel ? " active" : "")} onMouseDown={() => pick(h.path)} onMouseEnter={() => setSel(i)}>
              <div>
                {title(h.path)} <small>{h.path.includes("/") ? h.path.slice(0, h.path.lastIndexOf("/")) : ""}</small>
              </div>
              {h.snippet && <small class="snip">{h.snippet}</small>}
              <div class="hit-tags">
                {(noteTags.get(h.path) ?? []).map((t) => (
                  <span class="tag">#{t}</span>
                ))}
              </div>
            </div>
          ))}
          {ready < notes.length && <div class="muted pad small">Indexing note text… {ready}/{notes.length}</div>}
        </div>
      )}
    </div>
  );
}
