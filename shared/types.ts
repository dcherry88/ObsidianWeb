export interface Commit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export interface AppConfig {
  mode: "server" | "static";
  canWrite: boolean;
  /** static mode only: GitHub repo used for history, e.g. "owner/repo" */
  repo?: string;
  branch?: string;
  /** static mode only: vault folder inside the repo */
  vaultPath?: string;
}

/** Everything the UI needs from a vault. Implemented by the server API and the static/GitHub provider. */
export interface VaultProvider {
  canWrite: boolean;
  /** vault-relative paths of markdown files */
  tree(): Promise<string[]>;
  read(path: string, ref?: string): Promise<string>;
  history(path: string): Promise<Commit[]>;
  write(path: string, content: string, message?: string): Promise<void>;
}
