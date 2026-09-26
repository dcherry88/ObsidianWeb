import { Icon } from "./Icon";

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: boolean;
}

function build(files: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const entry of files) {
    let cur = root;
    const isDir = entry.endsWith("/"); // "Folder/" entries are (possibly empty) folders
    const parts = entry.replace(/\/$/, "").split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map(), file: !isDir && i === parts.length - 1 });
      cur = cur.children.get(part)!;
    });
  }
  return root;
}

/** Hover buttons on a folder row: rename or move (any folder) and delete (empty folders only). */
function FolderActions({ path, empty, onRename, onDelete }: { path: string; empty: boolean; onRename?: (p: string) => void; onDelete?: (p: string) => void }) {
  if (!onRename && !(onDelete && empty)) return null;
  return (
    <span class="row-acts">
      {onRename && (
        <button class="row-del" title="Rename or move this folder" aria-label="Rename folder" onClick={(e) => (e.stopPropagation(), onRename(path))}>
          <Icon name="edit" size={13} />
        </button>
      )}
      {onDelete && empty && (
        <button class="row-del danger-hover" title="Delete this empty folder" aria-label="Delete empty folder" onClick={(e) => (e.stopPropagation(), onDelete(path))}>
          <Icon name="trash" size={13} />
        </button>
      )}
    </span>
  );
}

function sorted(n: Node) {
  return [...n.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
}

function Branch({ node, depth, open, toggle, current, onOpen, onRenameFolder, onDeleteFolder }: any) {
  return (
    <>
      {sorted(node).map((c: Node) =>
        c.file ? (
          <div
            class={"row file" + (c.path === current ? " active" : "")}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onOpen(c.path)}
          >
            {c.name.replace(/\.md$/, "")}
          </div>
        ) : (
          <>
            <div class="row dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(c.path)}>
              <span class="chev">{open.has(c.path) ? "▾" : "▸"}</span> {c.name}
              <FolderActions path={c.path} empty={c.children.size === 0} onRename={onRenameFolder} onDelete={onDeleteFolder} />
            </div>
            {open.has(c.path) && <Branch node={c} depth={depth + 1} open={open} toggle={toggle} current={current} onOpen={onOpen} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder} />}
          </>
        ),
      )}
    </>
  );
}

export function Tree(props: { files: string[]; open: Set<string>; toggle: (p: string) => void; current: string; onOpen: (p: string) => void; onRenameFolder?: (p: string) => void; onDeleteFolder?: (p: string) => void }) {
  return <Branch node={build(props.files)} depth={0} {...props} />;
}

const pretty = (s: string) => s.replace(/\.md$/, "");

function NavBranch({ node, depth, open, toggle, current, onOpen, onRenameFolder, onDeleteFolder }: any) {
  const kids = sorted(node);
  // inside a folder: pages first, then sub-sections. At the top level: folders first, loose pages below them.
  const files = kids.filter((k: Node) => k.file);
  const dirs = kids.filter((k: Node) => !k.file);
  const ordered = depth === 0 ? [...dirs, ...files] : [...files, ...dirs];
  return (
    <>
      {ordered.map((c: Node) =>
        c.file ? (
          <div class={"nav-item" + (c.path === current ? " active" : "")} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => onOpen(c.path)}>
            {pretty(c.name)}
          </div>
        ) : (
          <div class="nav-section">
            <div class={"nav-heading d" + Math.min(depth, 2)} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => toggle(c.path)}>
              <span class="chev">{open.has(c.path) ? "▾" : "▸"}</span> {c.name}
              <FolderActions path={c.path} empty={c.children.size === 0} onRename={onRenameFolder} onDelete={onDeleteFolder} />
            </div>
            {open.has(c.path) && <NavBranch node={c} depth={depth + 1} open={open} toggle={toggle} current={current} onOpen={onOpen} onRenameFolder={onRenameFolder} onDeleteFolder={onDeleteFolder} />}
          </div>
        ),
      )}
    </>
  );
}

/** Wiki/doc-site style navigation: folders are section headings (expanded by default), pages are links beneath. */
export function NavMenu(props: { files: string[]; open: Set<string>; toggle: (p: string) => void; current: string; onOpen: (p: string) => void; onRenameFolder?: (p: string) => void; onDeleteFolder?: (p: string) => void }) {
  return <NavBranch node={build(props.files)} depth={0} {...props} />;
}
