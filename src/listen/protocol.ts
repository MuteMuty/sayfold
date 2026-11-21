// What the page and Sayfold's Worker say to each other over the live-dictation WebSocket (lab#109).
// The page opens LISTEN_PATH, sends the microphone as binary frames of 16 kHz, 16-bit, mono PCM
// (little-endian), and sends { type: "stop" } when the speaker is done. The Worker answers with the
// running text. A "fallback" message means the server can't take this recording (or the rest of it):
// the socket then closes cleanly and the page carries on with the in-browser model.

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
 * - `cap`: the day's speech allowance is used up (it comes back at midnight UTC);
 * - `visitor-limit`: this visitor's minutes for the day are used up;
 * - `busy`: this visitor already has a recording open;
 * - `session-limit`: the recording reached the longest one the server takes;
 * - `error`: the speech service failed or refused.
 */
export type FallbackReason = "cap" | "visitor-limit" | "busy" | "session-limit" | "error";

export type ClientMessage = { type: "stop" };

export type ServerMessage =
  /** The text of the turn being spoken, so far. Each update replaces the last one for that turn. */
  | { type: "update"; turn: number; text: string }
  /** The turn is finished: its final text. The next turn starts with a higher number. */
  | { type: "end-of-turn"; turn: number; text: string }
  | { type: "fallback"; reason: FallbackReason };

/** A text frame from the page, or null when it isn't one the protocol knows. */
export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const m: unknown = JSON.parse(data);
    return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "stop" ? { type: "stop" } : null;
  } catch {
    return null;
  }
}
