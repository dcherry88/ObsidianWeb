export interface Commit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface AppConfig {
  mode: "server" | "static";
  canWrite: boolean;
  /** initial layout when the user has no saved preference */
  defaultLayout?: "doc" | "vault";
  /** subset of the vault's .obsidian/app.json that affects rendering */
  obsidian?: { attachmentFolderPath?: string };
  /** signed-in user when OIDC is enabled */
  user?: { name?: string; email?: string };
  signOutUrl?: string;
  /** server can pull from Fast Note Sync on demand (POST /api/sync) */
  canSync?: boolean;
  /** static mode only: GitHub repo used for history, e.g. "owner/repo" */
  repo?: string;
  branch?: string;
  /** static mode only: vault folder inside the repo */
  vaultPath?: string;
}

export interface WriteOptions {
  /** hash (shared/hash.ts) of the text that was loaded; the save is refused if the note changed since */
  baseHash?: string;
  /** fail instead of overwriting an existing note */
  createOnly?: boolean;
  message?: string;
}

/** Everything the UI needs from a vault. Implemented by the server API and the static/GitHub provider. */
export interface VaultProvider {
  canWrite: boolean;
  /** vault-relative paths of all files (notes and attachments; .obsidian excluded) */
  tree(): Promise<string[]>;
  read(path: string, ref?: string): Promise<string>;
  history(path: string): Promise<Commit[]>;
  write(path: string, content: string, opts?: WriteOptions): Promise<void>;
  /** structure editing (server mode with editing enabled) */
  mkdir?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  removeDir?(path: string): Promise<void>;
  renameDir?(from: string, to: string): Promise<void>;
  /** upload an attachment for the note being edited; returns where it was stored */
  upload?(note: string, file: File): Promise<{ path: string; name: string }>;
  /** URL for a non-markdown vault file (images, PDFs...) */
  assetUrl(path: string): string;
}
