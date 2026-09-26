// Post-build for GitHub Pages: copy the vault into app/dist, write index.json + config.json.
import { cpSync, writeFileSync, readdirSync, statSync } from "node:fs";
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
    else if (name.endsWith(".md")) md.push(path.relative(vault, p).split(path.sep).join("/"));
  }
})(vault);
md.sort((a, b) => a.localeCompare(b));
writeFileSync(path.join(dist, "index.json"), JSON.stringify(md));

const repo = process.env.GITHUB_REPOSITORY ?? "dcherry88/ObsidianWeb";
const branch = process.env.GITHUB_REF_NAME ?? "main";
writeFileSync(
  path.join(dist, "config.json"),
  JSON.stringify({ mode: "static", canWrite: false, repo, branch, vaultPath: vaultDir }),
);
console.log(`static build: ${md.length} notes, repo=${repo}@${branch}`);
