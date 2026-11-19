// What went wrong with the microphone, in words a visitor can act on.

export type Problem = "denied" | "no-mic" | "busy" | "other" | "insecure" | "browser";

/** The kind of problem behind a getUserMedia rejection. */
export function micProblem(e: unknown): Problem {
  const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) return "denied";
  if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(name)) return "no-mic";
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(name)) return "busy";
  return "other";
}

/** What the page needs from the browser to record and transcribe. */
export interface Support {
  isSecureContext: boolean;
  getUserMedia: boolean;
  AudioContext: boolean;
  AudioWorklet: boolean;
  Worker: boolean;
  WebAssembly: boolean;
}

/** Why this browser can't record here, or null when it can. */
export function unsupported(s: Support): "insecure" | "browser" | null {
  if (!s.isSecureContext) return "insecure";
  return s.getUserMedia && s.AudioContext && s.AudioWorklet && s.Worker && s.WebAssembly ? null : "browser";
}

export const MESSAGES: Record<Problem, { title: string; body: string }> = {
  denied: {
    title: "Sayfold can't use your microphone",
    body: "Your browser said no to the microphone. Allow it for this site (usually in the address bar or site settings), then try again.",
  },
  "no-mic": {
    title: "No microphone found",
    body: "This device doesn't seem to have a microphone. Plug one in or connect a headset, then try again.",
  },
  busy: {
    title: "The microphone is busy",
    body: "Another app or tab may be using it. Close that, then try again.",
  },
  other: {
    title: "Recording didn't start",
    body: "Something stopped the microphone from starting. Try again, or reload the page.",
  },
  insecure: {
    title: "Recording needs a secure page",
    body: "Browsers only share the microphone on https pages. Open Sayfold at its https address to record.",
  },
  browser: {
    title: "This browser can't record here",
    body: "Sayfold needs a microphone and a recent browser to turn speech into text. Try a current Chrome, Edge, Firefox or Safari.",
  },
};
