import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../shared/types";
import { type Actor, type Backend, ConflictError, ExistsError, GitBackend, MAX_UPLOAD_BYTES, NotEmptyError, NotFoundError, attachmentFolder, attachmentName, checkNewPath, safePath } from "./backend";
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
    canWrite: flag(env.ALLOW_WRITE),
    clientPerUser: flag(env.FNS_CLIENT_PER_USER),
  });
  backend = fns;
} else {
  VAULT = path.resolve(ROOT, env.VAULT_PATH ?? "vault");
  backend = new GitBackend(VAULT, flag(env.ALLOW_WRITE));
}

const app = new Hono();
const auth = setupAuth(app, env, path.join(DATA_DIR, "sessions.json")); // no-op unless OIDC_ISSUER is set
if (!auth.enabled) {
  console.warn("[auth] OIDC is disabled: the vault API is open to anyone who can reach this server. Bind to localhost or put authentication in front in production.");
}

// Baseline hardening headers (CSP for the app shell lives at the reverse proxy; these are safe defaults here).
app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "SAMEORIGIN");
});

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

// ---- editing: create / edit / rename / delete (needs ALLOW_WRITE=1; FNS mode also needs a token that may write) ----
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
// Hono buffers the whole JSON body before we see it, so refuse oversized payloads before parsing.
const MAX_JSON_BYTES = MAX_NOTE_BYTES + 64 * 1024;
const publicOrigin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : undefined;

/** Refuse when the request comes from another site (cookies alone must not authorise a state change). */
function csrfGuard(c: Context): Response | undefined {
  const origin = c.req.header("origin");
  if (origin) {
    let ok = origin === publicOrigin;
    try {
      ok = ok || new URL(origin).host === c.req.header("host");
    } catch {
      ok = false;
    }
    if (!ok) return c.text("cross-site request refused", 403);
  }
  return undefined;
}

/** Refuse when editing is off or the request comes from another site (cookies alone must not authorise a write). */
function writeGuard(c: Context): Response | undefined {
  if (!backend.canWrite) return c.text("editing is disabled on this server", 403);
  return csrfGuard(c);
}

/** The signed-in person, for attribution (FNS client name, git commit author). Undefined when login is off. */
const who = (c: Context): Actor | undefined => {
  const u = auth.userOf(c);
  if (!u) return undefined;
  const label = u.name && u.email ? `${u.name} (${u.email})` : u.name || u.email || u.sub;
  return { label, name: u.name, email: u.email };
};

function failed(c: Context, e: unknown): Response {
  if (e instanceof ConflictError) return c.json({ conflict: true, current: e.current }, 409);
  if (e instanceof ExistsError) return c.json({ exists: true, error: "already exists" }, 409);
  if (e instanceof NotEmptyError) return c.json({ notEmpty: true, error: "folder is not empty" }, 409);
  if (e instanceof NotFoundError) return c.json({ error: "not found" }, 404);
  const msg = (e as Error)?.message ?? "";
  if (msg === "bad path" || msg.startsWith("notes must") || msg.startsWith("file type")) return c.json({ error: msg }, 400);
  console.error("[edit]", msg);
  return c.json({ error: "the change could not be saved: " + msg.slice(0, 500) }, 502);
}

async function body<T>(c: Context): Promise<T | undefined> {
  try {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_JSON_BYTES) return undefined;
    return (await c.req.json()) as T;
  } catch {
    return undefined;
  }
}

app.put("/api/file", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  const b = await body<{ path: string; content: string; message?: string; baseHash?: string; createOnly?: boolean }>(c);
  if (!b || typeof b.path !== "string" || typeof b.content !== "string") return c.json({ error: "bad request" }, 400);
  if (Buffer.byteLength(b.content) > MAX_NOTE_BYTES) return c.json({ error: "note is too large (2 MB limit)" }, 413);
  try {
    const p = checkNewPath(b.path, "note");
    await backend.write!(p, b.content, { baseHash: b.baseHash, createOnly: !!b.createOnly, actor: who(c), message: b.message });
    return c.json({ ok: true, path: p });
  } catch (e) {
    return failed(c, e);
  }
});

