import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Commit } from "../../shared/types";
import { textHash } from "../../shared/hash";

const run = promisify(execFile);

/** Where the vault's files and history come from. The HTTP layer only talks to this interface. */
export interface Backend {
  canWrite: boolean;
  /** optional startup hook (e.g. first sync) */
  init?(): Promise<void>;
  /** vault-relative paths of all files (notes + attachments), without .obsidian */
  tree(): Promise<string[]>;
  /** current bytes of a vault file (path already validated) */
  read(rel: string): Promise<Buffer>;
  history(rel: string): Promise<Commit[]>;
  /** text of a note at a history entry */
  readAt(rel: string, ref: string): Promise<string>;
  isValidRef(ref: string): boolean;
  /** editing operations (present only when the backend can write) */
  write?(rel: string, content: string, o?: WriteOpts): Promise<void>;
  mkdir?(rel: string, actor?: Actor): Promise<void>;
  rename?(from: string, to: string, actor?: Actor): Promise<void>;
  remove?(rel: string, actor?: Actor): Promise<void>;
  removeDir?(rel: string, actor?: Actor): Promise<void>;
}

/** Who is making an edit (from the signed-in OIDC identity), so it can be attributed in FNS logs or git history. */
export interface Actor {
  /** display text, e.g. "Danny Cherry (danny@example.com)" */
  label: string;
  name?: string;
  email?: string;
}

export interface WriteOpts {
  /** hash (shared/hash.ts) of the text the editor loaded; the save is refused if the note changed since */
  baseHash?: string;
  /** fail instead of overwriting an existing note */
  createOnly?: boolean;
  actor?: Actor;
  message?: string;
}

/** The note changed since the editor loaded it. */
export class ConflictError extends Error {
  constructor(public current: string) {
    super("conflict");
  }
}
export class ExistsError extends Error {
  constructor() {
    super("exists");
  }
}
export class NotFoundError extends Error {
  constructor() {
    super("not found");
  }
}
export class NotEmptyError extends Error {
  constructor() {
    super("folder is not empty");
  }
}

/** Validate a vault-relative path for creating/renaming: no traversal, hidden dirs or odd characters. */
export function checkNewPath(rel: string, kind: "note" | "folder"): string {
  const p = rel.trim().replace(/\/+$/, "");
  if (!p || p.length > 300 || p.startsWith("/") || p.includes("\\") || p.includes("\0") || /[<>:"|?*\x00-\x1f]/.test(p)) throw new Error("bad path");
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || s.startsWith(".") || s.length > 120)) throw new Error("bad path");
  if (kind === "note" && !p.toLowerCase().endsWith(".md")) throw new Error("notes must end in .md");
  return p;
}

export const sameText = (a: string, b: string) => textHash(a) === textHash(b);

export const HIDDEN = /(^|\/)(\.obsidian|\.git|\.trash)(\/|$)/;

/** Resolve a vault-relative path, rejecting anything that escapes the vault. */
export function safePath(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("bad path");
  if (HIDDEN.test(rel)) throw new Error("bad path");
  return abs;
}

/** Vault is a folder inside a git repository: history and writes come from git. */
export class GitBackend implements Backend {
  constructor(
    private root: string,
    public canWrite: boolean,
  ) {}

  private git = (...args: string[]) =>
    run("git", ["-c", "core.quotepath=off", "-C", this.root, ...args], { maxBuffer: 64 * 1024 * 1024 });

  async tree() {
    const { stdout } = await this.git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".");
    return stdout
      .split("\0")
      .filter((f) => f && !HIDDEN.test(f))
      .sort((a, b) => a.localeCompare(b));
  }

  read = (rel: string) => readFile(safePath(this.root, rel));

  async history(rel: string): Promise<Commit[]> {
    safePath(this.root, rel);
    const { stdout } = await this.git("log", "--follow", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", rel);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, message] = l.split("\x1f");
        return { sha, author, date, message };
      });
  }

  isValidRef = (ref: string) => /^[0-9a-f]{7,40}$/.test(ref);

  async readAt(rel: string, ref: string) {
    safePath(this.root, rel);
    return (await this.git("show", `${ref}:./${rel}`)).stdout;
  }

  private async commit(msg: string, actor: Actor | undefined, ...paths: string[]) {
    // the person who made the edit is the commit author; the server's own git identity stays the committer
    const clean = (t: string) => t.replace(/[<>\r\n]/g, "").trim();
    const author = actor?.name || actor?.email ? ["--author", `${clean(actor.name || actor.email!)} <${clean(actor.email || "noreply@obsidianweb.invalid")}>`] : [];
    try {
      await this.git("commit", ...author, "-m", msg, "--", ...paths);
    } catch {
      /* nothing changed */
    }
  }

  async write(rel: string, content: string, o: WriteOpts = {}) {
    const abs = safePath(this.root, rel);
    let existing: string | undefined;
    try {
      existing = await readFile(abs, "utf8");
    } catch {
      /* new file */
    }
    if (o.createOnly && existing !== undefined) throw new ExistsError();
    if (o.baseHash !== undefined && existing !== undefined && textHash(existing) !== o.baseHash) throw new ConflictError(existing);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await this.git("add", "--", rel);
    await this.commit(o.message || `Update ${rel}`, o.actor, rel);
  }

  async mkdir(rel: string) {
    await mkdir(safePath(this.root, rel), { recursive: true }); // git tracks files, so an empty folder exists only on disk until a page is added
  }

  async rename(from: string, to: string, actor?: Actor) {
    const src = safePath(this.root, from);
    const dst = safePath(this.root, to);
    await stat(src).catch(() => {
      throw new NotFoundError();
    });
    if (await stat(dst).then(() => true, () => false)) throw new ExistsError();
    await mkdir(path.dirname(dst), { recursive: true });
    await this.git("mv", "--", from, to);
    await this.commit(`Rename ${from} to ${to}`, actor, from, to);
  }

  async remove(rel: string, actor?: Actor) {
    safePath(this.root, rel);
    await this.git("rm", "-q", "--", rel).catch(() => {
      throw new NotFoundError();
    });
    await this.commit(`Delete ${rel}`, actor, rel);
  }

  async removeDir(rel: string) {
    const abs = safePath(this.root, rel);
    if ((await readdir(abs).catch(() => ["x"])).length) throw new NotEmptyError();
    await rm(abs, { recursive: true, force: true });
  }
}

/** All files under root; with dirs=true, empty folders are included as "folder/" entries. */
export async function walk(root: string, dir = "", dirs = false): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (HIDDEN.test(rel)) continue;
    if (e.isDirectory()) {
      const inner = await walk(root, rel, dirs);
      if (dirs && !inner.length) out.push(rel + "/");
      out.push(...inner);
    } else out.push(rel);
  }
  return out;
}
