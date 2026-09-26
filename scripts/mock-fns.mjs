// Minimal stand-in for the fast-note-sync-service REST API (documented endpoints only), for local testing.
//   node scripts/mock-fns.mjs [vaultDir]      env: PORT=9100 TOKEN=secret MOCK_AUTH=raw|bearer VAULT_NAME=test
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const dir = path.resolve(process.argv[2] ?? "vault");
const PORT = Number(process.env.PORT ?? 9100);
const TOKEN = process.env.TOKEN ?? "secret";
const AUTH = process.env.MOCK_AUTH ?? "raw";
const VAULT = process.env.VAULT_NAME ?? "test";

const all = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    if (/(^|\/)\.(obsidian|git)/.test(path.relative(dir, p))) continue;
    statSync(p).isDirectory() ? walk(p) : all.push(path.relative(dir, p).split(path.sep).join("/"));
  }
})(dir);
const meta = (p) => {
  const b = readFileSync(path.join(dir, p));
  return { id: all.indexOf(p) + 1, path: p, contentHash: createHash("md5").update(b).digest("hex").slice(0, 8), mtime: statSync(path.join(dir, p)).mtimeMs, size: b.length };
};
const ok = (data) => JSON.stringify({ code: 1, status: true, message: "ok", data });
const fail = (code, message) => JSON.stringify({ code, status: false, message });

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const auth = req.headers.authorization ?? "";
    const good = AUTH === "bearer" ? auth === `Bearer ${TOKEN}` : auth === TOKEN;
    const json = (s, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(s));
    if (u.pathname === "/api/health") return json(ok("ok"));
    if (!good) return json(fail(507, "Not logged in"), 401);
    if (u.searchParams.get("vault") && u.searchParams.get("vault") !== VAULT && !u.pathname.includes("history")) return json(fail(414, "Note Vault does not exist"));
    const page = Number(u.searchParams.get("page") ?? 1), size = Math.min(Number(u.searchParams.get("pageSize") ?? 10), 100);
    const paged = (items) => ok({ list: items.slice((page - 1) * size, page * size), pager: { page, pageSize: size, totalRows: items.length } });
    const q = u.searchParams.get("path");
    if (u.pathname === "/api/notes") return json(paged(all.filter((p) => p.endsWith(".md")).map(meta)));
    if (u.pathname === "/api/files") return json(paged(all.filter((p) => !p.endsWith(".md")).map(meta)));
    if (u.pathname === "/api/note") {
      if (!all.includes(q)) return json(fail(428, "Note does not exist"));
      return json(ok({ ...meta(q), content: readFileSync(path.join(dir, q), "utf8"), fileLinks: {} }));
    }
    if (u.pathname === "/api/file") {
      if (!all.includes(q)) return json(fail(428, "not found"), 404);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(path.join(dir, q)));
    }
    if (u.pathname === "/api/note/histories") {
      return json(paged([3, 2, 1].map((v) => ({ id: 100 + v, path: q, version: v, clientName: "Desktop", clientType: "obsidian", createdAt: new Date(Date.now() - v * 86400000).toISOString() }))));
    }
    if (u.pathname === "/api/note/history") {
      const id = Number(u.searchParams.get("id"));
      return json(ok({ id, version: id - 100, content: `# Old version ${id - 100}\n\nThis is what the note said at history id ${id}.\n` }));
    }
    json(fail(404, "unknown endpoint"), 404);
  })
  .listen(PORT, () => console.log(`mock FNS on :${PORT}, vault "${VAULT}", ${all.length} files, auth=${AUTH}`));
