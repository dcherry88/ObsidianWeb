// Fast Note Sync service (https://github.com/haierkeys/fast-note-sync-service) as the vault source.
// A background job mirrors the vault from the service's REST API into a local folder, so the rest of the
// server serves plain files. Note history is proxied live from the service. Read-only.
import { mkdir, readFile, readdir, rename as fsRename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Commit } from "../../shared/types";
import { textHash } from "../../shared/hash";
import { type Actor, type Backend, ConflictError, ExistsError, NotEmptyError, NotFoundError, type WriteOpts, safePath, walk } from "./backend";

export interface FnsOptions {
  url: string;
  token: string;
  vault: string;
  mirrorDir: string;
  stateFile: string;
  intervalSec: number;
  /** client name sent as X-Client; must match the token's client restriction */
  client: string;
  /** allow the editing operations (the token must also permit note writes) */
  canWrite?: boolean;
  /** send edits as X-Client "<client>-<person>" (the token's Client restriction must then be a wildcard such as "ObsidianWeb*") */
  clientPerUser?: boolean;
}

export interface SyncStatus {
  running: boolean;
  lastStart?: string;
  lastOk?: string;
  lastError?: string;
  notes: number;
  files: number;
  changed: number;
}

interface RemoteItem {
  path: string;
  sig: string;
}

/** short, log-friendly id for a person: "Ada Lovelace" -> "ada-lovelace" */
const personSlug = (a: Actor) =>
  (a.name || a.email?.split("@")[0] || a.label)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "user";

const toIso = (v: unknown): string => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return typeof v === "string" ? v : "";
};

export class FnsBackend implements Backend {
  canWrite = false;
  status: SyncStatus = { running: false, notes: 0, files: 0, changed: 0 };
  private timer?: NodeJS.Timeout;

  constructor(private o: FnsOptions) {
    this.canWrite = !!o.canWrite;
  }

