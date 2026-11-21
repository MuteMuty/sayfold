// The live-dictation counter, kept by one SQLite-backed Durable Object (src/server/index.ts): the day's
// estimated neurons, each visitor's seconds of audio and the recordings open right now. A visitor is
// known only by an HMAC-SHA-256 of their IP address and the day, under a random salt made for that UTC
// day. Earlier days' salts and counts are deleted. No audio, text or IP address is ever stored here.
import type { FallbackReason, ListenStatus } from "../listen/protocol.ts";
import {
  DAILY_NEURON_CAP, NEURONS_PER_AUDIO_SECOND, SESSION_MAX_SECONDS, STALE_SESSION_MS, VISITOR_OPEN_SESSIONS, VISITOR_SECONDS_PER_DAY,
} from "./config.ts";

/** The part of the Durable Object's `ctx.storage.sql` the counter uses. */
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

export type Opened =
  /** `seconds`: the most audio this recording may stream (the session's limit, or what's left of the visitor's day). */
  | { ok: true; session: string; seconds: number }
  | { ok: false; reason: Extract<FallbackReason, "cap" | "visitor-limit" | "busy"> };

export type Added = { ok: true } | { ok: false; reason: Extract<FallbackReason, "cap" | "visitor-limit" | "error"> };

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

export class MeterCore {
  private sql: Sql;
  private now: () => number;
  /** The day the stored rows belong to, once they've been checked. */
  private day = "";
  private key: { day: string; key: Promise<CryptoKey> } | null = null;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.sql = sql;
    this.now = now;
    sql.exec("CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, neurons REAL NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, visitor TEXT NOT NULL, seconds REAL NOT NULL, PRIMARY KEY (day, visitor))");
    sql.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, visitor TEXT NOT NULL, seen INTEGER NOT NULL)");
  }

  async status(ip: string): Promise<ListenStatus> {
    const day = this.today();
    const visitor = await this.visitor(ip, day);
    return { available: this.neurons(day) < DAILY_NEURON_CAP && this.seconds(day, visitor) < VISITOR_SECONDS_PER_DAY };
  }

  async open(ip: string): Promise<Opened> {
    const day = this.today();
    const visitor = await this.visitor(ip, day);
    // From here on nothing awaits, so two opens can't both slip past the checks.
    if (this.neurons(day) >= DAILY_NEURON_CAP) return { ok: false, reason: "cap" };
    const now = this.now();
    this.sql.exec("DELETE FROM sessions WHERE seen < ?", now - STALE_SESSION_MS);
    const open = Number(this.sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE visitor = ?", visitor).toArray()[0].n);
    if (open >= VISITOR_OPEN_SESSIONS) return { ok: false, reason: "busy" };
    const left = VISITOR_SECONDS_PER_DAY - this.seconds(day, visitor);
    if (left <= 0) return { ok: false, reason: "visitor-limit" };
    const session = crypto.randomUUID();
    this.sql.exec("INSERT INTO sessions (id, visitor, seen) VALUES (?, ?, ?)", session, visitor, now);
    return { ok: true, session, seconds: Math.min(SESSION_MAX_SECONDS, left) };
  }

  /** Counts `seconds` of audio a recording streamed, and says whether it may go on. */
  add(session: string, seconds: number): Added {
    const day = this.today();
    const row = this.sql.exec("SELECT visitor FROM sessions WHERE id = ?", session).toArray()[0];
    if (!row) return { ok: false, reason: "error" };
    const visitor = String(row.visitor);
    this.sql.exec("UPDATE sessions SET seen = ? WHERE id = ?", this.now(), session);
    this.sql.exec(
      "INSERT INTO days (day, neurons) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET neurons = neurons + excluded.neurons",
      day, seconds * NEURONS_PER_AUDIO_SECOND,
    );
    this.sql.exec(
      "INSERT INTO visitors (day, visitor, seconds) VALUES (?, ?, ?) ON CONFLICT (day, visitor) DO UPDATE SET seconds = seconds + excluded.seconds",
      day, visitor, seconds,
    );
    if (this.neurons(day) >= DAILY_NEURON_CAP) return { ok: false, reason: "cap" };
    if (this.seconds(day, visitor) >= VISITOR_SECONDS_PER_DAY) return { ok: false, reason: "visitor-limit" };
    return { ok: true };
  }

  close(session: string): void {
    this.sql.exec("DELETE FROM sessions WHERE id = ?", session);
  }

  /** Today's date in UTC, after deleting every earlier day's salt and counts. */
  private today(): string {
    const day = utcDay(this.now());
    if (day !== this.day) {
      for (const table of ["salts", "days", "visitors"]) this.sql.exec(`DELETE FROM ${table} WHERE day <> ?`, day);
      this.day = day;
    }
    return day;
  }

  private neurons(day: string): number {
    return Number(this.sql.exec("SELECT neurons FROM days WHERE day = ?", day).toArray()[0]?.neurons ?? 0);
  }

  private seconds(day: string, visitor: string): number {
    return Number(this.sql.exec("SELECT seconds FROM visitors WHERE day = ? AND visitor = ?", day, visitor).toArray()[0]?.seconds ?? 0);
  }

  /** The visitor's hash for the day: HMAC-SHA-256 of "ip|day" under the day's salt. */
  private async visitor(ip: string, day: string): Promise<string> {
    if (this.key?.day !== day) {
      let salt = this.sql.exec("SELECT salt FROM salts WHERE day = ?", day).toArray()[0]?.salt as string | undefined;
      if (!salt) {
        salt = hex(crypto.getRandomValues(new Uint8Array(32)));
        this.sql.exec("INSERT INTO salts (day, salt) VALUES (?, ?)", day, salt);
      }
      const raw = unhex(salt);
      this.key = { day, key: crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) };
    }
    const mac = await crypto.subtle.sign("HMAC", await this.key.key, new TextEncoder().encode(`${ip}|${day}`));
    return hex(mac);
  }
}
