// Sayfold's usage events: the only ones it may send (lab SAFETY.md, "Usage events", lab#71), following
// the lab-wide convention: `$pageview`, then `play_started` when a recording starts and `play_finished`
// when its transcript is ready to review. The finish carries only how long the recording was, in
// buckets, and which backend turned it into text. `idea_sent` says an idea went to GitHub as an issue,
// and nothing else: never the repo, the token, the labels, or whether a token is remembered. Nothing
// anyone said or typed is ever sent: no audio, transcript, title, word counts or anything else taken from them.
// Adding an event or value here is a normal commit; anything new in kind needs Erik.
import type { AllowList, Props } from "./analytics.ts";

export const PROJECT = "sayfold";

export type Backend = "webgpu" | "wasm";

/** Lower bounds in seconds; the labels use the hub's bucket format (guard.ts `bucket`). */
const EDGES = [0, 10, 30, 60, 120] as const;
const SECONDS = ["0-9", "10-29", "30-59", "60-119", "120+"];

export const EVENTS = {
  $pageview: {},
  play_started: {},
  play_finished: { seconds_bucket: SECONDS, backend: ["webgpu", "wasm"] },
  idea_sent: {},
} satisfies AllowList;

export function secondsBucket(seconds: number): string {
  const s = Number.isFinite(seconds) ? seconds : 0;
  const i = EDGES.findLastIndex((e) => s >= e);
  return SECONDS[Math.max(0, i)]!;
}

/** One play_started per recording, and one play_finished when that recording's transcript is ready. `send` may throw. */
export function playEvents(send: (name: string, props: Props) => void) {
  let open = false;
  const safe = (name: string, props: Props) => {
    try { send(name, props); } catch {}
  };
  return {
    started() {
      open = true;
      safe("play_started", {});
    },
    finished(seconds: number, backend: Backend) {
      if (!open) return;
      open = false;
      safe("play_finished", { seconds_bucket: secondsBucket(seconds), backend });
    },
    /** The recording failed or held nothing: no finish for it. */
    abandoned() {
      open = false;
    },
  };
}