app.post("/api/folder", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  const b = await body<{ path: string }>(c);
  try {
    const p = checkNewPath(b?.path ?? "", "folder");
    await backend.mkdir!(p, who(c));
    return c.json({ ok: true, path: p });
  } catch (e) {
    return failed(c, e);
  }
});

app.post("/api/rename", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  const b = await body<{ from: string; to: string }>(c);
  try {
    const from = checkNewPath(b?.from ?? "", "note");
    const to = checkNewPath(b?.to ?? "", "note");
    await backend.rename!(from, to, who(c));
    return c.json({ ok: true, path: to });
  } catch (e) {
    return failed(c, e);
  }
});

app.post("/api/rename-folder", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  const b = await body<{ from: string; to: string }>(c);
  try {
    const from = checkNewPath(b?.from ?? "", "folder");
    const to = checkNewPath(b?.to ?? "", "folder");
    await backend.renameDir!(from, to, who(c));
    return c.json({ ok: true, path: to });
  } catch (e) {
    return failed(c, e);
  }
});

// Attachment upload (images, PDFs, audio, video) from the editor: paste, drop, or the Attach button.
app.post("/api/upload", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  try {
    const form = await c.req.parseBody();
    const file = form["file"];
    const note = typeof form["note"] === "string" ? (form["note"] as string) : "";
    if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: `file is too large (${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit)` }, 413);
    const name = attachmentName(file.name);
    const folder = attachmentFolder((await obsidianSettings())?.attachmentFolderPath, note && note.endsWith(".md") ? checkNewPath(note, "note") : "x.md");
    const taken = async (p: string) => stat(safePath(VAULT, p)).then(() => true, () => false);
    let dest = [folder, name].filter(Boolean).join("/");
    for (let n = 1; (await taken(dest)) && n < 100; n++) {
      const dot = name.lastIndexOf(".");
      dest = [folder, `${name.slice(0, dot)} ${n}${name.slice(dot)}`].filter(Boolean).join("/");
    }
    if (await taken(dest)) return c.json({ error: "a file with that name already exists" }, 409);
    checkNewPath(dest, "folder"); // path sanity (no traversal, no hidden folders)
    await backend.upload!(dest, Buffer.from(await file.arrayBuffer()), who(c));
    return c.json({ ok: true, path: dest, name: dest.split("/").pop() });
  } catch (e) {
    return failed(c, e);
  }
});

app.delete("/api/file", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  try {
    const p = checkNewPath(c.req.query("path") ?? "", "note");
    await backend.remove!(p, who(c));
    return c.json({ ok: true });
  } catch (e) {
    return failed(c, e);
  }
});

app.delete("/api/folder", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  try {
    const p = checkNewPath(c.req.query("path") ?? "", "folder");
    await backend.removeDir!(p, who(c));
    return c.json({ ok: true });
  } catch (e) {
    return failed(c, e);
  }
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
  // Force a sync and wait for it. Any signed-in user may do this (all users have the same access),
  // but cross-site requests are refused and manual syncs are throttled to avoid hammering the upstream.
  let lastManualSync = 0;
  app.post("/api/sync", async (c) => {
    const denied = csrfGuard(c);
    if (denied) return denied;
    const since = Date.now() - lastManualSync;
    if (since < 10_000) return c.json({ ok: false, error: "sync is throttled, try again shortly" }, 429);
    lastManualSync = Date.now();
    await fns!.syncOnce();
    const st = fns!.status;
    return c.json({ ok: !st.lastError, error: st.lastError, changed: st.changed, notes: st.notes, files: st.files, at: st.lastOk });
  });
}

// Built frontend (SPA is hash-routed, so no rewrites needed). Absolute root: independent of process cwd.
app.use("/*", serveStatic({ root: APP_DIST }));

await backend.init?.();
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(
    `Source: ${SOURCE === "fns" ? `fast-note-sync (${env.FNS_URL}, vault "${env.FNS_VAULT}", every ${env.FNS_SYNC_INTERVAL ?? 60}s)` : VAULT}\n` +
      `Writes: ${backend.canWrite ? "enabled" : "disabled"}\nAuth: ${auth.enabled ? "OIDC (" + env.OIDC_ISSUER + ")" : "none"}\nhttp://localhost:${PORT}`,
  );
});
