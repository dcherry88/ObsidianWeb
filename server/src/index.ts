import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, Commit } from "../../shared/types";

const run = promisify(execFile);

// --- config (env) ---
const VAULT = path.resolve(process.env.VAULT_PATH ?? "./vault");
const APP_DIST = path.resolve(process.env.APP_DIST ?? "./app/dist");
const PORT = Number(process.env.PORT ?? 8787);
const ALLOW_WRITE = ["1", "true"].includes(process.env.ALLOW_WRITE ?? "");

const git = (...args: string[]) =>
  run("git", ["-c", "core.quotepath=off", "-C", VAULT, ...args], { maxBuffer: 64 * 1024 * 1024 });

/** Resolve a vault-relative path, rejecting anything that escapes the vault. */
function safe(rel: string): string {
  const abs = path.resolve(VAULT, rel);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new Error("bad path");
  if (rel.split("/").some((p) => p === ".git" || p === ".obsidian")) throw new Error("bad path");
  return abs;
}

async function tree(): Promise<string[]> {
  const { stdout } = await git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".");
  return stdout
    .split("\0")
    .filter((f) => f.endsWith(".md") && !f.startsWith(".obsidian/"))
    .sort((a, b) => a.localeCompare(b));
}

async function history(file: string): Promise<Commit[]> {
  safe(file);
  const { stdout } = await git("log", "--follow", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", file);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, message] = l.split("\x1f");
      return { sha, author, date, message };
    });
}

const app = new Hono();

app.get("/config.json", (c) => c.json({ mode: "server", canWrite: ALLOW_WRITE } satisfies AppConfig));

app.get("/api/tree", async (c) => c.json(await tree()));

app.get("/api/file", async (c) => {
  const p = c.req.query("path") ?? "";
  const ref = c.req.query("ref");
  try {
    if (ref) {
      if (!/^[0-9a-f]{7,40}$/.test(ref)) return c.text("bad ref", 400);
      safe(p);
      const { stdout } = await git("show", `${ref}:./${p}`);
      return c.text(stdout);
    }
    return c.text(await readFile(safe(p), "utf8"));
  } catch {
    return c.text("not found", 404);
  }
});

app.get("/api/history", async (c) => {
  try {
    return c.json(await history(c.req.query("path") ?? ""));
  } catch {
    return c.json([]);
  }
});

app.put("/api/file", async (c) => {
  if (!ALLOW_WRITE) return c.text("writes disabled (set ALLOW_WRITE=1)", 403);
  const { path: p, content, message } = await c.req.json<{ path: string; content: string; message?: string }>();
  if (!p.endsWith(".md")) return c.text("markdown only", 400);
  const abs = safe(p);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await git("add", "--", p);
  try {
    await git("commit", "-m", message || `Update ${p}`, "--", p);
  } catch {
    /* nothing changed */
  }
  return c.text("ok");
});

// Built frontend (SPA is hash-routed, so no rewrites needed)
const rel = path.relative(process.cwd(), APP_DIST);
app.use("/*", serveStatic({ root: rel }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Vault: ${VAULT}\nWrites: ${ALLOW_WRITE ? "enabled" : "disabled"}\nhttp://localhost:${PORT}`);
});
