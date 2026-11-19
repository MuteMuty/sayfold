// The recording clock and its cap. A recording stops on its own at two minutes: long enough for an
// idea, short enough to transcribe in moments on a phone.

export const MAX_SECONDS = 120;

/** "0:07", "1:05", "2:00": whole seconds, rounded down, never negative. */
export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The recording has reached the cap. */
export const capReached = (samples: number, rate: number) => samples >= MAX_SECONDS * rate;

export const secondsLeft = (elapsed: number) => Math.max(0, MAX_SECONDS - elapsed);
