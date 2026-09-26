import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Commit } from "../../shared/types";

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
  write?(rel: string, content: string, message?: string): Promise<void>;
}

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

  async write(rel: string, content: string, message?: string) {
    const abs = safePath(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await this.git("add", "--", rel);
    try {
      await this.git("commit", "-m", message || `Update ${rel}`, "--", rel);
    } catch {
      /* nothing changed */
    }
  }
}

export async function walk(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (HIDDEN.test(rel)) continue;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else out.push(rel);
  }
  return out;
}