  // ---------- HTTP ----------
  // FNS wants "Authorization: Bearer <token>" and identifies the caller by X-Client, which must match the
  // token's "Client restriction" (or the restriction must be "*").
  private headers(actor?: Actor, json = false) {
    // the client TYPE (X-Client) must stay constant because the token is restricted to it; the client NAME is a free label,
    // so it carries the signed-in person. FNS shows it in its access log and on note history entries.
    const name = actor ? `${this.o.client} (${actor.label})` : this.o.client;
    const type = actor && this.o.clientPerUser ? `${this.o.client}-${personSlug(actor)}` : this.o.client;
    return {
      Authorization: `Bearer ${this.o.token}`,
      "X-Client": type,
      "X-Client-Name": encodeURIComponent(name),
      "X-Client-Version": "1.0",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private fetchRaw(p: string, query: Record<string, string | number | boolean | undefined>) {
    const u = new URL(this.o.url.replace(/\/$/, "") + p);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return fetch(u, { headers: this.headers() });
  }

  private async api<T>(p: string, query: Record<string, string | number | boolean | undefined>, init?: { method: string; body?: unknown; form?: FormData; actor?: Actor }): Promise<T> {
    const u = new URL(this.o.url.replace(/\/$/, "") + p);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    const res = await fetch(u, {
      method: init?.method ?? "GET",
      headers: this.headers(init?.actor, init?.body !== undefined), // multipart sets its own content type
      body: init?.form ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    const j = (await res.json()) as { code?: number; status?: boolean; message?: string; data?: T };
    if (j.status === false || (typeof j.code === "number" && j.code <= 0)) {
      const hint = j.code === 315 || j.code === 314 || /scope|client/i.test(j.message ?? "") ? ` (check the FNS token: it needs the REST protocol, read access${this.canWrite ? " and write access" : ""} to notes and attachments, this vault, and a Client restriction equal to "${this.o.client}"${this.o.clientPerUser ? ` with a wildcard (for example "${this.o.client}*"), because edits are sent as "${this.o.client}-<person>"` : ""} or "*")` : "";
      throw Object.assign(new Error(`${p}: ${j.message ?? "error"} (code ${j.code})${hint}`), { fnsCode: j.code });
    }
    return j.data as T;
  }

  private async listAll(p: string): Promise<any[]> {
    const out: any[] = [];
    const pageSize = 100;
    for (let page = 1; page < 10_000; page++) {
      const data = await this.api<{ list?: any[]; pager?: { totalRows?: number } }>(p, { vault: this.o.vault, page, pageSize });
      const list = data?.list ?? [];
      out.push(...list);
      const total = data?.pager?.totalRows;
      if (list.length < pageSize || (total !== undefined && out.length >= total)) break;
    }
    return out;
  }

  // ---------- sync ----------
  private async loadState(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.o.stateFile, "utf8"));
    } catch {
      return {};
    }
  }

  private inflight?: Promise<void>;

  /** Run a sync, or wait for the one already running. */
  syncOnce(): Promise<void> {
    return (this.inflight ??= this.doSync().finally(() => {
      this.inflight = undefined;
    }));
  }

  private async doSync(): Promise<void> {
    this.status = { ...this.status, running: true, lastStart: new Date().toISOString() };
    try {
      const state = await this.loadState();
      const next: Record<string, string> = {};
      const asItem = (n: any): RemoteItem => ({ path: String(n.path), sig: String(n.contentHash ?? `${n.mtime}:${n.size}`) });
      const notes = (await this.listAll("/api/notes")).map(asItem);
      const files = (await this.listAll("/api/files")).map(asItem);
      let changed = 0;

      const jobs: (() => Promise<void>)[] = [];
      const plan = (kind: "n" | "f", item: RemoteItem) => {
        let abs: string;
        try {
          abs = safePath(this.o.mirrorDir, item.path);
        } catch {
          return; // ignore paths that would escape the mirror or touch .obsidian/.git
        }
        const key = `${kind}:${item.path}`;
        next[key] = item.sig;
        jobs.push(async () => {
          const upToDate = state[key] === item.sig && (await stat(abs).then(() => true, () => false));
          if (upToDate) return;
          await mkdir(path.dirname(abs), { recursive: true });
          if (kind === "n") {
            const d = await this.api<{ content?: string; mtime?: number }>("/api/note", { vault: this.o.vault, path: item.path });
            await writeFile(abs, d?.content ?? "", "utf8");
            if (d?.mtime) await utimes(abs, new Date(), new Date(d.mtime)).catch(() => {});
          } else {
            const res = await this.fetchRaw("/api/file", { vault: this.o.vault, path: item.path });
            if (!res.ok) throw new Error(`/api/file ${item.path}: HTTP ${res.status}`);
            await writeFile(abs, Buffer.from(await res.arrayBuffer()));
          }
          changed++;
        });
      };
      notes.forEach((n) => plan("n", n));
      files.forEach((f) => plan("f", f));

      // small worker pool
      const queue = [...jobs];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let j = queue.shift(); j; j = queue.shift()) await j();
        }),
      );

      // deletions: things we mirrored earlier that are gone remotely (never wipe on an empty listing)
      const gone = Object.keys(state).filter((k) => !(k in next));
      if (notes.length + files.length === 0 && gone.length > 0) {
        console.warn("[fns] remote listing is empty; keeping local mirror");
        Object.assign(next, state);
      } else {
        for (const k of gone) {
          try {
            await rm(safePath(this.o.mirrorDir, k.slice(2)), { force: true });
            changed++;
          } catch {
            /* ignore */
          }
        }
      }

      await mkdir(path.dirname(this.o.stateFile), { recursive: true });
      await writeFile(this.o.stateFile, JSON.stringify(next));
      this.status = { running: false, lastStart: this.status.lastStart, lastOk: new Date().toISOString(), notes: notes.length, files: files.length, changed };
      if (changed) console.log(`[fns] sync: ${changed} change(s), ${notes.length} notes, ${files.length} attachments`);
    } catch (e) {
      this.status = { ...this.status, running: false, lastError: String((e as Error).message ?? e) };
      console.error("[fns] sync failed:", this.status.lastError);
    }
  }

  async init() {
    await mkdir(this.o.mirrorDir, { recursive: true });
    await this.syncOnce();
    if (this.o.intervalSec > 0) {
      this.timer = setInterval(() => void this.syncOnce(), this.o.intervalSec * 1000);
      this.timer.unref();
    }
  }

  // ---------- Backend ----------
  tree = () => walk(this.o.mirrorDir, "", true).then((f) => f.sort((a, b) => a.localeCompare(b)));
  read = (rel: string) => readFile(safePath(this.o.mirrorDir, rel));

  async history(rel: string): Promise<Commit[]> {
    safePath(this.o.mirrorDir, rel);
    const data = await this.api<{ list?: any[] }>("/api/note/histories", { vault: this.o.vault, path: rel, page: 1, pageSize: 50 });
    return (data?.list ?? []).map((h) => ({
      sha: String(h.id),
      author: h.clientName || h.clientType || "sync",
      date: toIso(h.createdAt ?? h.updatedAt),
      message: `Version ${h.version ?? h.id}${h.clientType ? ` (${h.clientType})` : ""}`,
    }));
  }

  isValidRef = (ref: string) => /^\d+$/.test(ref);

  async readAt(rel: string, ref: string) {
    safePath(this.o.mirrorDir, rel);
    const h = await this.api<{ content?: string }>("/api/note/history", { id: ref });
    return h?.content ?? "";
  }

  // ---------- editing (only when canWrite) ----------
  private async settled() {
    await this.inflight?.catch(() => {}); // don't race a running sync
  }

  private async setState(mut: (st: Record<string, string>) => void) {
    const st = await this.loadState();
    mut(st);
    await mkdir(path.dirname(this.o.stateFile), { recursive: true });
    await writeFile(this.o.stateFile, JSON.stringify(st));
  }

  private async liveNote(rel: string): Promise<string | undefined> {
    try {
      const d = await this.api<{ content?: string }>("/api/note", { vault: this.o.vault, path: rel });
      return d?.content ?? "";
    } catch (e) {
      if ((e as { fnsCode?: number }).fnsCode === 428) return undefined; // note does not exist
      throw e;
    }
  }

  async write(rel: string, content: string, o: WriteOpts = {}) {
    if (!this.canWrite) throw new Error("writes disabled");
    const abs = safePath(this.o.mirrorDir, rel);
    await this.settled();
    const live = await this.liveNote(rel); // ask FNS itself, not our copy, so a change made a second ago is caught
    if (o.createOnly && live !== undefined) throw new ExistsError();
    if (o.baseHash !== undefined && live !== undefined && textHash(live) !== o.baseHash) throw new ConflictError(live);
    const saved = await this.api<{ contentHash?: string }>(
      "/api/note",
      {},
      { method: "POST", actor: o.actor, body: { vault: this.o.vault, path: rel, content, mtime: Date.now(), ...(o.createOnly ? { createOnly: true } : {}) } },
    );
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    if (saved?.contentHash) await this.setState((st) => void (st[`n:${rel}`] = String(saved.contentHash)));
  }

  async mkdir(rel: string, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const abs = safePath(this.o.mirrorDir, rel);
    await this.api("/api/folder", {}, { method: "POST", actor, body: { vault: this.o.vault, path: rel } });
    await mkdir(abs, { recursive: true });
  }

  async rename(from: string, to: string, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const src = safePath(this.o.mirrorDir, from);
    const dst = safePath(this.o.mirrorDir, to);
    await this.settled();
    if ((await this.liveNote(from)) === undefined) throw new NotFoundError();
    if ((await this.liveNote(to)) !== undefined) throw new ExistsError();
    await this.api("/api/note/rename", {}, { method: "POST", actor, body: { vault: this.o.vault, oldPath: from, path: to } });
    await mkdir(path.dirname(dst), { recursive: true });
    await fsRename(src, dst).catch(() => {});
    await this.setState((st) => {
      if (`n:${from}` in st) {
        st[`n:${to}`] = st[`n:${from}`];
        delete st[`n:${from}`];
      }
    });
  }

  async remove(rel: string, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const abs = safePath(this.o.mirrorDir, rel);
    await this.settled();
    if ((await this.liveNote(rel)) === undefined) throw new NotFoundError();
    await this.api("/api/note", { vault: this.o.vault, path: rel }, { method: "DELETE", actor }); // FNS keeps deleted notes in its recycle bin
    await rm(abs, { force: true });
    await this.setState((st) => void delete st[`n:${rel}`]);
  }

  async removeDir(rel: string, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const abs = safePath(this.o.mirrorDir, rel);
    if ((await readdir(abs).catch(() => ["x"])).length) throw new NotEmptyError();
    await this.api("/api/folder", {}, { method: "DELETE", actor, body: { vault: this.o.vault, path: rel } });
    await rm(abs, { recursive: true, force: true });
  }

  async upload(rel: string, data: Buffer, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const abs = safePath(this.o.mirrorDir, rel);
    await this.settled();
    const now = String(Date.now());
    const form = new FormData();
    form.set("vault", this.o.vault);
    form.set("path", rel);
    form.set("ctime", now);
    form.set("mtime", now);
    form.set("file", new Blob([new Uint8Array(data)]), rel.split("/").pop());
    const saved = await this.api<{ contentHash?: string }>("/api/file", {}, { method: "POST", form, actor });
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    if (saved?.contentHash) await this.setState((st) => void (st[`f:${rel}`] = String(saved.contentHash)));
  }

  /** FNS has no folder-rename call, so move every note and attachment inside, one by one, then drop the old folder. */
  async renameDir(from: string, to: string, actor?: Actor) {
    if (!this.canWrite) throw new Error("writes disabled");
    const src = safePath(this.o.mirrorDir, from);
    const dst = safePath(this.o.mirrorDir, to);
    if (to.startsWith(from + "/")) throw new Error("bad path");
    if (!(await stat(src).then((s) => s.isDirectory(), () => false))) throw new NotFoundError();
    if (await stat(dst).then(() => true, () => false)) throw new ExistsError();
    await this.settled();
    const inner = await walk(src, "", false);
    let moved = 0;
    try {
      for (const f of inner) {
        const oldPath = `${from}/${f}`;
        const newPath = `${to}/${f}`;
        const isNote = f.toLowerCase().endsWith(".md");
        await this.api(isNote ? "/api/note/rename" : "/api/file/rename", {}, { method: "POST", actor, body: { vault: this.o.vault, oldPath, path: newPath } });
        await mkdir(path.dirname(path.join(this.o.mirrorDir, newPath)), { recursive: true });
        await fsRename(path.join(this.o.mirrorDir, oldPath), path.join(this.o.mirrorDir, newPath)).catch(() => {});
        await this.setState((st) => {
          const k = isNote ? "n" : "f";
          if (`${k}:${oldPath}` in st) {
            st[`${k}:${newPath}`] = st[`${k}:${oldPath}`];
            delete st[`${k}:${oldPath}`];
          }
        });
        moved++;
      }
    } catch (e) {
      throw new Error(`Renamed ${moved} of ${inner.length} items, then FNS refused: ${(e as Error).message}`);
    }
    if (!inner.length) await this.api("/api/folder", {}, { method: "POST", actor, body: { vault: this.o.vault, path: to } });
    await mkdir(dst, { recursive: true });
    await this.api("/api/folder", {}, { method: "DELETE", actor, body: { vault: this.o.vault, path: from } }).catch(() => {});
    await rm(src, { recursive: true, force: true });
  }
}
