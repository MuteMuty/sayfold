// Live text (lab#109): while the visitor talks, the page streams the microphone to Sayfold's Worker, which
// sends back the words as they're heard (src/listen/protocol.ts). Whenever the server can't be used, the
// in-browser model turns the recording into text instead, and no words are lost: the text that did come is
// kept, and only the audio after it goes to the in-browser model. With spoken corrections (slice 3), the server
// also sends the whole corrected text after each turn, which replaces the words shown for it. Nothing here is stored.
import {
  LISTEN_PATH, SAMPLE_RATE, STATUS_PATH, joinTurn, parseServerMessage, separator, type FallbackReason, type ServerMessage,
} from "../listen/protocol.ts";

/** 80 ms of audio at 16 kHz, the size of each frame sent. */
export const FRAME_SAMPLES = 1280;
/** How long the page waits for the status before recording with the in-browser model. */
export const STATUS_WAIT_MS = 3000;
/** How long the socket may take to open; the audio waits in memory meanwhile, so nothing is lost by giving up. */
export const OPEN_WAIT_MS = 5000;
/**
 * After stop, how long to wait for the server to close. It waits up to 3 s for the last words itself, then up to
 * 4 s for their correction (src/server/config.ts: DRAIN_MS, FIX_WAIT_MS).
 */
export const STOP_WAIT_MS = 8500;
/**
 * When the server can't say how much audio it took (the socket dropped, or a fallback without `seconds`), or
 * says it took more than its last words cover, the in-browser model starts this many seconds before the last
 * words came: the words lag the audio, so the last ones may stand for speech well before they arrived. What
 * both heard is shown once (joinText).
 */
