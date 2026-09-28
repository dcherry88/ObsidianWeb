import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { VaultProvider } from "../../shared/types";
import { resolveLink } from "./md";

/** Loads every note's text once (8 at a time) so search, backlinks and tags can work client-side. */
export function useNoteTexts(provider: VaultProvider | undefined, notes: string[]) {
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const loaded = useRef(new Set<string>());
  // tree refreshes (e.g. after a save) produce a new array identity; key on contents so we only
  // fetch notes we haven't loaded yet instead of re-downloading the whole vault.
  const key = notes.join("\0");
  useEffect(() => {
    if (!provider || !notes.length) return;
    const alive = new Set(notes);
    let pruned = false;
    for (const k of loaded.current) if (!alive.has(k)) (loaded.current.delete(k), (pruned = true));
    if (pruned) setTexts((m) => {
      const next = new Map(m);
      for (const k of next.keys()) if (!alive.has(k)) next.delete(k);
      return next;
    });
    const missing = notes.filter((n) => !loaded.current.has(n));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        const batch = await Promise.all(
          missing.slice(i, i + 8).map((n) => provider.read(n).then((t) => [n, t] as const).catch(() => [n, ""] as const)),
        );
        if (cancelled) return;
        for (const [n] of batch) loaded.current.add(n);
        setTexts((prev) => {
          const next = new Map(prev);
          for (const [n, t] of batch) next.set(n, t);
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key]);
  const update = (path: string, text: string) => setTexts((m) => new Map(m).set(path, text));
  return { texts, update };
}

const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

export function frontmatterTags(text: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return [];
  const fm = m[1];
  const list = /^tags:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)/m.exec(fm);
  if (list) return list[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^#/, "")).filter(Boolean);
  const inline = /^tags:[ \t]*\[(.*)\][ \t]*$/m.exec(fm) ?? /^tags:[ \t]*([^\n\[]+)$/m.exec(fm);
  return inline ? inline[1].split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean) : [];
}

export function inlineTags(text: string): string[] {
  const body = stripCode(text.replace(/^---\r?\n[\s\S]*?\r?\n---/, ""));
  return [...body.matchAll(/(?:^|[\s(])#([\p{L}][\p{L}\p{N}_/-]*)/gu)].map((m) => m[1]);
}

export interface Backlink {
  from: string;
  snippet: string;
}

/** Link graph + tag index over all loaded notes. */
export function useNoteIndex(texts: Map<string, string>, notes: string[]) {
  return useMemo(() => {
    const backlinks = new Map<string, Backlink[]>();
    const noteTags = new Map<string, string[]>();
    const tags = new Map<string, string[]>();
    for (const [path, text] of texts) {
      const body = stripCode(text);
      const seen = new Set<string>();
      for (const m of body.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        const to = resolveLink(notes, m[1]);
        if (!to || to === path || seen.has(to)) continue;
        seen.add(to);
        const line = body.split("\n").find((l) => l.includes(m[0])) ?? "";
        const snippet = line.replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_x, t, a) => a || t).trim().slice(0, 140);
        backlinks.set(to, [...(backlinks.get(to) ?? []), { from: path, snippet }]);
      }
      const ts = [...new Set([...frontmatterTags(text), ...inlineTags(text)])];
      noteTags.set(path, ts);
      for (const t of ts) tags.set(t, [...(tags.get(t) ?? []), path]);
    }
    return { backlinks, noteTags, tags };
  }, [texts, notes]);
}
