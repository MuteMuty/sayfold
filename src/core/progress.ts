// Model download progress across all its files, as one bar that only moves forward.

export class LoadProgress {
  private files = new Map<string, { loaded: number; total: number }>();
  private shown = 0;

  /** `expected`: file → size in bytes, for files whose size is known before they load. */
  constructor(expected: Record<string, number> = {}) {
    for (const [file, total] of Object.entries(expected)) this.files.set(file, { loaded: 0, total });
  }

  /** `total` is 0 when the server didn't say; the expected size is kept then. */
  update(file: string, loaded: number, total: number): void {
    this.files.set(file, { loaded, total: total > 0 ? total : (this.files.get(file)?.total ?? 0) });
  }

  /** A file finished; one whose size was never known counts as fully loaded from now on. */
  done(file: string): void {
    const f = this.files.get(file);
    const size = f && f.total > 0 ? f.total : Math.max(f?.loaded ?? 0, 1);
    this.files.set(file, { loaded: size, total: size });
  }

  get loaded(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.total > 0 ? Math.min(f.loaded, f.total) : 0;
    return n;
  }

  get total(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.total;
    return n;
  }

  /** 0 to 1, never lower than it was. */
  get fraction(): number {
    const t = this.total;
    this.shown = Math.max(this.shown, t > 0 ? this.loaded / t : 0);
    return this.shown;
  }
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
