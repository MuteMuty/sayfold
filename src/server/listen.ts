// The Worker's requests: the live-dictation WebSocket and its status (lab#109), and the page's own
// static files for everything else. A recording's audio goes from the page to Workers AI's Flux model
// and its text comes back; both pass through memory only. Nothing here logs, and nothing but the
// counter's numbers is stored (src/server/meter.ts).
import {
  BYTES_PER_SECOND, LISTEN_PATH, SAMPLE_RATE, STATUS_PATH, parseClientMessage,
  type FallbackReason, type ListenStatus, type ServerMessage,
} from "../listen/protocol.ts";
import { DRAIN_MS, KEYTERMS, LOCAL_ORIGIN, MAX_FRAME_BYTES, ORIGINS, REPORT_EVERY_SECONDS, SESSION_MAX_SECONDS, SPEECH_MODEL } from "./config.ts";
import type { Added, Opened } from "./meter.ts";

/** The part of a Workers WebSocket used here. */
export interface Socket {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}

/** The AI binding's WebSocket mode (`env.AI.run(model, inputs, { websocket: true })`). */
export interface SpeechAi {
  run(model: string, inputs: object, options: { websocket: true }): Promise<{ webSocket?: Socket | null }>;
}

/** The counter's Durable Object, as the Worker calls it. */
export interface MeterApi {
  status(ip: string): Promise<ListenStatus>;
  open(ip: string): Promise<Opened>;
  add(session: string, seconds: number): Promise<Added>;
  close(session: string): Promise<void>;
}

/** What the Worker needs from its runtime, so the tests can stand in for it. */
export interface Runtime {
  ai: SpeechAi;
  meter: MeterApi;
  assets: { fetch(request: Request): Promise<Response> };
  /** A new WebSocketPair: the page's end and the Worker's end. */
  pair(): [client: Socket, server: Socket];
  /** The 101 response that hands the page its end. */
  upgrade(client: Socket): Response;
  waitUntil(promise: Promise<unknown>): void;
}

export async function handle(request: Request, rt: Runtime): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === STATUS_PATH) return status(request, rt);
  if (pathname === LISTEN_PATH) return listen(request, rt);
  return rt.assets.fetch(request);
}

const ipOf = (request: Request) => request.headers.get("cf-connecting-ip") ?? "";

export const allowedOrigin = (origin: string | null): boolean => origin !== null && (ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin));

async function status(request: Request, rt: Runtime): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  let body: ListenStatus;
  try {
    body = await rt.meter.status(ipOf(request));
  } catch {
    body = { available: false };
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

async function listen(request: Request, rt: Runtime): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  if (!allowedOrigin(request.headers.get("origin"))) return new Response("Not allowed.", { status: 403 });
  const [client, server] = rt.pair();
  server.accept();
  await new Session(server, rt).start(ipOf(request));
  return rt.upgrade(client);
}

/** Flux's messages as the page's, or "error" when Flux reports one. Anything else is dropped. */
export function fromFlux(data: unknown): ServerMessage | "error" | null {
  if (typeof data !== "string") return null;
  let m: { type?: unknown; event?: unknown; turn_index?: unknown; transcript?: unknown };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  if (m.type === "Error") return "error";
  if (m.type !== "TurnInfo" || typeof m.turn_index !== "number" || typeof m.transcript !== "string") return null;
  return { type: m.event === "EndOfTurn" ? "end-of-turn" : "update", turn: m.turn_index, text: m.transcript };
}

/** One recording: the page's socket, Flux's socket, and the audio counted between them. */
class Session {
  private client: Socket;
  private rt: Runtime;
  private flux: Socket | null = null;
  private id = "";
  private state: "starting" | "open" | "draining" | "closed" = "starting";
  /** Sent to the page as a fallback when the session ends, if set. */
  private reason: FallbackReason | null = null;
  private budgetBytes = 0;
  private budgetReason: FallbackReason = "session-limit";
  private sentBytes = 0;
  private unreported = 0;
  private reports: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(client: Socket, rt: Runtime) {
    this.client = client;
    this.rt = rt;
  }

