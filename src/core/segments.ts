// The speech model works on clips up to about 30 seconds, so a long recording is cut into parts
// of at most SEGMENT_MAX seconds. Each cut goes in the quietest moment of the last few seconds
// before the limit, so it falls in a pause between words rather than in one.

export const SEGMENT_MAX = 20;
const LOOK_BACK = 6; // seconds before the limit to search for a pause
const WINDOW = 0.1; // seconds of audio per loudness reading
const MIN_PART = 1; // seconds; a shorter last part joins the one before it

/** [start, end) sample ranges that cover the whole recording, in order. */
export function segments(samples: Float32Array, rate: number): [number, number][] {
  const parts: [number, number][] = [];
  const max = Math.floor(SEGMENT_MAX * rate);
  const win = Math.max(1, Math.round(WINDOW * rate));
  let start = 0;
  while (samples.length - start > max) {
    const searchEnd = Math.min(start + max, samples.length - Math.round(MIN_PART * rate));
    const searchStart = Math.max(start + Math.round(MIN_PART * rate), start + max - Math.round(LOOK_BACK * rate));
    let best = searchEnd;
    let quietest = Infinity;
    // Latest window first, so of equally quiet moments the one nearest the limit wins.
    for (let a = searchEnd - win; a >= searchStart; a -= Math.round(win / 2)) {
      let energy = 0;
      for (let i = a; i < a + win; i++) energy += samples[i]! * samples[i]!;
      if (energy < quietest * 0.999) {
        quietest = energy;
        best = a + Math.round(win / 2);
      }
    }
    parts.push([start, best]);
    start = best;
  }
  if (samples.length > start) parts.push([start, samples.length]);
  return parts;
}

/** Nothing at all came through (a muted or dead microphone): no point asking the model. A quiet room is not silent. */
export function silent(samples: Float32Array): boolean {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return samples.length === 0 || Math.sqrt(sum / samples.length) < 1e-4;
}
