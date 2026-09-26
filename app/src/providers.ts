import type { AppConfig, Commit, VaultProvider, WriteOptions } from "../../shared/types";

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function ok(r: Response): Promise<Response> {
  // session expired (server mode with OIDC): go sign in again
  if (r.status === 401) {
    location.assign("./auth/login?next=" + encodeURIComponent(location.pathname));
    throw new Error("Signing in…");
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r;
}

/** The note changed elsewhere since it was opened; `current` is what is stored now. */
export class ConflictError extends Error {
  constructor(public current: string) {
    super("This note changed elsewhere while you were editing it.");
  }
}
export class ExistsError extends Error {
  constructor() {
    super("Something with that name already exists.");
  }
}
export class NotEmptyError extends Error {
  constructor() {
    super("The folder is not empty.");
  }
}

/** JSON write request with the server's structured errors turned into typed exceptions. */
async function mutate(method: string, url: string, body?: unknown): Promise<void> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    location.assign("./auth/login?next=" + encodeURIComponent(location.pathname));
    throw new Error("Signing in…");
  }
  if (r.ok) return;
  let j: any = {};
  try {
    j = await r.json();
  } catch {
    j = { error: await r.text().catch(() => "") };
  }
  if (j.conflict) throw new ConflictError(j.current ?? "");
  if (j.exists) throw new ExistsError();
  if (j.notEmpty) throw new NotEmptyError();
  throw new Error(j.error || `${r.status} request failed`);
}

/** Talks to the Node server (local git or Fast Note Sync). */
export class ApiProvider implements VaultProvider {
  constructor(public canWrite: boolean) {}
  tree = async () => (await ok(await fetch("./api/tree"))).json() as Promise<string[]>;
  assetUrl = (path: string) => `./api/raw?path=${encodeURIComponent(path)}`;
  read = async (path: string, ref?: string) =>
    (await ok(await fetch(`./api/file?path=${encodeURIComponent(path)}${ref ? `&ref=${ref}` : ""}`))).text();
  history = async (path: string) =>
    (await ok(await fetch(`./api/history?path=${encodeURIComponent(path)}`))).json() as Promise<Commit[]>;
  write = (path: string, content: string, opts: WriteOptions = {}) => mutate("PUT", "./api/file", { path, content, ...opts });
  mkdir = (path: string) => mutate("POST", "./api/folder", { path });
  rename = (from: string, to: string) => mutate("POST", "./api/rename", { from, to });
  remove = (path: string) => mutate("DELETE", `./api/file?path=${encodeURIComponent(path)}`);
  removeDir = (path: string) => mutate("DELETE", `./api/folder?path=${encodeURIComponent(path)}`);
}

/** GitHub Pages: vault files + index.json are copied into the site at build time; history comes from the GitHub API. */
export class StaticProvider implements VaultProvider {
  canWrite = false;
  constructor(private cfg: AppConfig) {}
  /** path of a note inside the GitHub repo (the vault may be the repo root, i.e. vaultPath "") */
  private repoPath(p: string) {
    return [(this.cfg.vaultPath ?? "vault").replace(/^\/|\/$/g, ""), p].filter(Boolean).join("/");
  }
  tree = async () => (await ok(await fetch("./index.json"))).json() as Promise<string[]>;
  assetUrl = (path: string) => `./vault/${enc(path)}`;
  read = async (path: string, ref?: string) => {
    const url = ref
      ? `https://raw.githubusercontent.com/${this.cfg.repo}/${ref}/${enc(this.repoPath(path))}`
      : `./vault/${enc(path)}`;
    return (await ok(await fetch(url))).text();
  };
  history = async (path: string) => {
    const q = new URLSearchParams({
      path: this.repoPath(path),
      sha: this.cfg.branch ?? "main",
      per_page: "50",
    });
    const rows = (await (await ok(await fetch(`https://api.github.com/repos/${this.cfg.repo}/commits?${q}`))).json()) as any[];
    return rows.map((r) => ({
      sha: r.sha,
      author: r.commit.author.name,
      date: r.commit.author.date,
      message: r.commit.message.split("\n")[0],
    }));
  };
  write = async () => {
    throw new Error("read-only in static mode");
  };
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  changed: number;
  notes: number;
  files: number;
}

/** Ask the server to pull from Fast Note Sync right now (server mode with VAULT_SOURCE=fns). */
export async function syncNow(): Promise<SyncResult> {
  return (await ok(await fetch("./api/sync", { method: "POST" }))).json() as Promise<SyncResult>;
}

export async function loadProvider(): Promise<{ cfg: AppConfig; provider: VaultProvider }> {
  let cfg: AppConfig = { mode: "server", canWrite: false };
  try {
    const r = await fetch("./config.json");
    if (r.status === 401) location.assign("./auth/login?next=" + encodeURIComponent(location.pathname));
    else if (r.ok) cfg = await r.json();
  } catch {
    /* dev server without config: assume server mode */
  }
  return { cfg, provider: cfg.mode === "static" ? new StaticProvider(cfg) : new ApiProvider(cfg.canWrite) };
}