  async start(ip: string): Promise<void> {
    let opened: Opened;
    try {
      opened = await this.rt.meter.open(ip);
    } catch {
      return this.end("error");
    }
    if (!opened.ok) return this.end(opened.reason);
    this.id = opened.session;
    this.budgetBytes = Math.floor(opened.seconds * SAMPLE_RATE) * 2;
    if (opened.seconds < SESSION_MAX_SECONDS) this.budgetReason = "visitor-limit";

    try {
      const res = await this.rt.ai.run(SPEECH_MODEL, { encoding: "linear16", sample_rate: String(SAMPLE_RATE), keyterm: KEYTERMS }, { websocket: true });
      this.flux = res.webSocket ?? null;
    } catch {
      // Workers AI refused or failed (a retired model, the account's allowance): the page falls back.
    }
    if (!this.flux) return this.end("error");
    const flux = this.flux;
    flux.accept();
    flux.addEventListener("message", (e) => this.fromFlux(e.data));
    flux.addEventListener("close", () => (this.state === "draining" ? this.end() : this.end("error")));
    flux.addEventListener("error", () => this.end("error"));
    this.client.addEventListener("message", (e) => this.fromClient(e.data));
    this.client.addEventListener("close", () => this.end());
    this.client.addEventListener("error", () => this.end());
    this.state = "open";
    this.timer = setTimeout(() => this.finish("session-limit"), SESSION_MAX_SECONDS * 1000);
  }

  private fromClient(data: unknown): void {
    if (this.state !== "open") return;
    if (typeof data === "string") {
      if (parseClientMessage(data)?.type === "stop") this.finish(null);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return;
    if (bytes.length > MAX_FRAME_BYTES) return this.end(null, 1009, "frame too big");
    const room = this.budgetBytes - this.sentBytes;
    const frame = bytes.length <= room ? bytes : bytes.subarray(0, room);
    try {
      this.flux!.send(frame);
    } catch {
      return this.end("error");
    }
    this.sentBytes += frame.length;
    this.count(frame.length / BYTES_PER_SECOND);
    if (this.sentBytes >= this.budgetBytes) this.finish(this.budgetReason);
  }

  private fromFlux(data: unknown): void {
    if (this.state === "closed") return;
    const m = fromFlux(data);
    if (m === "error") return this.end("error");
    if (!m) return;
    try {
      this.client.send(JSON.stringify(m));
    } catch {
      this.end(); // The page has gone.
    }
  }

  /** Adds audio to the counter, a second at a time, and stops the session when the counter says so. */
  private count(seconds: number): void {
    this.unreported += seconds;
    if (this.unreported >= REPORT_EVERY_SECONDS) this.report();
  }

  private report(): Promise<void> {
    this.reports = this.reports.then(async () => {
      const seconds = this.unreported;
      this.unreported = 0;
      if (seconds <= 0) return;
      let added: Added;
      try {
        added = await this.rt.meter.add(this.id, seconds);
      } catch {
        added = { ok: false, reason: "error" };
      }
      if (!added.ok) this.finish(added.reason);
    });
    return this.reports;
  }

  /** Stops taking audio and lets Flux send its last words, then ends (with a fallback, if given). */
  private finish(reason: FallbackReason | null): void {
    if (this.state !== "open") return;
    this.state = "draining";
    this.reason = reason;
    if (this.timer !== null) clearTimeout(this.timer);
    try {
      this.flux!.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      return this.end(reason);
    }
    this.timer = setTimeout(() => this.end(), DRAIN_MS);
  }

  /** Closes both sockets now, tells the page why if there's a reason, and frees the visitor's session. */
  private end(reason: FallbackReason | null = this.reason, code = 1000, why = reason ? "fallback" : "done"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.timer !== null) clearTimeout(this.timer);
    try {
      if (reason) this.client.send(JSON.stringify({ type: "fallback", reason } satisfies ServerMessage));
      this.client.close(code, why);
    } catch {
      // The page has gone already.
    }
    try {
      this.flux?.close(1000, "done");
    } catch {
      // So has Flux.
    }
    if (this.id) this.rt.waitUntil(this.report().then(() => this.rt.meter.close(this.id)).catch(() => {}));
  }
}
