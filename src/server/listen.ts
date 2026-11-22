// The Worker's requests: the live-dictation WebSocket and its status (lab#109), and the page's own
// static files for everything else. A recording's audio goes from the page to Workers AI's Flux model
// and its text comes back; on each finished turn, the text so far goes to the correction model
// (src/server/correct.ts) and the whole corrected text comes back. All of it passes through memory only:
// the text so far lives in the session and is dropped when it ends. Nothing here logs, and nothing but the
// counter's numbers is stored (src/server/meter.ts).
import {
  BYTES_PER_SECOND, LISTEN_PATH, SAMPLE_RATE, STATUS_PATH, parseClientMessage,
  type FallbackReason, type ListenStatus, type ServerMessage,
} from "../listen/protocol.ts";
import {
  DRAIN_MS, FIX_WAIT_MS, IDLE_SECONDS, KEYTERMS, LOCAL_ORIGIN, MAX_FRAME_BYTES, MIP_OPT_OUT, ORIGINS, REPORT_EVERY_SECONDS,
  SESSION_MAX_SECONDS, SPEECH_MODEL,
} from "./config.ts";
import type { Added, Opened } from "./meter.ts";
import { isQuotaRefusal } from "./quota.ts";
import { correct } from "./correct.ts";

export { isQuotaRefusal };

/** The part of a Workers WebSocket used here. */
export interface Socket {
  /**
   * Set to "arraybuffer" on both ends. From compatibility date 2026-11-01 Workers' WebSockets are standard, and
   * binary frames arrive as Blobs by default, which this code would drop: the page's audio then never reached Flux.
   */
  binaryType: "blob" | "arraybuffer";
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}

/** The AI binding: Flux in its WebSocket mode (`env.AI.run(model, inputs, { websocket: true })`), and the correction model. */
export interface WorkersAi {
  run(model: string, inputs: object, options: { websocket: true }): Promise<{ webSocket?: Socket | null }>;
  run(model: string, inputs: object): Promise<unknown>;
}

/** The counter's Durable Object, as the Worker calls it. */
export interface MeterApi {
  status(ip: string): Promise<ListenStatus>;
  open(ip: string): Promise<Opened>;
  add(session: string, seconds: number, neurons?: number): Promise<Added>;
  close(session: string): Promise<void>;
  exhausted(): Promise<void>;
}

/** What the Worker needs from its runtime, so the tests can stand in for it. */
export interface Runtime {
  ai: WorkersAi;
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
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  if (!allowedOrigin(request.headers.get("origin"))) return new Response("Not allowed.", { status: 403 });
  const [client, server] = rt.pair();
  server.accept();
  server.binaryType = "arraybuffer";
  await new Session(server, rt).start(ipOf(request));
  return rt.upgrade(client);
}

/**
 * Flux's messages as the page's; "quota" when Flux reports the account's daily refusal, and "error" for any
 * other error it reports. Anything else is dropped.
 */
export function fromFlux(data: unknown): ServerMessage | "error" | "quota" | null {
  if (typeof data !== "string") return null;
  let m: { type?: unknown; event?: unknown; turn_index?: unknown; transcript?: unknown };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  if (m.type === "Error") return isQuotaRefusal(m) ? "quota" : "error";
  if (m.type !== "TurnInfo" || typeof m.turn_index !== "number" || typeof m.transcript !== "string") return null;
  return { type: m.event === "EndOfTurn" ? "end-of-turn" : "update", turn: m.turn_index, text: m.transcript };
}

