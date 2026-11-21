// Stand-ins for the Workers runtime, for the server's unit tests. Nothing here reaches Workers AI or the
// network: the AI binding, the WebSockets and the Durable Object's SQLite storage are all local.
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../../src/server/meter.ts";
import { MeterCore } from "../../src/server/meter.ts";
import type { Runtime, Socket, SpeechAi } from "../../src/server/listen.ts";

/** The Durable Object's `ctx.storage.sql`, on a real in-memory SQLite database. */
export function memorySql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, string | number | null>[];
      return { toArray: () => rows };
    },
  };
}

/** Every table and every row in the database, for checking what was kept. */
export function dump(db: DatabaseSync): Record<string, Record<string, unknown>[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().map((r) => ({ ...r }))]));
}

type Listener = (event: { data: unknown }) => void;

/** One end of a WebSocket: records what is sent and closed, and lets a test deliver messages to it. */
export class FakeSocket implements Socket {
  accepted = false;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Listener[]>();

  accept(): void {
    this.accepted = true;
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("send after close");
    if (typeof data === "string") this.sent.push(data);
    else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    else this.sent.push(new Uint8Array(data).slice());
  }
  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Delivers an event, as the other end (or the network) would. */
  emit(type: "message" | "close" | "error", data?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  /** The JSON messages sent, parsed. */
  get messages(): unknown[] {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m));
  }
  /** The binary frames sent, joined. */
  get bytes(): Uint8Array {
    const frames = this.sent.filter((m): m is Uint8Array => typeof m !== "string");
    const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) out.set(f, (at += f.length) - f.length);
    return out;
  }
}

interface AiCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown>;
  upstream: FakeSocket;
}

/** A mocked AI binding: each run opens a fake Flux socket, or fails as told. */
export function fakeAi(behaviour: "ok" | "throws" | "no-socket" = "ok") {
  const calls: AiCall[] = [];
  const ai: SpeechAi = {
    async run(model, inputs, options) {
      if (behaviour === "throws") throw new Error("AiError: 3036: account limit reached");
      const upstream = new FakeSocket();
      calls.push({ model, inputs: inputs as Record<string, unknown>, options: options as Record<string, unknown>, upstream });
      return { webSocket: behaviour === "no-socket" ? null : upstream };
    },
  };
  return { ai, calls };
}

/** A Worker runtime around a real meter (on memorySql) and a mocked AI, with a settable clock. */
export function setup(opts: { ai?: ReturnType<typeof fakeAi>; start?: number } = {}) {
  const sql = memorySql();
  const clock = { now: opts.start ?? Date.UTC(2026, 10, 21, 12, 0, 0) };
  const core = new MeterCore(sql, () => clock.now);
  const ai = opts.ai ?? fakeAi();
  const pending: Promise<unknown>[] = [];
  const servers: FakeSocket[] = [];
  const assets: Request[] = [];
  const rt: Runtime = {
    ai: ai.ai,
    // As over RPC: every call is asynchronous.
    meter: {
      status: async (ip) => core.status(ip),
      open: async (ip) => core.open(ip),
      add: async (session, seconds) => core.add(session, seconds),
      close: async (session) => core.close(session),
    },
    assets: { fetch: async (req) => (assets.push(req), new Response("asset", { status: 200 })) },
    pair() {
      const server = new FakeSocket();
      servers.push(server);
      return [new FakeSocket(), server];
    },
    upgrade: (client) => ({ status: 101, webSocket: client }) as unknown as Response,
    waitUntil: (p) => void pending.push(p),
  };
  /** Lets every queued report and close finish. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await Promise.all(pending);
  };
  return { rt, sql, core, clock, ai, servers, assets, settle };
}

export const ORIGIN = "https://sayfold.brightloopapps.com";

export function listenRequest({ origin = ORIGIN as string | null, ip = "203.0.113.7", upgrade = "websocket" as string | null } = {}) {
  const headers = new Headers({ "cf-connecting-ip": ip });
  if (origin !== null) headers.set("origin", origin);
  if (upgrade !== null) headers.set("upgrade", upgrade);
  return new Request("https://sayfold.brightloopapps.com/api/listen", { headers });
}

/** A frame of `seconds` of audio, filled with a repeating byte pattern. */
export function audio(seconds: number, pattern = [1, 2, 3, 4]): Uint8Array {
  const out = new Uint8Array(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length];
  return out;
}

/** A Flux TurnInfo message, shaped like the ones the lab#109 spike recorded. */
export function flux(event: string, transcript: string, turn = 0): string {
  return JSON.stringify({
    type: "TurnInfo", request_id: "01a1f8e8-3ceb-7872-819c-fb43111fbe14", event, turn_index: turn,
    audio_window_start: 0, audio_window_end: 1.2, transcript,
    words: transcript.split(" ").filter(Boolean).map((word, i) => ({ word, confidence: 0.98, start: i * 0.3, end: i * 0.3 + 0.25 })),
    end_of_turn_confidence: event === "EndOfTurn" ? 0.91 : 0.05, sequence_id: 3,
  });
}
