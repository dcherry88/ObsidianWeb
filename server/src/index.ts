import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../shared/types";
import { type Backend, GitBackend, safePath } from "./backend";
import { FnsBackend } from "./fns";
import { setupAuth } from "./auth";

const env = process.env;
const flag = (v?: string) => ["1", "true", "yes"].includes((v ?? "").toLowerCase());

// Defaults are relative to the repo root, not the working directory (npm runs workspaces from server/).
const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = Number(env.PORT ?? 8787);
const APP_DIST = path.resolve(ROOT, env.APP_DIST ?? "app/dist");
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR ?? "data");
const SOURCE = (env.VAULT_SOURCE ?? "git").toLowerCase();

// ---- vault backend: local git repo (default) or a Fast Note Sync service mirrored to disk ----
let VAULT: string;
let backend: Backend;
let fns: FnsBackend | undefined;

if (SOURCE === "fns") {
  for (const k of ["FNS_URL", "FNS_TOKEN", "FNS_VAULT"]) if (!env[k]) throw new Error(`VAULT_SOURCE=fns requires ${k}`);
  VAULT = path.join(DATA_DIR, "vault");
  fns = new FnsBackend({
    url: env.FNS_URL!,
    token: env.FNS_TOKEN!,
    vault: env.FNS_VAULT!,
    mirrorDir: VAULT,
    stateFile: path.join(DATA_DIR, "fns-state.json"),
    intervalSec: Number(env.FNS_SYNC_INTERVAL ?? 60),
    client: env.FNS_CLIENT || "ObsidianWeb",
  });
  backend = fns;
} else {
  VAULT = path.resolve(ROOT, env.VAULT_PATH ?? "vault");
  backend = new GitBackend(VAULT, flag(env.ALLOW_WRITE));
}

const app = new Hono();
const auth = setupAuth(app, env); // no-op unless OIDC_ISSUER is set

app.get("/healthz", (c) => c.text("ok"));

async function obsidianSettings(): Promise<AppConfig["obsidian"]> {
  if (env.ATTACHMENT_FOLDER) return { attachmentFolderPath: env.ATTACHMENT_FOLDER };
  try {
    const j = JSON.parse(await readFile(path.join(VAULT, ".obsidian/app.json"), "utf8"));
    return { attachmentFolderPath: j.attachmentFolderPath };
  } catch {
    return {};
  }
}

app.get("/config.json", async (c) => {
  const u = auth.userOf(c);
  return c.json({
    mode: "server",
    canWrite: backend.canWrite,
    defaultLayout: env.DEFAULT_LAYOUT === "vault" ? "vault" : "doc",
    obsidian: await obsidianSettings(),
    user: u ? { name: u.name, email: u.email } : undefined,
    signOutUrl: auth.enabled ? "./auth/logout" : undefined,
    canSync: !!fns,
  } satisfies AppConfig);
});

app.get("/api/tree", async (c) => c.json(await backend.tree()));

app.get("/api/file", async (c) => {
  const p = c.req.query("path") ?? "";
  const ref = c.req.query("ref");
  try {
    if (ref) {
      if (!backend.isValidRef(ref)) return c.text("bad ref", 400);
      return c.text(await backend.readAt(p, ref));
    }
    return c.text((await backend.read(p)).toString("utf8"));
  } catch {
    return c.text("not found", 404);
  }
});

app.get("/api/history", async (c) => {
  try {
    return c.json(await backend.history(c.req.query("path") ?? ""));
  } catch (e) {
    console.warn("[history]", (e as Error).message);
    return c.json([]);
  }
});

app.put("/api/file", async (c) => {
  if (!backend.canWrite || !backend.write) return c.text("writes disabled", 403);
  const { path: p, content, message } = await c.req.json<{ path: string; content: string; message?: string }>();
  if (!p.endsWith(".md")) return c.text("markdown only", 400);
  safePath(VAULT, p);
  await backend.write(p, content, message);
  return c.text("ok");
});

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm",
};

// Attachments (images etc.). Served sandboxed so an SVG cannot run script in this origin.
app.get("/api/raw", async (c) => {
  try {
    const p = c.req.query("path") ?? "";
    const buf = await backend.read(p);
    const ext = p.split(".").pop()!.toLowerCase();
    // PDFs need to load in the browser's viewer (a sandboxed frame blocks it); everything else stays sandboxed.
    const pdf = ext === "pdf";
    return c.body(new Uint8Array(buf), 200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      ...(pdf ? { "content-disposition": "inline" } : { "content-security-policy": "sandbox" }),
      "x-content-type-options": "nosniff",
    });
  } catch {
    return c.text("not found", 404);
  }
});

if (fns) {
  app.get("/api/sync/status", (c) => c.json(fns!.status));
  // Force a sync and wait for it. Any signed-in user may do this (all users have the same access).
  app.post("/api/sync", async (c) => {
    await fns!.syncOnce();
    const st = fns!.status;
    return c.json({ ok: !st.lastError, error: st.lastError, changed: st.changed, notes: st.notes, files: st.files, at: st.lastOk });
  });
}

// Built frontend (SPA is hash-routed, so no rewrites needed)
app.use("/*", serveStatic({ root: path.relative(process.cwd(), APP_DIST) }));

await backend.init?.();
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(
    `Source: ${SOURCE === "fns" ? `fast-note-sync (${env.FNS_URL}, vault "${env.FNS_VAULT}", every ${env.FNS_SYNC_INTERVAL ?? 60}s)` : VAULT}\n` +
      `Writes: ${backend.canWrite ? "enabled" : "disabled"}\nAuth: ${auth.enabled ? "OIDC (" + env.OIDC_ISSUER + ")" : "none"}\nhttp://localhost:${PORT}`,
  );
});
