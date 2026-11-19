// Where the visitor's GitHub token lives: in this tab's memory by default, and in this device's
// localStorage only when they tick "Remember on this device". Forgetting clears both at once. The token
// itself only ever goes to api.github.com (core/github.ts).
import { parseRepo, repoName, type Repo } from "./github.ts";

export const TOKEN_KEY = "sayfold:github";

export interface Connection { repo: Repo; token: string }
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export class GitHubLink {
  private conn: Connection | null = null;
  private stored = false;
  private readonly storage: Store | null;

  /** `storage` is localStorage, or null (or one that throws) to keep everything in memory. */
  constructor(storage: Store | null) {
    this.storage = storage;
    this.conn = this.load();
    this.stored = this.conn !== null;
  }

  /** The repo and token, or null when not connected. */
  get current(): Connection | null {
    return this.conn;
  }

  /** The token is kept on this device. */
  get remembered(): boolean {
    return this.stored;
  }

  /** Connected: kept in memory, and on this device only when `remember` is on (otherwise anything remembered is removed). */
  set(conn: Connection, remember: boolean) {
    this.conn = { repo: { ...conn.repo }, token: conn.token };
    if (!remember) return this.unstore();
    try {
      this.storage?.setItem(TOKEN_KEY, JSON.stringify({ repo: repoName(conn.repo), token: conn.token }));
      this.stored = this.storage !== null;
    } catch {
      // Storage blocked: the token stays in memory only.
      this.stored = false;
    }
  }

  /** Forget the token: out of memory and off this device, in one go. */
  forget() {
    this.conn = null;
    this.unstore();
  }

  private unstore() {
    this.stored = false;
    try {
      this.storage?.removeItem(TOKEN_KEY);
    } catch {
      // Nothing could have been stored.
    }
  }

  private load(): Connection | null {
    try {
      const raw = this.storage?.getItem(TOKEN_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as { repo?: unknown; token?: unknown };
      const repo = typeof v.repo === "string" ? parseRepo(v.repo) : null;
      if (!repo || typeof v.token !== "string" || !v.token) return null;
      return { repo, token: v.token };
    } catch {
      return null;
    }
  }
}
