interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: boolean;
}

function build(files: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const f of files) {
    let cur = root;
    const parts = f.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path, children: new Map(), file: i === parts.length - 1 });
      cur = cur.children.get(part)!;
    });
  }
  return root;
}

function sorted(n: Node) {
  return [...n.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
}

function Branch({ node, depth, open, toggle, current, onOpen }: any) {
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
            </div>
            {open.has(c.path) && <Branch node={c} depth={depth + 1} open={open} toggle={toggle} current={current} onOpen={onOpen} />}
          </>
        ),
      )}
    </>
  );
}

export function Tree(props: { files: string[]; open: Set<string>; toggle: (p: string) => void; current: string; onOpen: (p: string) => void }) {
  return <Branch node={build(props.files)} depth={0} {...props} />;
}

const pretty = (s: string) => s.replace(/\.md$/, "");

function NavBranch({ node, depth, closed, toggle, current, onOpen }: any) {
  const kids = sorted(node);
  // files first (like doc sites), then sections
  const ordered = [...kids.filter((k: Node) => k.file), ...kids.filter((k: Node) => !k.file)];
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
              <span class="chev">{closed.has(c.path) ? "▸" : "▾"}</span> {c.name}
            </div>
            {!closed.has(c.path) && <NavBranch node={c} depth={depth + 1} closed={closed} toggle={toggle} current={current} onOpen={onOpen} />}
          </div>
        ),
      )}
    </>
  );
}

/** Wiki/doc-site style navigation: folders are section headings (expanded by default), pages are links beneath. */
export function NavMenu(props: { files: string[]; closed: Set<string>; toggle: (p: string) => void; current: string; onOpen: (p: string) => void }) {
  return <NavBranch node={build(props.files)} depth={0} {...props} />;
}
