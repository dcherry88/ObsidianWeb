// Fast Note Sync service (https://github.com/haierkeys/fast-note-sync-service) as the vault source.
// A background job mirrors the vault from the service's REST API into a local folder, so the rest of the
// server serves plain files. Note history is proxied live from the service. Read-only.
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Commit } from "../../shared/types";
import { type Backend, safePath, walk } from "./backend";

export interface FnsOptions {
  url: string;
  token: string;
  vault: string;
  mirrorDir: string;
  stateFile: string;
  intervalSec: number;
  /** client name sent as X-Client; must match the token's client restriction */
  client: string;
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

const toIso = (v: unknown): string => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return typeof v === "string" ? v : "";
};

export class FnsBackend implements Backend {
  canWrite = false;
  status: SyncStatus = { running: false, notes: 0, files: 0, changed: 0 };
  private timer?: NodeJS.Timeout;

  constructor(private o: FnsOptions) {}

  // ---------- HTTP ----------
  // FNS wants "Authorization: Bearer <token>" and identifies the caller by X-Client, which must match the
  // token's "Client restriction" (or the restriction must be "*").
  private headers() {
    return {
      Authorization: `Bearer ${this.o.token}`,
      "X-Client": this.o.client,
      "X-Client-Name": this.o.client,
      "X-Client-Version": "1.0",
    };
  }

  private fetchRaw(p: string, query: Record<string, string | number | boolean | undefined>) {
    const u = new URL(this.o.url.replace(/\/$/, "") + p);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return fetch(u, { headers: this.headers() });
  }

  private async api<T>(p: string, query: Record<string, string | number | boolean | undefined>): Promise<T> {
    const res = await this.fetchRaw(p, query);
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    const j = (await res.json()) as { code?: number; status?: boolean; message?: string; data?: T };
    if (j.status === false || (typeof j.code === "number" && j.code <= 0)) {
      const hint = j.code === 315 || j.code === 314 || /scope|client/i.test(j.message ?? "") ? ` (check the FNS token: it needs the REST protocol, read access to notes and attachments, this vault, and a Client restriction equal to "${this.o.client}" or "*")` : "";
      throw new Error(`${p}: ${j.message ?? "error"} (code ${j.code})${hint}`);
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
  tree = () => walk(this.o.mirrorDir).then((f) => f.sort((a, b) => a.localeCompare(b)));
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
}
