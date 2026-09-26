// Outline icons (24x24 grid, stroke follows the text color). No emoji.
const PATHS: Record<string, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.6-3.6",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  home: "M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5",
  contents: "M4 6h16M4 12h10M4 18h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  panel: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v16",
  split: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 4v16",
  sync: "M21 4v6h-6M3 20v-6h6M5.6 9A8 8 0 0 1 19 7l2 3M18.4 15A8 8 0 0 1 5 17l-2-3",
  close: "M6 6l12 12M18 6L6 18",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};

export function Icon({ name, size = 18, spin = false }: { name: keyof typeof PATHS | string; size?: number; spin?: boolean }) {
  return (
    <svg class={"icon icon-" + name + (spin ? " spin" : "")} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