/** One recording: the page's socket, Flux's socket, the time counted between them, and the text so far. */
class Session {
  private client: Socket;
  private rt: Runtime;
  private flux: Socket | null = null;
  private id = "";
  /** `draining`: waiting for Flux's last words after stop; `settling`: then for the corrections still running. */
  private state: "starting" | "open" | "draining" | "settling" | "closed" = "starting";
  /** Sent to the page as a fallback when the session ends, if set. */
  private reason: FallbackReason | null = null;
  private budgetBytes = 0;
  private budgetReason: FallbackReason = "session-limit";
  private sentBytes = 0;
  /** When Flux was opened (null until it is), the last audio came and the session ended (Date.now()). */
  private openedAt: number | null = null;
  private lastAudioAt = 0;
  private endedAt: number | null = null;
  /** Seconds already sent to the counter. */
  private counted = 0;
  private reports: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** The running text with spoken edits made, in memory only, and dropped when the session ends. */
  private doc = "";
  /** Corrections asked for and not yet done, one after another in turn order. */
  private fixing = 0;
  private fixes: Promise<void> = Promise.resolve();

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
      const inputs = { encoding: "linear16", sample_rate: String(SAMPLE_RATE), keyterm: KEYTERMS, mip_opt_out: String(MIP_OPT_OUT) };
      const res = await this.rt.ai.run(SPEECH_MODEL, inputs, { websocket: true });
      this.flux = res.webSocket ?? null;
    } catch (error) {
      // Workers AI refused or failed (a retired model, a busy moment): this recording falls back. When it's
      // the account's allowance for the day, the rest of the day does, without asking Workers AI again.
      if (isQuotaRefusal(error)) return this.quota();
    }
    if (!this.flux) return this.end("error");
    const flux = this.flux;
    flux.accept();
    flux.binaryType = "arraybuffer";
    flux.addEventListener("message", (e) => this.fromFlux(e.data));
    flux.addEventListener("close", () => (this.state === "draining" || this.state === "settling" ? this.settle() : this.end("error")));
    flux.addEventListener("error", () => this.end("error"));
    this.client.addEventListener("message", (e) => this.fromClient(e.data));
    this.client.addEventListener("close", () => this.end());
    this.client.addEventListener("error", () => this.end());
    this.state = "open";
    this.openedAt = this.lastAudioAt = Date.now();
    // Time connected counts as audio does, so the session also ends when its seconds run out, audio or not.
    this.timer = setTimeout(() => this.finish(this.budgetReason), opened.seconds * 1000);
    this.ticker = setInterval(() => this.tick(), REPORT_EVERY_SECONDS * 1000);
  }

  /** The seconds this recording has used: its audio, or its time connected, whichever is more. */
  private used(): number {
    const connected = this.openedAt === null ? 0 : ((this.endedAt ?? Date.now()) - this.openedAt) / 1000;
    return Math.max(this.sentBytes / BYTES_PER_SECOND, connected);
  }

  /** Every second: close a recording that has gone quiet, and report the time connected. */
  private tick(): void {
    if (this.state !== "open") return;
    if (Date.now() - this.lastAudioAt >= IDLE_SECONDS * 1000) return this.finish("idle");
    this.count();
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
    // Whole 16-bit samples only: an odd last byte is dropped, never sent on or split across frames.
    const room = this.budgetBytes - this.sentBytes;
    const length = Math.min(bytes.length, room) & ~1;
    if (length === 0) return; // An empty frame isn't audio.
    try {
      this.flux!.send(length === bytes.length ? bytes : bytes.subarray(0, length));
    } catch {
      return this.end("error");
    }
    this.sentBytes += length;
    this.lastAudioAt = Date.now();
    this.count();
    if (this.sentBytes >= this.budgetBytes) this.finish(this.budgetReason);
  }

  private fromFlux(data: unknown): void {
    if (this.state === "closed") return;
    const m = fromFlux(data);
    if (m === "error") return this.end("error");
    if (m === "quota") return this.rt.waitUntil(this.quota());
    if (!m) return;
    this.send(m);
    if (m.type === "end-of-turn") this.fix(m.turn, m.text);
  }

  private get closed(): boolean {
    return this.state === "closed";
  }

  private send(m: ServerMessage): void {
    try {
      this.client.send(JSON.stringify(m));
    } catch {
      this.end(); // The page has gone.
    }
  }

  /**
   * Asks the correction model for the whole text with the finished turn applied, after the corrections before it,
   * and sends it to the page. When it fails, is slow or writes junk, the turn's plain text is kept instead. Its
   * neurons count toward the day's cap; Workers AI's daily refusal closes the day, as Flux's does.
   */
  private fix(turn: number, said: string): void {
    if (!said.trim()) return;
    this.fixing++;
    this.fixes = this.fixes
      .then(async () => {
        if (this.closed) return;
        const r = await correct(this.rt.ai, this.doc, said);
        if (r.quota) return this.closed ? undefined : this.rt.waitUntil(this.quota());
        // Counted even when the page has gone meanwhile: the model did the work.
        if (r.neurons > 0) this.spend(r.neurons);
        if (this.closed) return;
        this.doc = r.text;
        this.send({ type: "text", turn, text: r.text });
      })
      .finally(() => {
        this.fixing--;
        if (this.state === "settling" && this.fixing === 0) this.end();
      });
  }

  /** Counts the correction model's neurons, and stops the session when the counter says so. */
  private spend(neurons: number): void {
    this.reports = this.reports.then(async () => {
      let added: Added;
      try {
        added = await this.rt.meter.add(this.id, 0, neurons);
      } catch {
        added = { ok: false, reason: "error" };
      }
      if (!added.ok) this.finish(added.reason);
    });
  }

  /** Workers AI refused for the day: this recording falls back, and so does the rest of the UTC day. */
  private async quota(): Promise<void> {
    this.end("cap");
    await this.rt.meter.exhausted().catch(() => {});
  }

  /** Reports to the counter a second at a time, and stops the session when the counter says so. */
  private count(): void {
    if (this.used() - this.counted >= REPORT_EVERY_SECONDS) this.report();
  }

  private report(): Promise<void> {
    const seconds = this.used() - this.counted;
    this.counted += seconds;
    this.reports = this.reports.then(async () => {
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
    this.timer = setTimeout(() => this.settle(), DRAIN_MS);
  }

  /**
   * Flux has sent its last words (or had DRAIN_MS to): ends once the corrections still running are done, so the
   * page gets the corrected text before the close, but waits for them at most FIX_WAIT_MS.
   */
  private settle(): void {
    if (this.state === "closed" || this.state === "settling") return;
    if (this.fixing === 0) return this.end();
    this.state = "settling";
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), FIX_WAIT_MS);
  }

  /** Closes both sockets now, tells the page why if there's a reason, and frees the visitor's session. */
  private end(reason: FallbackReason | null = this.reason, code = 1000, why = reason ? "fallback" : "done"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.endedAt = Date.now();
    this.doc = "";
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.ticker !== null) clearInterval(this.ticker);
    try {
      // With the seconds of audio taken, if any: the page turns what came after them into text itself.
      const seconds = this.sentBytes / BYTES_PER_SECOND;
      if (reason) this.client.send(JSON.stringify({ type: "fallback", reason, ...(seconds > 0 && { seconds }) } satisfies ServerMessage));
      this.client.close(code, why);
    } catch {
      // The page has gone already.
    }
    try {
      this.flux?.close(1000, "done");
    } catch {
      // So has Flux.
    }
    // After any correction still running has counted its neurons.
    if (this.id) this.rt.waitUntil(this.fixes.then(() => this.report()).then(() => this.rt.meter.close(this.id)).catch(() => {}));
  }
}
