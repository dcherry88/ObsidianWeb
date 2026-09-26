// Post-build for GitHub Pages: copy the vault into app/dist, write index.json + config.json.
import { cpSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "app/dist");
const vaultDir = process.env.VAULT_DIR ?? "vault";
const vault = path.join(root, vaultDir);

const skip = (p) => /(^|\/)(\.obsidian|\.git|\.trash)(\/|$)/.test(path.relative(vault, p));
cpSync(vault, path.join(dist, "vault"), { recursive: true, filter: (src) => !skip(src) });

const md = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else md.push(path.relative(vault, p).split(path.sep).join("/"));
  }
})(vault);
md.sort((a, b) => a.localeCompare(b));
writeFileSync(path.join(dist, "index.json"), JSON.stringify(md));

let obsidian = {};
try {
  obsidian = { attachmentFolderPath: JSON.parse(readFileSync(path.join(vault, ".obsidian/app.json"), "utf8")).attachmentFolderPath };
} catch {}

const repo = process.env.GITHUB_REPOSITORY ?? "dcherry88/ObsidianWeb";
const branch = process.env.GITHUB_REF_NAME ?? "main";
writeFileSync(
  path.join(dist, "config.json"),
  JSON.stringify({ mode: "static", canWrite: false, defaultLayout: process.env.DEFAULT_LAYOUT === "vault" ? "vault" : "doc", obsidian, repo, branch, vaultPath: vaultDir }),
);
console.log(`static build: ${md.length} notes, repo=${repo}@${branch}`);
