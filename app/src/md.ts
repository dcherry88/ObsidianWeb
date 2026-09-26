import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

export function splitFrontmatter(src: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  return m ? { fm: m[1], body: src.slice(m[0].length) } : { fm: "", body: src };
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

export function outline(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

/** Resolve an Obsidian link target to a vault path: exact path first, else shortest path with matching basename. */
export function resolveLink(files: string[], target: string): string | undefined {
  const t = target.split("#")[0].trim().replace(/\.md$/, "");
  if (!t) return undefined;
  const lower = t.toLowerCase();
  const exact = files.find((f) => f.replace(/\.md$/, "").toLowerCase() === lower);
  if (exact) return exact;
  return files
    .filter((f) => {
      const p = f.replace(/\.md$/, "").toLowerCase();
      return p.endsWith("/" + lower) || p === lower;
    })
    .sort((a, b) => a.length - b.length)[0];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderMarkdown(src: string, files: string[]): string {
  const md = new MarkdownIt({
    linkify: true,
    highlight: (code, lang) => {
      const l = lang && hljs.getLanguage(lang) ? lang : "";
      try {
        return l ? hljs.highlight(code, { language: l }).value : esc(code);
      } catch {
        return esc(code);
      }
    },
  });

  // [[wikilinks]] and [[target|alias]]
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", pos + 2);
    if (end < 0) return false;
    if (!silent) {
      const [target, alias] = src.slice(pos + 2, end).split("|");
      const tok = state.push("wikilink", "", 0);
      tok.meta = { target: target.trim(), alias: (alias ?? target).trim() };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, i) => {
    const { target, alias } = tokens[i].meta;
    const hit = resolveLink(files, target);
    return hit
      ? `<a class="wikilink" href="#/${hit.split("/").map(encodeURIComponent).join("/")}">${esc(alias)}</a>`
      : `<span class="wikilink unresolved" title="Not found">${esc(alias)}</span>`;
  };

  // heading ids for outline navigation
  const defaultHeading = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, i, opts, env, self) => {
    tokens[i].attrSet("id", slug(tokens[i + 1].content));
    return defaultHeading ? defaultHeading(tokens, i, opts, env, self) : self.renderToken(tokens, i, opts);
  };

  let html = md.render(splitFrontmatter(src).body);

  // Obsidian extras applied on rendered HTML (skipping code blocks)
  html = html
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/)
    .map((seg, i) =>
      i % 2
        ? seg
        : seg
            .replace(/<blockquote>\n<p>\[!(\w+)\][+-]?\s*/g, (_m, t) => `<blockquote class="callout callout-${t.toLowerCase()}"><p><strong class="callout-title">${t}</strong> `)
            .replace(/<li>\[( |x|X)\] /g, (_m, c) => `<li class="task"><input type="checkbox" disabled ${c === " " ? "" : "checked"}> `)
            .replace(/==([^=<]+)==/g, "<mark>$1</mark>")
            .replace(/(^|[\s>])#([\p{L}][\p{L}\p{N}_/-]*)/gu, '$1<span class="tag">#$2</span>'),
    )
    .join("");

  return DOMPurify.sanitize(html);
}