export const LAG_MARGIN = 1;
/** The most words the live text's end and the in-browser model's start may share: about a second of speech. */
const MAX_OVERLAP = 6;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Whether the server takes recordings now. Anything but a clear yes in time means the in-browser model. */
export async function liveStatus(fetch: Fetch): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((done) => (timer = setTimeout(() => done(false), STATUS_WAIT_MS)));
  const ask = (async () => {
    try {
      const res = await fetch(STATUS_PATH, { cache: "no-store" });
      if (!res.ok) return false;
      const body = (await res.json()) as { available?: unknown };
      return body?.available === true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([ask, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The page's own live-text address, on ws: or wss: as the page is on http: or https:. */
export function listenUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${LISTEN_PATH}`;
}

/** Samples from -1 to 1 as 16-bit little-endian PCM. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out.setInt16(i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
  }
  return out.buffer;
}

/** One turn of the running text: `done` once it has ended, otherwise its latest update. */
export interface Part {
  text: string;
  done: boolean;
}

/**
 * The running text: the latest corrected text, then every ended turn after it, and the latest update of any turn
 * that hasn't ended, in order.
 */
export class LiveText {
  private turns = new Map<number, Part>();
  /** The whole text up to and including `turn`, with spoken edits made. */
  private fixed: { turn: number; text: string } | null = null;

  receive(m: Extract<ServerMessage, { turn: number }>): void {
    if (m.type === "text") {
      if (this.fixed && this.fixed.turn >= m.turn) return;
      this.fixed = { turn: m.turn, text: m.text.trim() };
      for (const turn of this.turns.keys()) if (turn <= m.turn) this.turns.delete(turn);
      return;
    }
    if (this.fixed && m.turn <= this.fixed.turn) return;
    if (this.turns.get(m.turn)?.done) return;
    this.turns.set(m.turn, { text: m.text.trim(), done: m.type === "end-of-turn" });
  }

  get parts(): Part[] {
    const turns = [...this.turns.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
    return [...(this.fixed ? [{ text: this.fixed.text, done: true }] : []), ...turns].filter((p) => p.text);
  }

  get text(): string {
    return this.parts.reduce((text, p) => joinTurn(text, p.text), "");
  }
}

/** A word as said: no case, no punctuation. */
const said = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * The live text and the in-browser model's text for the rest, as one. On an `exact` start, the model's audio
 * begins where the server's words end, so nothing is heard twice and every word stays ("very very good").
 * Otherwise the model started a little before the live text ended (LAG_MARGIN), so the words both heard show
 * once: the longest run of the live text's last words that the model's text starts with, after at most one
 * cut-off word where its audio began. The model starts every part with a capital, so when the live text
 * stopped mid-sentence, a plain capitalised word ("And", not "I" or "NASA") carries on in lower case.
 */
export function joinText(live: string, rest: string, exact = false): string {
  const a = live.trim();
  let b = rest.trim();
  const tail = a.split(/\s+/).map(said);
  const head = b.split(/\s+/);
  const words = head.map(said);
  find: for (let k = exact ? 0 : Math.min(MAX_OVERLAP, tail.length, words.length); k > 0; k--) {
    for (const skip of [0, 1]) {
      if (skip + k > words.length) continue;
      if (tail.slice(-k).every((w, i) => w && w === words[skip + i])) {
        b = head.slice(skip + k).join(" ");
        break find;
      }
    }
  }
  const gap = separator(a);
  if (a && gap === " " && !/[.!?…]["')\]]*$/.test(a) && /^[A-Z][a-z]/.test(b)) b = b[0]!.toLowerCase() + b.slice(1);
  return a && b ? a + gap + b : a || b;
}

const SEND = "Your words go to your own GitHub repo only when you press Send.";

/**
 * The line under the Record button: what happens to what you say. `liveOn` is whether the next recording
 * uses live text (null until the status answers); `sent`, whether audio of the recording on screen went to
 * the server. A recording that was sent, even in part, is never said to have stayed on this device.
 */
export function promiseLine(liveOn: boolean | null, sent: boolean): string {
  if (liveOn !== false) return `What you say is sent to Sayfold's server to be turned into text and edited as you ask, and isn't kept. ${SEND}`;
  if (sent) return `Part or all of this recording was sent to Sayfold's server to be turned into text, and isn't kept. Live text is off now, so the next one stays on this device. ${SEND}`;
  return `Live text is off right now, so speech is turned into text on this device and stays on it. ${SEND}`;
}

const WHY: Record<FallbackReason, string> = {
  cap: "Live text is used up for today",
  "visitor-limit": "You've used your live text for today",
  busy: "Live text is already on in another tab",
  "session-limit": "Live text has reached its limit for one recording",
  idle: "Live text lost its connection",
  error: "Live text isn't working right now",
};

/**
 * What the page says when the in-browser model takes over: for the whole recording, or the rest of it. When
 * audio went to the server but the model starts from the beginning, it doesn't sound as if none was sent.
 */
export function fallbackNote(reason: FallbackReason, partial: boolean, sent: boolean): string {
  if (partial) return `${WHY[reason]}, so the rest is turned into text on this device.`;
  return `${WHY[reason]}, so it's turned into text on this device${sent ? ", from the start" : ""}.`;
}

/** The browser's WebSocket, as far as LiveSession uses it. */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * How a recording's live text ended: the text, and `from`, the second of the recording from which the
 * in-browser model takes over (null when the server heard all of it), with the reason it did. `exact`: the
 * model starts just where the server's words end, so none is heard twice (otherwise a margin earlier).
 */
export interface LiveEnd {
  text: string;
  from: number | null;
  exact: boolean;
  reason: FallbackReason | null;
}

const OPEN = 1;

/**
 * One recording's live text. Push the microphone at 16 kHz as it comes: it's sent in 80 ms frames (kept in
 * memory until the socket opens), and the words come back to `on.text`. On any fallback, `on.fallback` is
 * told at once, with how the live text ended, and nothing more is sent. finish() sends the last audio and stop, and waits for the close.
 */
export class LiveSession {
  private ws: SocketLike | null = null;
  private on: { text(parts: Part[]): void; fallback(end: LiveEnd): void };
  private live = new LiveText();
  private state: "opening" | "open" | "stopping" | "ended" = "opening";
  private stopAsked = false;
  /** Samples pushed so far; those not yet sent, as whole frames and the part of one. */
  private pushed = 0;
  private queue: ArrayBuffer[] = [];
  private partial = new Float32Array(FRAME_SAMPLES);
  private partialLength = 0;
  /** Seconds of the recording pushed when the last words came. */
  private heardTo = 0;
  private sent = false;
  private done!: (end: LiveEnd) => void;
  private readonly ended = new Promise<LiveEnd>((resolve) => (this.done = resolve));
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(open: () => SocketLike, on: LiveSession["on"]) {
    this.on = on;
    let ws: SocketLike;
    try {
      ws = open();
    } catch {
      // Told just after, so the page has the session in hand when its fallback comes.
      queueMicrotask(() => this.fallBack("error", null));
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.opened();
    ws.onmessage = (e) => this.message(e.data);
    ws.onclose = () => this.closed();
    ws.onerror = () => this.closed();
    this.timer = setTimeout(() => this.fallBack("error", null), OPEN_WAIT_MS);
  }

  /** 16 kHz mono samples, as recorded: silence too, or the server closes the socket as idle. */
  push(samples: Float32Array): void {
    if (this.state === "ended" || this.stopAsked) return;
    this.pushed += samples.length;
    for (let at = 0; at < samples.length; ) {
      const n = Math.min(FRAME_SAMPLES - this.partialLength, samples.length - at);
      this.partial.set(samples.subarray(at, at + n), this.partialLength);
      this.partialLength += n;
      at += n;
      if (this.partialLength === FRAME_SAMPLES) {
        this.queue.push(toPcm16(this.partial));
        this.partialLength = 0;
      }
    }
    this.flush();
  }

  /** Whether any of the recording's audio went to the server. */
  get sentAudio(): boolean {
    return this.sent;
  }

  /** Ends the recording: the last audio, then stop, then the server's last words and its close. */
  finish(): Promise<LiveEnd> {
    if (this.state !== "ended" && !this.stopAsked) {
      this.stopAsked = true;
      if (this.partialLength) this.queue.push(toPcm16(this.partial.subarray(0, this.partialLength)));
      this.partialLength = 0;
      if (this.state === "open") this.sendStop();
    }
    return this.ended;
  }

  private opened(): void {
    if (this.state !== "opening") return;
    this.state = "open";
    this.clearTimer();
    this.flush();
    if (this.stopAsked) this.sendStop();
  }

  private flush(): void {
    if (this.state !== "open" && this.state !== "stopping") return;
    try {
      for (const frame of this.queue) {
        this.ws!.send(frame);
        this.sent = true;
      }
      this.queue = [];
    } catch {
      this.fallBack("error", null);
    }
  }

  private sendStop(): void {
    this.flush();
    if (this.state !== "open") return;
    this.state = "stopping";
    try {
      this.ws!.send(JSON.stringify({ type: "stop" }));
    } catch {
      return this.fallBack("error", null);
    }
    this.timer = setTimeout(() => this.fallBack("error", null), STOP_WAIT_MS);
  }

  private message(data: unknown): void {
    if (this.state === "ended") return;
    const m = parseServerMessage(data);
    if (!m) return;
    if (m.type === "fallback") return this.fallBack(m.reason, m.seconds ?? null);
    this.live.receive(m);
    // A correction isn't new words: where the in-browser model would take over still follows the last words.
    if (m.type !== "text") this.heardTo = this.pushed / SAMPLE_RATE;
    this.on.text(this.live.parts);
  }

  /** The socket closed: the end of the stream after stop, otherwise a fallback. */
  private closed(): void {
    if (this.state === "ended") return;
    if (this.state === "stopping") return this.end({ text: this.live.text, from: null, exact: true, reason: null });
    this.fallBack("error", null);
  }

  /**
   * The server can't take (the rest of) this recording. The text so far stays. The in-browser model takes
   * over exactly from the audio the server took (`taken`, in seconds) when its last words came after it, as
   * they do once the server has drained Flux. Otherwise (the connection failed, the fallback didn't say, or
   * the server took audio after its last words, which may be unheard or cut mid-word) the last words may
   * stand for audio from well before they came, so it starts LAG_MARGIN before them, and joinText drops
   * what both heard.
   */
  private fallBack(reason: FallbackReason, taken: number | null): void {
    if (this.state === "ended") return;
    const exact = taken !== null && taken <= this.heardTo;
    const from = exact ? taken : Math.max(0, this.heardTo - LAG_MARGIN);
    const end: LiveEnd = { text: this.live.text, from, exact, reason };
    this.end(end);
    this.on.fallback(end);
  }

  private end(result: LiveEnd): void {
    this.state = "ended";
    this.clearTimer();
    this.queue = [];
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        if (ws.readyState <= OPEN) ws.close(1000);
      } catch {
        // Already closing.
      }
    }
    this.done(result);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
