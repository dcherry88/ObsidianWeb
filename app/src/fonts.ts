// Reading/typography preferences. Only fonts already installed on the device are used (no downloads).
export const FONT_OPTIONS = [
  { id: "default", label: "Default", css: "" },
  { id: "system", label: "System UI", css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "serif", label: "Serif (Georgia / Palatino)", css: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
  { id: "humanist", label: "Humanist sans (Calibri / Seravek)", css: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "Segoe UI", "DejaVu Sans", sans-serif' },
  { id: "legible", label: "High legibility (Atkinson / Verdana)", css: '"Atkinson Hyperlegible", Verdana, Tahoma, "DejaVu Sans", sans-serif' },
  { id: "dyslexia", label: "Dyslexia-friendly (OpenDyslexic / Lexend)", css: 'OpenDyslexic, Lexend, "Comic Sans MS", "Comic Neue", Verdana, sans-serif' },
  { id: "mono", label: "Monospace", css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "custom", label: "Custom (type a font name)", css: "" },
] as const;

export const CODE_OPTIONS = [
  { id: "default", label: "Default", css: "" },
  { id: "system", label: "System monospace", css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "courier", label: "Courier", css: '"Courier New", Courier, monospace' },
  { id: "custom", label: "Custom (type a font name)", css: "" },
] as const;

export const LINE_HEIGHTS = [
  { v: 0, label: "Default" },
  { v: 1.4, label: "Compact (1.4)" },
  { v: 1.7, label: "Comfortable (1.7)" },
  { v: 2, label: "Relaxed (2.0)" },
  { v: 2.3, label: "Extra relaxed (2.3)" },
];

export const WIDTHS = [
  { v: "", label: "Default" },
  { v: "640px", label: "Narrow" },
  { v: "780px", label: "Medium" },
  { v: "1000px", label: "Wide" },
  { v: "none", label: "Full width" },
];

export const SPACINGS = [
  { v: "", label: "Normal" },
  { v: "0.02em", label: "Slightly wider" },
  { v: "0.045em", label: "Wider" },
];

export interface FontPrefs {
  family: string;
  custom: string;
  code: string;
  codeCustom: string;
  size: number; // px, 0 = default
  lh: number; // 0 = default
  width: string;
  spacing: string;
  ui: boolean; // also apply the text font to menus and controls
}

export const DEFAULT_FONT: FontPrefs = { family: "default", custom: "", code: "default", codeCustom: "", size: 0, lh: 0, width: "", spacing: "", ui: false };

const clean = (n: string) => n.replace(/[^\p{L}\p{N}\s\-.]/gu, "").trim();
const named = (n: string, fallback: string) => (clean(n) ? `"${clean(n)}", ${fallback}` : "");

function stack(id: string, custom: string, options: readonly { id: string; css: string }[], fallback: string): string {
  if (id === "custom") return named(custom, fallback);
  return options.find((o) => o.id === id)?.css ?? "";
}

/** CSS custom properties for a set of preferences ("" = remove the property so the theme default applies). */
export function fontVars(p: FontPrefs): Record<string, string> {
  const text = stack(p.family, p.custom, FONT_OPTIONS, "sans-serif");
  return {
    "--font-body": text,
    "--font-ui": p.ui ? text : "",
    "--font-code": stack(p.code, p.codeCustom, CODE_OPTIONS, "monospace"),
    "--reading-size": p.size ? `${p.size}px` : "",
    "--reading-lh": p.lh ? String(p.lh) : "",
    "--reading-w": p.width,
    "--reading-ls": p.spacing,
  };
}
