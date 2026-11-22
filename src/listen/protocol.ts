// What the page and Sayfold's Worker say to each other over the live-dictation WebSocket (lab#109).
// The page opens LISTEN_PATH, sends the microphone as binary frames of 16 kHz, 16-bit, mono PCM
// (little-endian), and sends { type: "stop" } when the speaker is done. The Worker answers with the
// running text. A "fallback" message means the server can't take this recording (or the rest of it):
// the socket then closes cleanly and the page carries on with the in-browser model.
//
// For the page (lab#109, slice 2):
// - The socket closing is the end of the stream, not `end-of-turn`. After `stop`, Flux may not finish its
//   last turn, so its words may arrive only as an `update`: when the socket closes, keep the latest
//   `update` of any turn that didn't end as that turn's text.
// - A `fallback` can come in the middle of a turn. Keep the text received so far (the ended turns and the
//   latest `update`), and transcribe what comes after it with the in-browser model. Its `seconds` say how
//   much of the audio the server took (none when absent): the server drains Flux's last words for that audio
//   before it sends the fallback, so the in-browser model takes the recording from there.
// - Send audio continuously, silence included: a socket with no audio for a few seconds is closed (`idle`).
//
// Spoken corrections (lab#109, slice 3): after each `end-of-turn`, the Worker sends `text`, the whole running
// text up to that turn with any spoken edit made ("no, Tuesday", "scratch that") and any spoken list as "- "
// lines. It replaces the text of that turn and every one before it. Turns after it are added as they come.

export const LISTEN_PATH = "/api/listen";
/** GET: a ListenStatus, so the page can pick the server or the in-browser model before it records. */
export const STATUS_PATH = "/api/listen/status";

export const SAMPLE_RATE = 16000;
/** 16-bit mono: two bytes a sample. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export interface ListenStatus {
  available: boolean;
}

/**
 * Why the server stopped or refused:
 * - `cap`: the day's speech allowance is used up, or the speech service said so (it comes back at midnight UTC);
 * - `visitor-limit`: this visitor's minutes for the day are used up;
 * - `busy`: this visitor already has a recording open;
 * - `session-limit`: the recording reached the longest one the server takes;
 * - `idle`: no audio came for a while (the page stopped sending);
 * - `error`: the speech service failed or refused.
 *
 * The day's allowance and the visitor's minutes count time connected as well as audio.
 */
export type FallbackReason = "cap" | "visitor-limit" | "busy" | "session-limit" | "idle" | "error";

export type ClientMessage = { type: "stop" };

export type ServerMessage =
  /** The text of the turn being spoken, so far. Each update replaces the last one for that turn. */
  | { type: "update"; turn: number; text: string }
  /** The turn is finished: its final text. The next turn starts with a higher number. */
  | { type: "end-of-turn"; turn: number; text: string }
  /** The whole running text up to and including `turn`, with spoken edits made: it replaces those turns' text. */
  | { type: "text"; turn: number; text: string }
  /** `seconds`: the audio the server took and turned into text, from the start of the stream; absent when none. */
  | { type: "fallback"; reason: FallbackReason; seconds?: number };

/** A text frame from the page, or null when it isn't one the protocol knows. */
export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const m: unknown = JSON.parse(data);
    return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "stop" ? { type: "stop" } : null;
  } catch {
    return null;
  }
}

const REASONS: readonly FallbackReason[] = ["cap", "visitor-limit", "busy", "session-limit", "idle", "error"];

/** A text frame from the server, or null when it isn't one the protocol knows. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let m: { type?: unknown; turn?: unknown; text?: unknown; reason?: unknown; seconds?: unknown };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  if ((m.type === "update" || m.type === "end-of-turn" || m.type === "text") && Number.isInteger(m.turn) && typeof m.text === "string") {
    return { type: m.type, turn: m.turn as number, text: m.text };
  }
  if (m.type === "fallback" && REASONS.includes(m.reason as FallbackReason)) {
    const reason = m.reason as FallbackReason;
    if (m.seconds === undefined) return { type: "fallback", reason };
    return typeof m.seconds === "number" && m.seconds >= 0 && Number.isFinite(m.seconds) ? { type: "fallback", reason, seconds: m.seconds } : null;
  }
  return null;
}

/** What goes between the text so far and the next turn: a new line after a list's last item, so the turn isn't
 *  taken for part of it, and otherwise a space. */
export function separator(before: string): string {
  const a = before.trimEnd();
  return a.slice(a.lastIndexOf("\n") + 1).startsWith("- ") ? "\n" : " ";
}

/** The text so far with the next turn after it, as said: what's kept when a turn has no correction. */
export function joinTurn(before: string, turn: string): string {
  const a = before.trim();
  const b = turn.trim();
  return a && b ? a + separator(a) + b : a || b;
}
