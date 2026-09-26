// Stand-in for the fast-note-sync-service REST API (documented endpoints only), for local testing.
//   node scripts/mock-fns.mjs [vaultDir]
//   env: PORT=9100 TOKEN=secret VAULT_NAME=test MOCK_CLIENT=ObsidianWeb|* (token "client restriction")
//        MOCK_WRITE=1 lets the token write notes/folders (otherwise write calls answer 315 "Scope restricted")
//   GET /__log returns what the mock has seen (writes and the client name that made them).
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const dir = path.resolve(process.argv[2] ?? "vault");
const PORT = Number(process.env.PORT ?? 9100);
const TOKEN = process.env.TOKEN ?? "secret";
const CLIENT = process.env.MOCK_CLIENT ?? "ObsidianWeb";
const VAULT = process.env.VAULT_NAME ?? "test";
const CAN_WRITE = process.env.MOCK_WRITE === "1";

const notes = new Map(); // path -> { content, mtime, version }
const files = []; // attachments (read from disk)
const folders = new Set();
const log = [];
let nextId = 1;
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    const rel = path.relative(dir, p).split(path.sep).join("/");
    if (/(^|\/)\.(obsidian|git)/.test(rel)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".md")) notes.set(rel, { content: readFileSync(p, "utf8"), mtime: statSync(p).mtimeMs, version: 1, id: nextId++ });
    else files.push(rel);
  }
})(dir);

const hash = (s) => createHash("md5").update(s).digest("hex").slice(0, 8);
const noteMeta = (p) => {
  const n = notes.get(p);
  return { id: n.id, path: p, contentHash: hash(n.content), mtime: n.mtime, size: n.content.length, version: n.version };
};
const fileMeta = (p) => {
  const b = readFileSync(path.join(dir, p));
  return { id: files.indexOf(p) + 1, path: p, contentHash: hash(b.toString("latin1")), mtime: statSync(path.join(dir, p)).mtimeMs, size: b.length };
};
const ok = (data) => JSON.stringify({ code: 1, status: true, message: "ok", data });
const fail = (code, message, details) => JSON.stringify({ code, status: false, message, ...(details ? { details } : {}) });

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (s, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(s));
    if (u.pathname === "/__log") return json(JSON.stringify(log));
    if (u.pathname === "/api/health") return json(ok("ok"));
    if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) return json(fail(307, "Not logged in. Please log in first."));
    const xc = String(req.headers["x-client"] ?? "");
    const clientOk = CLIENT === "*" || (CLIENT.endsWith("*") ? xc.startsWith(CLIENT.slice(0, -1)) : xc === CLIENT);
    if (!clientOk)
      return json(fail(315, "Auth token Scope restricted", `Permission denied: ${u.pathname}`));
    let bodyText = "";
    for await (const c of req) bodyText += c;
    const body = bodyText ? JSON.parse(bodyText) : {};
    const vault = u.searchParams.get("vault") ?? body.vault;
    if (vault && vault !== VAULT && !u.pathname.includes("history")) return json(fail(414, "Note Vault does not exist"));
    const write = req.method !== "GET";
    if (write && !CAN_WRITE) return json(fail(315, "Auth token Scope restricted", `Permission denied: ${u.pathname}`));
    const who = decodeURIComponent(String(req.headers["x-client-name"] ?? ""));
    const q = u.searchParams.get("path");
    const page = Number(u.searchParams.get("page") ?? 1), size = Math.min(Number(u.searchParams.get("pageSize") ?? 10), 100);
    const paged = (items) => ok({ list: items.slice((page - 1) * size, page * size), pager: { page, pageSize: size, totalRows: items.length } });

    if (u.pathname === "/api/notes") return json(paged([...notes.keys()].map(noteMeta)));
    if (u.pathname === "/api/files") return json(paged(files.map(fileMeta)));
    if (u.pathname === "/api/note" && req.method === "GET") {
      if (!notes.has(q)) return json(fail(428, "Note does not exist"));
      return json(ok({ ...noteMeta(q), content: notes.get(q).content, fileLinks: {} }));
    }
    if (u.pathname === "/api/note" && req.method === "POST") {
      const ex = notes.get(body.path);
      if (body.createOnly && ex) return json(fail(408, "Note already exists"));
      const n = { content: body.content, mtime: body.mtime ?? Date.now(), version: (ex?.version ?? 0) + 1, id: ex?.id ?? nextId++ };
      notes.set(body.path, n);
      log.push({ op: ex ? "update" : "create", path: body.path, by: who, client: xc });
      return json(ok(noteMeta(body.path)));
    }
    if (u.pathname === "/api/note" && req.method === "DELETE") {
      if (!notes.has(q)) return json(fail(428, "Note does not exist"));
      notes.delete(q);
      log.push({ op: "delete", path: q, by: who, client: xc });
      return json(ok({ path: q }));
    }
    if (u.pathname === "/api/note/rename" && req.method === "POST") {
      const n = notes.get(body.oldPath);
      if (!n) return json(fail(428, "Note does not exist"));
      notes.delete(body.oldPath);
      notes.set(body.path, n);
      log.push({ op: "rename", from: body.oldPath, to: body.path, by: who, client: xc });
      return json(ok({ path: body.path }));
    }
    if (u.pathname === "/api/folder" && req.method === "POST") {
      folders.add(body.path);
      log.push({ op: "mkdir", path: body.path, by: who });
      return json(ok({ path: body.path }));
    }
    if (u.pathname === "/api/folder" && req.method === "DELETE") {
      folders.delete(body.path);
      log.push({ op: "rmdir", path: body.path, by: who });
      return json(ok({ path: body.path }));
    }
    if (u.pathname === "/api/file") {
      if (!files.includes(q)) return json(fail(428, "not found"), 404);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(path.join(dir, q)));
    }
    if (u.pathname === "/api/note/histories")
      return json(paged([3, 2, 1].map((v) => ({ id: 100 + v, path: q, version: v, clientName: "Desktop", clientType: "obsidian", createdAt: new Date(Date.now() - v * 86400000).toISOString() }))));
    if (u.pathname === "/api/note/history") {
      const id = Number(u.searchParams.get("id"));
      return json(ok({ id, version: id - 100, content: `# Old version ${id - 100}\n\nThis is what the note said at history id ${id}.\n` }));
    }
    json(fail(404, "unknown endpoint"), 404);
  })
  .listen(PORT, () => console.log(`mock FNS on :${PORT}, vault "${VAULT}", ${notes.size} notes, ${files.length} files, client=${CLIENT}, write=${CAN_WRITE}`));
